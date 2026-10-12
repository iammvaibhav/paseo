// Running things on fleet hosts, logging, and the parallel job runner.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Host } from "./inventory.ts";

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export class Log {
  readonly file: string;
  readonly echo: boolean;

  constructor(file: string, echo: boolean) {
    this.file = file;
    this.echo = echo;
  }

  line(message: string): void {
    this.raw(`[${new Date().toTimeString().slice(0, 8)}] ${message}\n`);
  }

  raw(chunk: string): void {
    appendFileSync(this.file, chunk);
    if (this.echo) process.stdout.write(chunk);
  }
}

/** Spawn, stream stdout+stderr into `log`, resolve with stdout on exit 0. */
function collect(
  command: string,
  args: string[],
  log: Log,
  label: string,
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    log.raw(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => log.raw(chunk.toString()));
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`${label} exited ${code}`));
  });
  child.stdin.end(input ?? "");
  return promise;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ScriptOptions {
  log: Log;
  /** Exported before the script runs; travels over ssh stdin, never argv. */
  env?: Record<string, string>;
  args?: string[];
  /** Run inside this directory on the host (e.g. "$HOME/paseo"). */
  cwd?: string;
  /** Data for the script's stdin. */
  input?: string;
}

/**
 * Run a bash script on `host` (locally when it is this machine). The script is
 * written to a temp file on the host first so nothing inside can swallow the
 * rest of it from stdin. nvm's node is on PATH; ~/.local/bin is appended (not
 * prepended: some hosts keep a stray node there). Resolves with stdout.
 */
export function runScript(
  host: Host,
  self: string,
  script: string,
  options: ScriptOptions,
): Promise<string> {
  const exports = Object.entries(options.env ?? {})
    .map(([key, value]) => `export ${key}=${quote(value)}`)
    .join("\n");
  const body = [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && nvm use --silent 22 >/dev/null 2>&1',
    'export PATH="$PATH:$HOME/.local/bin"',
    "set -euo pipefail",
    exports,
    options.cwd ? `cd ${options.cwd}` : "",
    script,
  ].join("\n");
  const marker = `__PASEO_${Math.random().toString(36).slice(2)}__`;
  const args = (options.args ?? []).map(quote).join(" ");
  const launcher =
    `f="$(mktemp)"; d="$(mktemp)"; trap 'rm -f "$f" "$d"' EXIT\n` +
    `cat >"$f" <<'${marker}'\n${body}\n${marker}\n` +
    `cat >"$d" <<'${marker}D'\n${options.input ?? ""}\n${marker}D\n` +
    `bash "$f" ${args} <"$d"\n`;
  const [command, spawnArgs]: [string, string[]] =
    host.name === self ? ["bash", ["-s"]] : ["ssh", [...SSH_OPTS, host.ssh, "bash -s"]];
  return collect(command, spawnArgs, options.log, `${host.name}: script`, launcher);
}

/** A local shell command that runs `command` on `host` (for pipelines). */
export function hostCommand(host: Host, self: string, command: string): string {
  return host.name === self
    ? `(${command})`
    : `ssh ${SSH_OPTS.join(" ")} ${host.ssh} ${quote(command)}`;
}

export function runLocal(
  command: string,
  log: Log,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return collect("bash", ["-c", `set -euo pipefail; ${command}`], log, "command", undefined, env);
}

export interface Job {
  name: string;
  after?: string[];
  run: (log: Log) => Promise<void>;
}

/**
 * Run jobs in parallel, each as soon as its `after` jobs finished. A failed
 * job skips its dependents. Each job logs to <runDir>/job-<name>.log; the main
 * log gets one start and one ✓/✗ line per job (the MacBook redeploy watch
 * parses those for job "macbook").
 */
export async function runJobs(jobs: Job[], main: Log, runDir: string): Promise<string[]> {
  const done = new Map<string, Promise<boolean>>();
  const failed: string[] = [];
  const finished = new Set<string>();
  const start = (job: Job): Promise<boolean> => {
    const existing = done.get(job.name);
    if (existing) return existing;
    const promise = (async () => {
      const deps = await Promise.all(
        (job.after ?? []).map((name) => {
          const dep = jobs.find((candidate) => candidate.name === name);
          return dep ? start(dep) : Promise.resolve(true);
        }),
      );
      if (deps.includes(false)) {
        main.line(`- job '${job.name}' skipped (a job it needs failed)`);
        failed.push(job.name);
        return false;
      }
      const file = `${runDir}/job-${job.name}.log`;
      main.line(`→ job '${job.name}' (log: ${file})`);
      try {
        await job.run(new Log(file, false));
        main.line(`✓ job '${job.name}' finished`);
        return true;
      } catch (error) {
        main.line(`✗ job '${job.name}' failed: ${(error as Error).message} (see ${file})`);
        failed.push(job.name);
        return false;
      }
    })();
    void promise.then(() => finished.add(job.name));
    done.set(job.name, promise);
    return promise;
  };
  const heartbeat = setInterval(() => {
    const pending = jobs.filter((job) => !finished.has(job.name)).map((job) => job.name);
    if (pending.length > 0) main.line(`… still running: ${pending.join(", ")}`);
  }, 120_000);
  await Promise.all(jobs.map(start));
  clearInterval(heartbeat);
  return failed;
}
