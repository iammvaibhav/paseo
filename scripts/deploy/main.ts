// Paseo fleet deploy. Entry point: ./scripts/deploy.sh (see usage below).
//
// Hosts come from the inventory (inventory.ts). Each run ships only what
// changed since a host's last deploy (plan.ts): a UI-only commit rebuilds the
// desktop app and Vercel and restarts no daemon. Host-side work runs from
// scripts in scripts/deploy/host/, piped over ssh (shell.ts).
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Host, Service } from "./inventory.ts";
import { daemonHostnames, loadInventory, passwordVar, peersFor, selfHost } from "./inventory.ts";
import type { Component, HostPlan, HostState } from "./plan.ts";
import { COMPONENT_PATHS, describePlan, makePlan } from "./plan.ts";
import type { Job } from "./shell.ts";
import { Log, hostCommand, runJobs, runLocal, runScript } from "./shell.ts";

const USAGE = `Usage: ./scripts/deploy.sh [desktop] [options]

  (no argument)     deploy what changed since each host's last deploy, to every host
  desktop           only build + install the MacBook app

Options:
  --hosts a,b       only these inventory hosts
  --force           redeploy unchanged parts too
  --dry-run         print the plan; change nothing (no commit, no push)
  --commit "msg"    commit the dirty tree with this subject first
  --merge-upstream  also merge upstream/main before pushing
  --foreground      stay attached (default: detach; follow ~/.paseo/deploy-logs/latest.log)

Inventory: ~/.paseo/fleet-hosts.json   Secrets: ~/.paseo/deploy.env (chmod 600)`;

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOST_SCRIPTS = path.join(ROOT, "scripts", "deploy", "host");
const BRANCH = "vaibhav/customizations";
const PASEO_HOME = path.join(homedir(), ".paseo");
const LOG_ROOT = path.join(PASEO_HOME, "deploy-logs");
const LOCK_FILE = path.join(PASEO_HOME, "deploy.lock");
const DEPLOY_ENV = path.join(PASEO_HOME, "deploy.env");
const VERCEL_STATE = path.join(PASEO_HOME, "deploy-vercel");
/** Builders' checkouts, relative to the remote $HOME. */
const REMOTE_REPO = "$HOME/paseo";

interface Options {
  mode: "all" | "desktop";
  hosts: string[];
  force: boolean;
  dryRun: boolean;
  commit: string;
  mergeUpstream: boolean;
  foreground: boolean;
  child: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: "all",
    hosts: [],
    force: false,
    dryRun: false,
    commit: "",
    mergeUpstream: false,
    foreground: false,
    child: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "desktop") options.mode = "desktop";
    else if (arg === "--hosts") options.hosts = value().split(",").filter(Boolean);
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--commit") options.commit = value();
    else if (arg === "--merge-upstream") options.mergeUpstream = true;
    else if (arg === "--foreground") options.foreground = true;
    else if (arg === "--child") options.child = value();
    else if (arg === "-h" || arg === "--help" || arg === "help") {
      console.log(USAGE);
      process.exit(0);
    } else die(`unknown argument "${arg}"\n\n${USAGE}`);
  }
  return options;
}

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

/**
 * KEY=value lines from ~/.paseo/deploy.env (the existing environment wins),
 * and ~/.local/bin on PATH: omp, gh and cloudflared live there, and shells
 * spawned by agents, timers and flotilla often lack it.
 */
function loadDeployEnv(): void {
  const localBin = path.join(homedir(), ".local", "bin");
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(localBin)) {
    process.env.PATH = `${process.env.PATH ?? ""}${path.delimiter}${localBin}`;
  }
  if (!existsSync(DEPLOY_ENV)) return;
  for (const line of readFileSync(DEPLOY_ENV, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

/**
 * Re-run in a new session so cancelling the agent tool that started deploy
 * cannot kill it halfway. The parent prints where the log is and exits.
 */
function detach(argv: string[]): never {
  const runDir = path.join(LOG_ROOT, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDir, { recursive: true });
  const out = openSync(path.join(runDir, "deploy.log"), "a");
  const child = spawn(process.execPath, [process.argv[1], ...argv, "--child", runDir], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: ROOT,
  });
  child.unref();
  console.log(`Detached deploy started pid=${child.pid}`);
  console.log(`  run dir: ${runDir}`);
  console.log(`  follow:  tail -f ${path.join(LOG_ROOT, "latest.log")}`);
  process.exit(0);
}

function takeLock(): void {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, "utf8"));
    try {
      process.kill(pid, 0);
      die(`another deploy is running (pid ${pid}); its log: ${path.join(LOG_ROOT, "latest.log")}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  process.on("exit", () => rmSync(LOCK_FILE, { force: true }));
}

function linkLatest(runDir: string): void {
  for (const [link, target] of [
    [path.join(LOG_ROOT, "latest-run"), runDir],
    [path.join(LOG_ROOT, "latest.log"), path.join(runDir, "deploy.log")],
  ]) {
    rmSync(link, { force: true });
    symlinkSync(target, link);
  }
  writeFileSync(path.join(runDir, "pid"), String(process.pid));
}

/** Commit (only with --commit), fast-forward to origin, optionally merge upstream, push. */
function syncGit(options: Options, log: Log): void {
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== BRANCH)
    die(`deploy runs from ${BRANCH}; ${ROOT} is not on it`);
  if (existsSync(path.join(ROOT, ".git", "MERGE_HEAD")))
    die(`a merge is in progress in ${ROOT}; finish it first`);
  if (git("status", "--porcelain") !== "") {
    if (!options.commit)
      die(`uncommitted changes in ${ROOT}: commit them, or pass --commit "<subject>"`);
    log.line(`committing: ${options.commit}`);
    git("add", "-A");
    execFileSync("git", ["-C", ROOT, "commit", "-m", options.commit], { stdio: "inherit" });
  }
  git("fetch", "-q", "origin", "--prune");
  if (git("rev-list", "--count", `HEAD..origin/${BRANCH}`) !== "0") {
    try {
      git("merge", "-q", "--ff-only", `origin/${BRANCH}`);
    } catch {
      die(`${BRANCH} diverged from origin/${BRANCH}; merge it, then redeploy`);
    }
  }
  if (options.mergeUpstream) {
    git("fetch", "-q", "upstream", "--prune");
    try {
      execFileSync("git", ["-C", ROOT, "merge", "--no-edit", "upstream/main"], {
        stdio: "inherit",
      });
    } catch {
      die(
        "merging upstream/main hit conflicts; the merge is left in progress: resolve, commit, redeploy",
      );
    }
  }
  log.line(`pushing ${BRANCH} to origin`);
  execFileSync("git", ["-C", ROOT, "push", "-q", "origin", BRANCH], { stdio: "inherit" });
}

/** True when a file of `component` changed between `since` and HEAD. */
function changedSince(component: Component, since: string | undefined): boolean {
  if (!since) return true;
  try {
    execFileSync("git", [
      "-C",
      ROOT,
      "diff",
      "--quiet",
      since,
      "HEAD",
      "--",
      ...COMPONENT_PATHS[component],
    ]);
    return false;
  } catch {
    return true; // differences, or a commit this checkout does not know
  }
}

/**
 * Fleet omp lockstep: every host with omp ends on this host's version. Updates
 * omp here first when the run touches omp (`update`); otherwise only reads it.
 */
function localOmpVersion(log: Log, update: boolean): string {
  if (update) {
    if (!process.env.GITHUB_TOKEN) {
      try {
        // Raises omp update's GitHub API rate limit; optional.
        process.env.GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], {
          encoding: "utf8",
        }).trim();
      } catch {
        // no gh login: unauthenticated update
      }
    }
    log.line("omp update");
    execFileSync("omp", ["update"], { stdio: ["ignore", "inherit", "inherit"] });
  }
  try {
    return execFileSync("omp", ["--version"], { encoding: "utf8" })
      .replace(/^omp\//, "")
      .trim();
  } catch {
    log.line("omp is not installed here; hosts' omp versions are not checked");
    return "";
  }
}

/** Generate daemon passwords for new targets; every host needs one for peers. */
function ensurePasswords(hosts: Host[], log: Log): void {
  for (const host of hosts) {
    const key = passwordVar(host.name);
    if (process.env[key]) continue;
    if (host.role !== "target")
      die(`${key} is not set: add ${host.name}'s daemon password to ${DEPLOY_ENV}`);
    const password = randomBytes(18).toString("base64url");
    appendFileSync(DEPLOY_ENV, `${key}=${password}\n`, { mode: 0o600 });
    process.env[key] = password;
    log.line(`generated a daemon password for ${host.name} (${key} in ${DEPLOY_ENV})`);
  }
}

async function readStates(hosts: Host[], self: string, log: Log) {
  const states: Record<string, HostState> = {};
  const reachable: string[] = [];
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const out = await runScript(
          host,
          self,
          'cat "$HOME/.paseo/deploy-state.json" 2>/dev/null || echo "{}"',
          {
            log: new Log(path.join(log.file, "..", `state-${host.name}.log`), false),
          },
        );
        states[host.name] = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as HostState;
        reachable.push(host.name);
      } catch {
        // unreachable: reported by the plan
      }
    }),
  );
  return { states, reachable };
}

interface Run {
  self: Host;
  hosts: Host[];
  head: string;
  ompTarget: string;
  states: Record<string, HostState>;
  tarballs: Map<string, string>;
  runDir: string;
  /** The kit tarball, built once per run on first use. */
  kit?: Promise<string>;
}

async function stamp(run: Run, host: Host, log: Log, values: HostState): Promise<void> {
  const state = { ...run.states[host.name], ...values };
  run.states[host.name] = state;
  await runScript(
    host,
    run.self.name,
    'mkdir -p "$HOME/.paseo" && cat > "$HOME/.paseo/deploy-state.json"',
    {
      log,
      input: JSON.stringify(state),
    },
  );
}

function hostScript(name: string): string {
  return readFileSync(path.join(HOST_SCRIPTS, name), "utf8");
}

function repoDir(run: Run, host: Host): string {
  return host.name === run.self.name ? `'${ROOT}'` : REMOTE_REPO;
}

/** Where the kit lives on every host; kit services run from here. */
const KIT_DIR = "$HOME/.local/share/paseo/kit";
/** Repo files the kit services need. Hosts without a checkout run them from the kit. */
const KIT_PATHS = [
  "scripts/code-server",
  "scripts/stall-check.mjs",
  "scripts/install-stall-cron.sh",
  "scripts/set-omp-verifier-role.mjs",
  "packages/server/resources/verifier-agent.md",
  "plugins",
];
const KIT_SERVICES = new Set<Service>(["omp", "code-server", "stall-cron"]);
/** node on any host: the packaged runtime's, else nvm's. */
const HOST_NODE =
  'NODE="$HOME/.local/share/paseo/current/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"';

/** HEAD's kit files plus a paseo-bridge .vsix (packaged here: targets have no npx). */
function buildKit(run: Run, log: Log): Promise<string> {
  run.kit ??= (async () => {
    const stage = path.join(run.runDir, "kit");
    const tarball = path.join(run.runDir, "kit.tar.gz");
    const bridge = path.join(stage, "scripts/code-server/paseo-bridge");
    log.line("building the service kit");
    await runLocal(
      `rm -rf '${stage}' && mkdir -p '${stage}'
git -C '${ROOT}' archive HEAD ${KIT_PATHS.join(" ")} | tar -x -C '${stage}'
sed -i.bak 's/"version": *"[^"]*"/"version": "0.1.'"$(date +%s)"'"/' '${bridge}/package.json' && rm '${bridge}/package.json.bak'
(cd '${bridge}' && pnpm dlx @vscode/vsce package --skip-license --no-dependencies --allow-missing-repository --out ../paseo-bridge.vsix >/dev/null)
tar -czf '${tarball}' -C '${stage}' . && rm -rf '${stage}'`,
      log,
    );
    return tarball;
  })();
  return run.kit;
}

/** Replace the host's kit with this run's. */
async function shipKit(run: Run, host: Host, log: Log): Promise<void> {
  const kit = await buildKit(run, log);
  log.line("installing the service kit");
  await runLocal(
    `cat '${kit}' | ${hostCommand(
      host,
      run.self.name,
      `set -e; k="${KIT_DIR}"; rm -rf "$k.new"; mkdir -p "$k.new"; tar -xz -C "$k.new"; rm -rf "$k"; mv "$k.new" "$k"`,
    )}`,
    log,
  );
}

/** omp update to the fleet version, in-repo plugins, verifier agent role. */
async function ompStep(run: Run, host: Host, log: Log): Promise<void> {
  log.line("omp: update, plugins, verifier role");
  const strict = host.daemon === "systemd";
  await runScript(
    host,
    run.self.name,
    `command -v omp >/dev/null || { echo "omp not installed"; exit 0; }
omp update || echo "warning: omp update failed"
v="$(omp --version | sed 's/^omp\\///' | tr -d '[:space:]')"
if [[ -n "$OMP_TARGET" && "$v" != "$OMP_TARGET" ]]; then
  echo "omp is $v, fleet is on $OMP_TARGET" >&2
  [[ "$STRICT" == 1 ]] && exit 1
fi
bash plugins/install.sh "$HOST_NAME" || echo "warning: omp plugin install failed"
${HOST_NODE}
"$NODE" scripts/set-omp-verifier-role.mjs "$(base64 < packages/server/resources/verifier-agent.md | tr -d '\\n')"`,
    {
      log,
      cwd: KIT_DIR,
      env: {
        OMP_TARGET: run.ompTarget,
        STRICT: strict ? "1" : "0",
        HOST_NAME: host.name,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      },
    },
  );
}

const SERVICE_SCRIPTS: Partial<Record<Service, string>> = {
  "code-server": 'bash scripts/code-server/install.sh "$BIND"',
  "stall-cron": `${HOST_NODE}; bash scripts/install-stall-cron.sh "$PWD" "$HOME/.paseo" "$NODE"`,
  "macbook-watch": 'bash scripts/install-macbook-redeploy-watch.sh "$PWD" "$HOME/.paseo"',
};

/** Run a service's installer from the kit (or the checkout, for the watch). */
async function serviceStep(run: Run, host: Host, service: Service, log: Log): Promise<void> {
  const script = SERVICE_SCRIPTS[service];
  if (!script) return;
  log.line(`service: ${service}`);
  await runScript(host, run.self.name, script, {
    log,
    cwd: KIT_SERVICES.has(service) ? KIT_DIR : repoDir(run, host),
    env: {
      // The desktop machine opens VS Code Web locally; every other host is
      // reached over NetBird only.
      BIND: host.daemon === "desktop" ? "127.0.0.1:8765" : `${host.address}:8765`,
      PASEO_PASSWORD: process.env[passwordVar(host.name)] ?? "",
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
    },
  });
}

/**
 * Before a host's daemon (re)starts: the kit, then omp + plugins, so resurrected
 * agents load plugins that match the new omp natives.
 */
async function prepareHost(run: Run, host: Host, plan: HostPlan, log: Log): Promise<void> {
  const usesKit = host.services.some((service) => KIT_SERVICES.has(service));
  if (!usesKit || (!plan.routine && plan.services.length === 0)) return;
  await shipKit(run, host, log);
  if (plan.routine && host.services.includes("omp")) await ompStep(run, host, log);
}

/** After the daemon: changed services, then the idempotent per-run ones. */
async function hostServices(run: Run, host: Host, plan: HostPlan, log: Log): Promise<void> {
  for (const service of plan.services) {
    if (service === "omp-proxy") continue;
    await serviceStep(run, host, service, log);
    await stamp(run, host, log, { [service]: run.head } as HostState);
  }
  if (!plan.routine) return;
  if (host.services.includes("code-server")) await codeServerSettingsStep(run, host, log);
  for (const service of ["stall-cron", "macbook-watch"] as const) {
    if (host.services.includes(service)) await serviceStep(run, host, service, log);
  }
  if (host.tunnel) {
    await runScript(host, run.self.name, hostScript("tunnel.sh"), { log, args: [host.tunnel] });
  }
}

/**
 * This host's live code-server settings → another Linux code-server host,
 * merged so the remote's own keys survive. Restarts code-server only when the
 * file changes.
 */
async function codeServerSettingsStep(run: Run, host: Host, log: Log): Promise<void> {
  const source = path.join(homedir(), ".local/share/code-server/User/settings.json");
  if (host.name === run.self.name || host.daemon !== "systemd" || !existsSync(source)) return;
  const file = "$HOME/.local/share/code-server/User/settings.json";
  const current = await runScript(host, run.self.name, `cat "${file}" 2>/dev/null || echo "{}"`, {
    log,
  });
  type Json = Record<string, unknown>;
  const isObject = (value: unknown): value is Json =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // jq's `remote * local`: objects merge recursively, this host's values win.
  const merge = (base: unknown, over: unknown): unknown => {
    if (!isObject(base) || !isObject(over)) return over;
    const out: Json = { ...base };
    for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value);
    return out;
  };
  let remote: unknown = {};
  try {
    remote = JSON.parse(current);
  } catch {
    // unparseable remote settings: this host's file wins outright
  }
  const next = `${JSON.stringify(merge(remote, JSON.parse(readFileSync(source, "utf8"))), null, 2)}\n`;
  if (JSON.stringify(JSON.parse(next)) === JSON.stringify(remote)) return;
  log.line("code-server settings changed; pushing and restarting code-server");
  await runScript(
    host,
    run.self.name,
    `mkdir -p "$(dirname "${file}")" && cat > "${file}" && systemctl --user restart paseo-code-server.service`,
    { log, input: next },
  );
}

/** Build the server + web UI in the checkout and package the runtime. */
async function buildStep(run: Run, host: Host, log: Log): Promise<void> {
  log.line("build server + web UI, package runtime");
  const out = await runScript(
    host,
    run.self.name,
    `pnpm run build:server
pnpm run build:daemon-web-ui
dir="$ARTIFACT_DIR"; dir="\${dir/#\\~/$HOME}"; mkdir -p "$dir"
echo "::tarball::$(PASEO_REPO_DIR="$PWD" PASEO_ARTIFACT_DIR="$dir" node --input-type=module -)"`,
    {
      log,
      cwd: repoDir(run, host),
      env: { ARTIFACT_DIR: host.artifactDir },
      input: hostScript("package-runtime.mjs"),
    },
  );
  const tarball = /::tarball::(\S+)/.exec(out)?.[1];
  if (!tarball) throw new Error("packaging printed no tarball path");
  run.tarballs.set(host.name, tarball);
}

async function activate(
  run: Run,
  host: Host,
  mode: "install" | "activate",
  tarball: string,
  log: Log,
) {
  await runScript(host, run.self.name, hostScript("activate-runtime.sh"), {
    log,
    args: [mode, tarball],
    env: {
      PASEO_KEEP_ARTIFACT: host.role === "builder" ? "1" : "0",
      ...(host.tunnel ? { PASEO_TUNNEL_PROVIDER: host.tunnel } : {}),
      ...(host.tunnel === "cloudflared" ? { PASEO_TUNNEL_AUTOSTART: "1" } : {}),
    },
  });
}

function configPayload(run: Run, host: Host): Record<string, unknown> {
  return {
    peers: peersFor(run.hosts, host.name, process.env),
    hostnames: daemonHostnames(host),
    appendSystemPrompt: readFileSync(path.join(ROOT, "scripts", "paseo-system-prompt.md"), "utf8"),
    webUi: true,
    // Targets stay minimal: no local speech models unless voice is turned on
    // there explicitly. Builders keep whatever the daemon defaults to.
    ...(host.role === "target" ? { localSpeechDefault: false } : {}),
  };
}

async function writeConfig(
  run: Run,
  host: Host,
  payload: Record<string, unknown>,
  log: Log,
): Promise<void> {
  await runScript(
    host,
    run.self.name,
    'n="$HOME/.local/share/paseo/current/bin/node"; [ -x "$n" ] || n=node; "$n" -',
    {
      log,
      env: { PASEO_HOST_CONFIG: JSON.stringify(payload) },
      input: hostScript("host-config.cjs"),
    },
  );
}

/** Ship a builder's tarball to a target through this host, checksum-verified. */
async function ship(run: Run, builder: Host, target: Host, log: Log): Promise<string> {
  const source = run.tarballs.get(builder.name);
  if (!source) throw new Error(`no package from ${builder.name}`);
  const dest = `.paseo/artifacts/${path.basename(source)}`;
  const sha256 = (file: string) =>
    `{ sha256sum 2>/dev/null || shasum -a 256; } < ${file} | cut -d' ' -f1`;
  log.line(`shipping ${path.basename(source)} from ${builder.name}`);
  const want = (await runLocal(hostCommand(builder, run.self.name, sha256(source)), log)).trim();
  await runLocal(
    `${hostCommand(builder, run.self.name, `cat ${source}`)} | ${hostCommand(target, run.self.name, `mkdir -p ~/.paseo/artifacts && cat > ~/${dest}`)}`,
    log,
  );
  const got = (await runLocal(hostCommand(target, run.self.name, sha256(`~/${dest}`)), log)).trim();
  if (!want || want !== got) throw new Error(`checksum mismatch shipping to ${target.name}`);
  return `~/${dest}`;
}

function jobsFor(run: Run, plans: HostPlan[]): Job[] {
  const jobs: Job[] = [];
  for (const plan of plans) {
    const { host } = plan;
    const remote = host.name !== run.self.name;
    if (host.role === "builder") {
      jobs.push({
        name: host.name,
        run: async (jobLog) => {
          if (remote || plan.build) {
            await runScript(host, run.self.name, hostScript("sync-checkout.sh"), {
              log: jobLog,
              cwd: repoDir(run, host),
              env: { EXPECT: run.head, BRANCH, FETCH: remote ? "1" : "0" },
            });
          }
          await prepareHost(run, host, plan, jobLog);
          if (plan.build) await buildStep(run, host, jobLog);
          if (plan.daemon && host.daemon === "systemd") {
            await activate(run, host, "activate", run.tarballs.get(host.name) ?? "", jobLog);
            await stamp(run, host, jobLog, { daemon: run.head });
          }
          await hostServices(run, host, plan, jobLog);
          if (plan.app) {
            await runScript(host, run.self.name, hostScript("desktop-app.sh"), {
              log: jobLog,
              cwd: repoDir(run, host),
            });
            await stamp(run, host, jobLog, { app: run.head });
          }
          if (plan.daemon && host.daemon === "desktop") {
            await runScript(host, run.self.name, hostScript("desktop-daemon.sh"), {
              log: jobLog,
              cwd: repoDir(run, host),
            });
            await stamp(run, host, jobLog, { daemon: run.head });
          }
        },
      });
      continue;
    }
    const builder = run.hosts.find((candidate) => candidate.name === host.buildFrom) as Host;
    jobs.push({
      name: host.name,
      after: plan.daemon ? [builder.name] : [],
      run: async (jobLog) => {
        await prepareHost(run, host, plan, jobLog);
        if (plan.daemon) {
          const tarball = await ship(run, builder, host, jobLog);
          await activate(run, host, "install", tarball, jobLog);
          // Before (re)start: listen on the inventory address (a moved host
          // binds its new IP), and a new host's password and fleet config.
          const password = process.env[passwordVar(host.name)] ?? "";
          await runScript(
            host,
            run.self.name,
            'umask 077; mkdir -p ~/.paseo; touch ~/.paseo/deploy.env; { grep -v "^PASEO_PASSWORD=" ~/.paseo/deploy.env || true; echo "PASEO_PASSWORD=$PW"; } > ~/.paseo/deploy.env.tmp && mv ~/.paseo/deploy.env.tmp ~/.paseo/deploy.env',
            { log: jobLog, env: { PW: password } },
          );
          await writeConfig(
            run,
            host,
            {
              ...configPayload(run, host),
              listen: `${host.address}:${host.port}`,
              initPassword: password,
            },
            jobLog,
          );
          await activate(run, host, "activate", tarball, jobLog);
          await stamp(run, host, jobLog, { daemon: run.head, address: host.address });
        }
        await hostServices(run, host, plan, jobLog);
        if (plan.services.includes("omp-proxy") && run.self.platform !== "linux-arm64") {
          jobLog.line("omp services skipped: omp-proxy builds only on a linux-arm64 deploy host");
        } else if (plan.services.includes("omp-proxy")) {
          jobLog.line("omp services (auth broker, proxy, refresher)");
          await runLocal(`bash ${path.join(ROOT, "scripts/omp-proxy/deploy-prod.sh")}`, jobLog, {
            ...process.env,
            OMP_TARGET_VERSION: run.ompTarget,
            PASEO_PROD_HOST: host.ssh,
          });
          await stamp(run, host, jobLog, { "omp-proxy": run.head, "omp-proxy-omp": run.ompTarget });
        }
      },
    });
  }
  return jobs;
}

/**
 * Central config (`~/.paseo/mission-control/central-config.json`) is per host and
 * nothing replicates it, so the deploy host's copy is the fleet's source: a host
 * that was offline when it changed (macbook kept a dead itsaplan URL for days)
 * catches up on the next config sync. Written atomically; contents never logged.
 */
async function syncCentralConfig(run: Run, host: Host, log: Log): Promise<void> {
  const src = path.join(PASEO_HOME, "mission-control", "central-config.json");
  if (host.name === run.self.name || !existsSync(src)) return;
  const content = readFileSync(src, "utf8");
  JSON.parse(content); // never ship a corrupt file
  const file = "$HOME/.paseo/mission-control/central-config.json";
  await runScript(
    host,
    run.self.name,
    `umask 077; mkdir -p "$(dirname "${file}")" && cat > "${file}.tmp-$$" && mv "${file}.tmp-$$" "${file}"`,
    { log, input: content },
  );
}

/** Peers + system prompt + web UI on every reachable daemon, then reload. */
async function syncConfig(run: Run, reachable: string[], log: Log): Promise<string[]> {
  const failed: string[] = [];
  for (const host of run.hosts.filter((candidate) => reachable.includes(candidate.name))) {
    try {
      const configLog = new Log(path.join(log.file, "..", `config-${host.name}.log`), false);
      await writeConfig(run, host, configPayload(run, host), configLog);
      await syncCentralConfig(run, host, configLog);
      await runScript(
        host,
        run.self.name,
        `[ -x "$HOME/.local/bin/paseo" ] || { echo "no daemon installed"; exit 0; }
set -a; [ -f "$HOME/.paseo/deploy.env" ] && . "$HOME/.paseo/deploy.env"; set +a
"$HOME/.local/bin/paseo" daemon reload --home "$HOME/.paseo"`,
        { log: configLog },
      );
      log.line(`  ${host.name}: config written, daemon reloaded`);
    } catch (error) {
      log.line(`  ${host.name}: config sync FAILED (${(error as Error).message})`);
      failed.push(`config:${host.name}`);
    }
  }
  return failed;
}

/** Publish the web export this host's build step just made (HEAD) to Vercel. */
function vercelJob(run: Run, runDir: string): Job {
  return {
    name: "vercel",
    after: [run.self.name],
    run: async (log) => {
      const staging = path.join(runDir, "vercel");
      await runLocal(
        `mkdir -p '${staging}' && cp -a '${ROOT}/packages/app/dist/.' '${staging}/'
cp '${ROOT}/packages/app/vercel.json' '${staging}/vercel.json'
cd '${staging}' && pnpm dlx vercel@latest link --yes --project paseo-web >/dev/null && pnpm dlx vercel@latest deploy --prod --yes --archive=tgz`,
        log,
      );
      rmSync(staging, { recursive: true, force: true });
      writeFileSync(VERCEL_STATE, run.head);
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  if (!options.foreground && !options.child && !options.dryRun) detach(argv);

  const runDir =
    options.child || path.join(LOG_ROOT, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDir, { recursive: true });
  const log = new Log(path.join(runDir, "deploy.log"), !options.child);
  if (!options.dryRun) {
    takeLock();
    linkLatest(runDir);
  }
  loadDeployEnv();

  const hosts = loadInventory();
  const self = selfHost(hosts);
  for (const name of options.hosts) {
    if (!hosts.some((host) => host.name === name))
      die(`--hosts: "${name}" is not in the inventory`);
  }
  log.line(
    `deploy ${argv.filter((arg) => arg !== "--child" && arg !== options.child).join(" ")} from ${self.name}`,
  );

  if (!options.dryRun) syncGit(options, log);
  const head = git("rev-parse", "HEAD");
  const ompUpdate =
    options.mode === "all" &&
    !options.dryRun &&
    hosts.some(
      (host) =>
        (options.hosts.length === 0 || options.hosts.includes(host.name)) &&
        host.services.some((service) => service === "omp" || service === "omp-proxy"),
    );
  const ompTarget = localOmpVersion(log, ompUpdate);
  if (!options.dryRun) ensurePasswords(hosts, log);

  const { states, reachable } = await readStates(hosts, self.name, log);
  const vercelState = existsSync(VERCEL_STATE)
    ? readFileSync(VERCEL_STATE, "utf8").trim()
    : undefined;
  const plan = makePlan({
    hosts,
    self: self.name,
    mode: options.mode,
    selected: options.hosts,
    force: options.force,
    reachable,
    states,
    vercelState,
    vercelEnabled: Boolean(process.env.VERCEL_TOKEN),
    ompTarget,
    changed: changedSince,
  });
  log.line(`plan for ${head.slice(0, 9)}:\n${describePlan(plan).join("\n")}`);
  if (options.dryRun) return;
  if (options.mode === "desktop" && !plan.hosts.some((hostPlan) => hostPlan.app)) {
    die("desktop: the MacBook is unreachable");
  }

  const run: Run = { self, hosts, head, ompTarget, states, tarballs: new Map(), runDir };
  const jobs = jobsFor(run, plan.hosts);
  if (plan.vercel) jobs.push(vercelJob(run, runDir));
  const failed = await runJobs(jobs, log, runDir);
  if (plan.config) {
    log.line("syncing peers + system prompt, reloading daemons");
    failed.push(...(await syncConfig(run, reachable, log)));
  }

  if (plan.unreachable.length > 0)
    log.line(`unreachable, not deployed: ${plan.unreachable.join(", ")}`);
  if (failed.length > 0) {
    log.line(`deploy FAILED: ${failed.join(", ")} (logs in ${runDir})`);
    process.exitCode = 1;
  } else {
    log.line(`deploy complete (${head.slice(0, 9)})`);
  }
}

await main();
