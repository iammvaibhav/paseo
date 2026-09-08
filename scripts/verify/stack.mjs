#!/usr/bin/env node
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverCodeServer,
  generateRunId,
  getDevVerifyDir,
  getNodeCompileCacheDir,
  getProofDir,
  getStackArtifactsDir,
  getStackDir,
  getRunsDir,
  getVerifyProofsBaseDir,
  getVerifyRunsBaseDir,
  getWorktreeRoot,
  resolveCommanderModel,
  resolveReachableIp,
  resolveWebUiDistDir,
} from "./lib/paths.mjs";
import {
  allocatePorts,
  isPidAlive,
  isPortFree,
  killProcessGroup,
  waitForPortFree,
} from "./lib/procs.mjs";
import { spawnDaemonHost, waitForDaemonHealth } from "./lib/daemon.mjs";
import { verifyPeeringLive } from "./lib/client.mjs";

/**
 * Initialize a mock git fixture repository with one commit and origin pointing to
 * https://github.com/paseo-verify/fixture.git. This produces the canonical project key
 * "remote:github.com/paseo-verify/fixture" in Paseo without any network calls.
 */
function initFixtureRepo(runDir) {
  const fixtureDir = path.join(runDir, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  execSync("git init -b main", { cwd: fixtureDir, stdio: "ignore" });
  execSync("git config user.name verify", { cwd: fixtureDir, stdio: "ignore" });
  execSync("git config user.email verify@paseo.local", { cwd: fixtureDir, stdio: "ignore" });
  writeFileSync(path.join(fixtureDir, "README.md"), "# Fixture\n", "utf8");
  execSync("git add README.md", { cwd: fixtureDir, stdio: "ignore" });
  execSync('git commit -m "initial commit"', { cwd: fixtureDir, stdio: "ignore" });
  execSync("git remote add origin https://github.com/paseo-verify/fixture.git", {
    cwd: fixtureDir,
    stdio: "ignore",
  });
  return fixtureDir;
}

/**
 * Abort if dir sits inside a git repository. Daemon HOMES must stay outside
 * every repo so reserved Commander homes resolve to host: project keys.
 */
function assertOutsideGitRepo(dir) {
  let repoTop = null;
  try {
    repoTop = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
  throw new Error(
    `Refusing to boot verify stack: runsDir ${dir} is inside git repository ${repoTop}. ` +
      "Daemon HOMES must live outside any git repository.",
  );
}

/**
 * Read the live itsaplan connection credentials from ~/.paseo/mission-control/central-config.json (READ ONLY).
 * Never print or leak credentials to stdout.
 */
function readRealItsaplanConfig() {
  const centralPath = path.join(os.homedir(), ".paseo", "mission-control", "central-config.json");
  if (!existsSync(centralPath)) {
    return null;
  }
  try {
    const raw = readFileSync(centralPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.itsaplan === "object" && parsed.itsaplan !== null) {
      return parsed.itsaplan;
    }
  } catch {}
  return null;
}

/**
 * Clean up itsaplan resources created during a specific run:
 * 1. Webhook with this run's port
 * 2. AI agent named verify-<runId>
 * 3. Bulk-archive issues titled [<runId>] ...
 */
const ITSAPLAN_BASE_URL = "http://127.0.0.1:3000";

function itsaplanHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
}

async function resolveSharedItsaplanProject(headers) {
  try {
    const projectsRes = await fetch(`${ITSAPLAN_BASE_URL}/projects`, { headers });
    if (!projectsRes.ok) return null;
    const projects = await projectsRes.json();
    if (!Array.isArray(projects)) return null;
    return projects.find((p) => p.description === "remote:github.com/paseo-verify/fixture") || null;
  } catch {
    return null;
  }
}

async function deleteRunWebhooks(projectKey, headers, ports) {
  try {
    const webhooksRes = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/webhooks`,
      { headers },
    );
    if (!webhooksRes.ok) return;
    const webhooks = await webhooksRes.json();
    if (!Array.isArray(webhooks)) return;
    for (const webhook of webhooks) {
      const match = ports.some((p) => webhook.url && webhook.url.includes(`:${p}/`));
      if (match) {
        await fetch(`${ITSAPLAN_BASE_URL}/webhooks/${webhook.id}`, {
          method: "DELETE",
          headers,
        }).catch(() => {});
      }
    }
  } catch {}
}

async function deleteRunAgent(projectKey, headers, runId) {
  try {
    const agentsRes = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/ai-agents`,
      { headers },
    );
    if (!agentsRes.ok) return;
    const agents = await agentsRes.json();
    if (!Array.isArray(agents)) return;
    const runAgent = agents.find((a) => a.username === `verify-${runId}`);
    if (runAgent) {
      await fetch(
        `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/ai-agents/${runAgent.id}`,
        { method: "DELETE", headers },
      ).catch(() => {});
    }
  } catch {}
}

async function archiveRunIssues(projectKey, headers, runId) {
  try {
    const issuesRes = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/issues?limit=500`,
      { headers },
    );
    if (!issuesRes.ok) return;
    const issues = await issuesRes.json();
    if (!Array.isArray(issues)) return;
    const runIssueIds = issues
      .filter((issue) => issue.title && issue.title.includes(`[${runId}]`))
      .map((issue) => issue.id);
    if (runIssueIds.length > 0) {
      await fetch(
        `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/issues/bulk/archive`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ ids: runIssueIds }),
        },
      ).catch(() => {});
    }
  } catch {}
}

async function cleanupItsaplanForRun(runId, { ports = [] } = {}) {
  const realItsaplan = readRealItsaplanConfig();
  if (!realItsaplan || !realItsaplan.apiKey) {
    return;
  }
  const headers = itsaplanHeaders(realItsaplan.apiKey);
  const sharedProject = await resolveSharedItsaplanProject(headers);
  if (!sharedProject) {
    return;
  }
  const projectKey = sharedProject.key;
  await deleteRunWebhooks(projectKey, headers, ports);
  await deleteRunAgent(projectKey, headers, runId);
  await archiveRunIssues(projectKey, headers, runId);
  process.stdout.write(`Deleted itsaplan webhook and AI agent for ${runId}\n`);
}
const MOCK_AGENT_PROVIDERS = {
  providers: {
    omp: { enabled: true },
    claude: { enabled: false },
    codex: { enabled: false },
    copilot: { enabled: false },
    opencode: { enabled: false },
    pi: { enabled: false },
  },
};

async function reapVerifyAgents(projectKey, headers, liveRunIds) {
  let count = 0;
  try {
    const res = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/ai-agents`,
      { headers },
    );
    if (!res.ok) return 0;
    const agents = await res.json();
    if (!Array.isArray(agents)) return 0;
    for (const agent of agents) {
      if (!agent.username?.startsWith("verify-")) continue;
      if (liveRunIds.has(agent.username.slice("verify-".length))) continue;
      const del = await fetch(
        `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/ai-agents/${agent.id}`,
        {
          method: "DELETE",
          headers,
        },
      );
      if (del.ok) count++;
    }
  } catch {}
  return count;
}

async function reapDeadPortWebhook(webhook, headers) {
  if (!webhook.url) return false;
  try {
    const url = new URL(webhook.url);
    const port = Number(url.port);
    if (!(port > 0)) return false;
    const free = await isPortFree(port, url.hostname || "127.0.0.1");
    if (!free) return false;
    const del = await fetch(`${ITSAPLAN_BASE_URL}/webhooks/${webhook.id}`, {
      method: "DELETE",
      headers,
    });
    return del.ok;
  } catch {
    return false;
  }
}

async function reapDeadPortWebhooks(projectKey, headers) {
  let count = 0;
  try {
    const res = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/webhooks`,
      { headers },
    );
    if (!res.ok) return 0;
    const webhooks = await res.json();
    if (!Array.isArray(webhooks)) return 0;
    for (const webhook of webhooks) {
      if (await reapDeadPortWebhook(webhook, headers)) {
        count++;
      }
    }
  } catch {}
  return count;
}

async function archiveOldIssues(projectKey, headers) {
  try {
    const res = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/issues?limit=500`,
      { headers },
    );
    if (!res.ok) return 0;
    const issues = await res.json();
    if (!Array.isArray(issues)) return 0;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const oldIds = issues
      .filter((i) => i.title?.includes("[v-") && Date.parse(i.createdAt || 0) < oneDayAgo)
      .map((i) => i.id);
    if (oldIds.length === 0) return 0;
    const arch = await fetch(
      `${ITSAPLAN_BASE_URL}/projects/${encodeURIComponent(projectKey)}/issues/bulk/archive`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: oldIds }),
      },
    );
    return arch.ok ? oldIds.length : 0;
  } catch {
    return 0;
  }
}

async function sweepItsaplan(liveRunIds = new Set()) {
  const realItsaplan = readRealItsaplanConfig();
  if (!realItsaplan?.apiKey) {
    return { agentsReaped: 0, webhooksReaped: 0, issuesArchived: 0 };
  }
  const headers = itsaplanHeaders(realItsaplan.apiKey);
  const sharedProject = await resolveSharedItsaplanProject(headers);
  if (!sharedProject) {
    return { agentsReaped: 0, webhooksReaped: 0, issuesArchived: 0 };
  }
  const projectKey = sharedProject.key;
  const agentsReaped = await reapVerifyAgents(projectKey, headers, liveRunIds);
  const webhooksReaped = await reapDeadPortWebhooks(projectKey, headers);
  const issuesArchived = await archiveOldIssues(projectKey, headers);
  return { agentsReaped, webhooksReaped, issuesArchived };
}
function pruneExpiredRun(runPath, maxAgeMs) {
  try {
    const st = statSync(runPath);
    if (Date.now() - st.mtimeMs > maxAgeMs) {
      rmSync(runPath, { recursive: true, force: true });
      return 1;
    }
  } catch {}
  return 0;
}

function pruneWorktreeProofDirs(wtPath, maxAgeMs) {
  let pruned = 0;
  try {
    const runDirs = readdirSync(wtPath, { withFileTypes: true });
    for (const runEntry of runDirs) {
      if (runEntry.isDirectory()) {
        pruned += pruneExpiredRun(path.join(wtPath, runEntry.name), maxAgeMs);
      }
    }
  } catch {}
  return pruned;
}

function sweepProofDirs() {
  const baseDir = getVerifyProofsBaseDir();
  if (!existsSync(baseDir)) return 0;
  let pruned = 0;
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  try {
    const worktreeDirs = readdirSync(baseDir, { withFileTypes: true });
    for (const wtEntry of worktreeDirs) {
      if (wtEntry.isDirectory()) {
        pruned += pruneWorktreeProofDirs(path.join(baseDir, wtEntry.name), maxAgeMs);
      }
    }
  } catch {}
  return pruned;
}

function buildMockCentralConfig({
  commanderEnabled,
  commanderModel,
  itsaplanEnabled,
  realItsaplan,
  runId,
}) {
  return {
    commanderHost: commanderEnabled ? "commander" : null,
    commanderModel: commanderEnabled ? commanderModel : null,
    verifierModel: commanderEnabled ? commanderModel : null,
    mode: "auto",
    ...(itsaplanEnabled && realItsaplan
      ? {
          itsaplan: {
            baseUrl: "http://127.0.0.1:3000",
            apiKey: realItsaplan.apiKey,
            webhookSecret: realItsaplan.webhookSecret,
            humanUserId: realItsaplan.humanUserId,
            commanderUsername: `verify-${runId}`,
            ...(realItsaplan.webBaseUrl ? { webBaseUrl: realItsaplan.webBaseUrl } : {}),
          },
        }
      : {}),
  };
}

async function bootSingleCommanderHost({
  runsDir,
  listenHost,
  mockCentralConfig,
  webUiDistDir,
  worktreeRoot,
  password,
  skillsHome,
}) {
  const [port] = await allocatePorts(1, listenHost);
  const commanderHome = path.join(runsDir, "hosts", "commander");

  mkdirSync(path.join(commanderHome, "mission-control"), { recursive: true });
  writeFileSync(
    path.join(commanderHome, "config.json"),
    JSON.stringify(
      {
        peers: [],
        missionControl: { hostAlias: "commander", enabled: true },
        agents: MOCK_AGENT_PROVIDERS,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(commanderHome, "mission-control", "central-config.json"),
    JSON.stringify(mockCentralConfig, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );

  spawnDaemonHost({
    hostName: "commander",
    homeDir: commanderHome,
    port,
    webUiDistDir,
    worktreeRoot,
    password,
    skillsHome,
    listenHost,
  });

  const bootInfo = await waitForDaemonHealth({
    homeDir: commanderHome,
    expectedPort: port,
    timeoutMs: 30000,
    listenHost,
  });

  return [
    {
      name: "commander",
      role: "commander",
      home: commanderHome,
      port: bootInfo.port,
      httpUrl: bootInfo.httpUrl,
      wsUrl: bootInfo.wsUrl,
      pid: bootInfo.pid,
      logFile: bootInfo.logFile,
      bootMs: bootInfo.bootMs,
    },
  ];
}

async function bootPeeredHosts({
  runsDir,
  listenHost,
  mockCentralConfig,
  webUiDistDir,
  worktreeRoot,
  password,
  skillsHome,
}) {
  const [commanderPort, peerBPort] = await allocatePorts(2, listenHost);
  const commanderHome = path.join(runsDir, "hosts", "commander");
  const peerBHome = path.join(runsDir, "hosts", "peer-b");

  mkdirSync(path.join(commanderHome, "mission-control"), { recursive: true });
  mkdirSync(path.join(peerBHome, "mission-control"), { recursive: true });

  writeFileSync(
    path.join(commanderHome, "config.json"),
    JSON.stringify(
      {
        peers: [
          {
            name: "peer-b",
            url: `tcp://${listenHost}:${peerBPort}`,
            ...(password ? { password } : {}),
          },
        ],
        missionControl: { hostAlias: "commander", enabled: true },
        agents: MOCK_AGENT_PROVIDERS,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(commanderHome, "mission-control", "central-config.json"),
    JSON.stringify(mockCentralConfig, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );

  writeFileSync(
    path.join(peerBHome, "config.json"),
    JSON.stringify(
      {
        peers: [
          {
            name: "commander",
            url: `tcp://${listenHost}:${commanderPort}`,
            ...(password ? { password } : {}),
          },
        ],
        missionControl: { hostAlias: "peer-b", enabled: true },
        agents: MOCK_AGENT_PROVIDERS,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(peerBHome, "mission-control", "central-config.json"),
    JSON.stringify(mockCentralConfig, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );

  spawnDaemonHost({
    hostName: "commander",
    homeDir: commanderHome,
    port: commanderPort,
    webUiDistDir,
    worktreeRoot,
    password,
    skillsHome,
    listenHost,
  });

  spawnDaemonHost({
    hostName: "peer-b",
    homeDir: peerBHome,
    port: peerBPort,
    webUiDistDir,
    worktreeRoot,
    password,
    skillsHome,
    listenHost,
  });

  const [commanderBoot, peerBBoot] = await Promise.all([
    waitForDaemonHealth({
      homeDir: commanderHome,
      expectedPort: commanderPort,
      timeoutMs: 30000,
      listenHost,
    }),
    waitForDaemonHealth({
      homeDir: peerBHome,
      expectedPort: peerBPort,
      timeoutMs: 30000,
      listenHost,
    }),
  ]);

  await verifyPeeringLive({
    commanderWsUrl: commanderBoot.wsUrl,
    peerName: "peer-b",
    timeoutMs: 15000,
    password,
  });

  return [
    {
      name: "commander",
      role: "commander",
      home: commanderHome,
      port: commanderBoot.port,
      httpUrl: commanderBoot.httpUrl,
      wsUrl: commanderBoot.wsUrl,
      pid: commanderBoot.pid,
      logFile: commanderBoot.logFile,
      bootMs: commanderBoot.bootMs,
    },
    {
      name: "peer-b",
      role: "peer",
      home: peerBHome,
      port: peerBBoot.port,
      httpUrl: peerBBoot.httpUrl,
      wsUrl: peerBBoot.wsUrl,
      pid: peerBBoot.pid,
      logFile: peerBBoot.logFile,
      bootMs: peerBBoot.bootMs,
    },
  ];
}

/**
 * Warn on stderr when the shared code-server is configured but not responding. Never
 * blocks or retries; up must never wait on code-server.
 */
function warnIfCodeServerUnhealthy(codeServer, quiet) {
  if (codeServer && !codeServer.healthy && !quiet) {
    process.stderr.write(
      `Warning: code-server at ${codeServer.url} is not responding. Check 'systemctl --user status paseo-code-server.service'.\n`,
    );
  }
}

/**
 * Bring up an isolated stack (1 commander daemon, or 2 peered daemons).
 */
export async function stackUp(options = {}) {
  const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
  const runId = options.runId ?? generateRunId();
  const peer = Boolean(options.peer);
  const reachable = Boolean(options.reachable);
  const passwordEnabled = options.password !== false && !options.noPassword;
  const itsaplanEnabled = options.itsaplan !== false && !options.noItsaplan;
  const commanderEnabled = options.commander !== false && !options.noCommander;
  const codeServerEnabled = options.codeServer !== false && !options.noCodeServer;
  const quiet = Boolean(options.quiet);

  const password = passwordEnabled ? crypto.randomBytes(12).toString("hex") : null;
  const commanderModel = resolveCommanderModel();
  const reachableHost = reachable ? resolveReachableIp() : null;
  const listenHost = reachableHost || "127.0.0.1";

  const runDir = getStackDir(worktreeRoot, runId);
  const artifactsDir = getStackArtifactsDir(worktreeRoot, runId);
  const proofDir = getProofDir(worktreeRoot, runId);
  const runsDir = options.runsDir ?? getRunsDir(worktreeRoot, runId);
  const skillsHome = path.join(runsDir, "home");

  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(proofDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  mkdirSync(skillsHome, { recursive: true });
  mkdirSync(getNodeCompileCacheDir(worktreeRoot), { recursive: true });
  assertOutsideGitRepo(runsDir);

  const fixtureRepo = initFixtureRepo(runDir);

  const webUiDistDir = resolveWebUiDistDir(worktreeRoot);
  if (!webUiDistDir && !quiet) {
    process.stderr.write(
      "Warning: Web UI dist directory not found. Stack will boot, but UI-tier checks cannot run.\n",
    );
  }

  const realItsaplan = itsaplanEnabled ? readRealItsaplanConfig() : null;
  const itsaplanStackData = itsaplanEnabled
    ? {
        enabled: true,
        baseUrl: "http://127.0.0.1:3000",
        paseoProjectKey: "remote:github.com/paseo-verify/fixture",
        commanderUsername: `verify-${runId}`,
      }
    : null;

  const mockCentralConfig = buildMockCentralConfig({
    commanderEnabled,
    commanderModel,
    itsaplanEnabled,
    realItsaplan,
    runId,
  });

  const bootArgs = {
    runsDir,
    listenHost,
    mockCentralConfig,
    webUiDistDir,
    worktreeRoot,
    password,
    skillsHome,
  };

  // Probe concurrently with the daemon health wait so codeServer discovery never
  // adds to boot time; code-server is shared and per-host, never spawned here.
  const codeServerPromise = discoverCodeServer({ enabled: codeServerEnabled });

  const hosts = peer ? await bootPeeredHosts(bootArgs) : await bootSingleCommanderHost(bootArgs);
  const codeServer = await codeServerPromise;
  warnIfCodeServerUnhealthy(codeServer, quiet);

  const reachableData = reachable
    ? {
        host: reachableHost,
        urls: Object.fromEntries(hosts.map((h) => [h.name, h.httpUrl])),
      }
    : null;

  const stackData = {
    runId,
    createdAt: new Date().toISOString(),
    worktree: worktreeRoot,
    runDir,
    runsDir,
    artifactsDir,
    webUiDistDir,
    auth: password ? "password" : "none",
    password,
    commanderModel,
    commander: { enabled: commanderEnabled },
    reachable: reachableData,
    fixtureRepo,
    itsaplan: itsaplanStackData,
    codeServer,
    skillsHome,
    proofDir,
    hosts,
    peered: peer,
  };

  writeFileSync(path.join(runDir, "stack.json"), JSON.stringify(stackData, null, 2) + "\n", "utf8");

  return stackData;
}

function resolveDownTargets(devVerifyDir, target, options) {
  if (target === "--all" || options.all) {
    const entries = readdirSync(devVerifyDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== ".node-compile-cache")
      .map((e) => e.name);
  }
  if (target) {
    return [target];
  }
  throw new Error("Missing target runId or --all");
}

async function stopStackHosts(stack) {
  const runPorts = [];
  if (!Array.isArray(stack.hosts)) return runPorts;
  for (const host of stack.hosts) {
    if (host.port) {
      runPorts.push(host.port);
    }
    if (host.pid) {
      await killProcessGroup(host.pid);
    }
    if (host.port) {
      await waitForPortFree(host.port, {
        timeoutMs: 3000,
        host: stack.reachable?.host || "127.0.0.1",
      });
    }
  }
  return runPorts;
}

async function killHostPid(hostDir) {
  const pidPath = path.join(hostDir, "paseo.pid");
  if (!existsSync(pidPath)) return;
  try {
    const info = JSON.parse(readFileSync(pidPath, "utf8"));
    if (info.pid) {
      await killProcessGroup(info.pid);
    }
  } catch {}
}

async function killHostsDirPids(hostsDir) {
  if (!existsSync(hostsDir)) return;
  try {
    const hostEntries = readdirSync(hostsDir, { withFileTypes: true });
    for (const hostEntry of hostEntries) {
      if (hostEntry.isDirectory()) {
        await killHostPid(path.join(hostsDir, hostEntry.name));
      }
    }
  } catch {}
}

async function cleanSingleStack(worktreeRoot, id) {
  const runDir = getStackDir(worktreeRoot, id);
  const stackJsonPath = path.join(runDir, "stack.json");
  let runPorts = [];
  let runsDir = getRunsDir(worktreeRoot, id);

  if (existsSync(stackJsonPath)) {
    try {
      const raw = readFileSync(stackJsonPath, "utf8");
      const stack = JSON.parse(raw);
      if (typeof stack.runsDir === "string" && stack.runsDir) {
        runsDir = stack.runsDir;
      }
      runPorts = await stopStackHosts(stack);
    } catch {}
  }

  await killHostsDirPids(path.join(runsDir, "hosts"));
  await killHostsDirPids(path.join(runDir, "hosts"));

  await cleanupItsaplanForRun(id, { ports: runPorts });

  const hadState = existsSync(runsDir) || existsSync(runDir);
  if (existsSync(runsDir)) {
    rmSync(runsDir, { recursive: true, force: true });
  }
  if (existsSync(runDir)) {
    rmSync(runDir, { recursive: true, force: true });
  }
  return hadState;
}

/**
 * Tear down a stack by runId or all stacks in the worktree.
 */
export async function stackDown(target, options = {}) {
  const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
  const devVerifyDir = getDevVerifyDir(worktreeRoot);

  if (!existsSync(devVerifyDir)) {
    return { count: 0, reaped: [] };
  }

  const targets = resolveDownTargets(devVerifyDir, target, options);
  const reaped = [];

  for (const id of targets) {
    const hadState = await cleanSingleStack(worktreeRoot, id);
    if (hadState) {
      reaped.push(id);
    }
  }

  return { count: reaped.length, reaped };
}

/**
 * List active stacks.
 */
export async function stackList(options = {}) {
  const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
  const devVerifyDir = getDevVerifyDir(worktreeRoot);

  if (!existsSync(devVerifyDir)) {
    return [];
  }

  const results = [];
  const entries = readdirSync(devVerifyDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".node-compile-cache") {
      continue;
    }

    const stackJsonPath = path.join(devVerifyDir, entry.name, "stack.json");
    if (!existsSync(stackJsonPath)) {
      continue;
    }

    try {
      const stack = JSON.parse(readFileSync(stackJsonPath, "utf8"));
      const hostsInfo = (stack.hosts || []).map((h) => ({
        name: h.name,
        role: h.role,
        port: h.port,
        pid: h.pid,
        alive: isPidAlive(h.pid),
        httpUrl: h.httpUrl,
      }));

      const allAlive = hostsInfo.length > 0 && hostsInfo.every((h) => h.alive);
      const anyAlive = hostsInfo.some((h) => h.alive);
      let status = "stopped";
      if (allAlive) {
        status = "running";
      } else if (anyAlive) {
        status = "degraded";
      }

      results.push({
        runId: stack.runId,
        createdAt: stack.createdAt,
        ageMs: Date.now() - Date.parse(stack.createdAt || 0),
        peered: Boolean(stack.peered),
        password: stack.password ?? null,
        reachable: stack.reachable ?? null,
        status,
        hosts: hostsInfo,
      });
    } catch {}
  }

  return results;
}

/**
 * True when any daemon pid file under runsDir/hosts points at a live process.
 */
function runsDirHasLivePid(runsDir) {
  const hostsDir = path.join(runsDir, "hosts");
  if (!existsSync(hostsDir)) {
    return false;
  }
  try {
    for (const hostEntry of readdirSync(hostsDir, { withFileTypes: true })) {
      if (!hostEntry.isDirectory()) {
        continue;
      }
      const pidPath = path.join(hostsDir, hostEntry.name, "paseo.pid");
      if (!existsSync(pidPath)) {
        continue;
      }
      try {
        const info = JSON.parse(readFileSync(pidPath, "utf8"));
        if (info.pid && isPidAlive(info.pid)) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

/**
 * Prune ~/.paseo/verify-runs/<base>/<runId> dirs with no live stack behind them.
 * Runs for this worktree with a stack.json are owned by the reap loop above and
 * skipped here; everything else goes when no daemon pid is alive (foreign
 * basenames additionally require directory age past maxAgeMs, mirroring the
 * missing-stack.json rule for runDirs).
 */
function sweepOrphanRunsDirs(worktreeRoot, maxAgeMs) {
  const pruned = [];
  const runsRoot = getVerifyRunsBaseDir();
  if (!existsSync(runsRoot)) {
    return pruned;
  }
  const ownBase = path.basename(worktreeRoot);
  for (const baseEntry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!baseEntry.isDirectory()) {
      continue;
    }
    const baseDir = path.join(runsRoot, baseEntry.name);
    const isOwn = baseEntry.name === ownBase;
    for (const runEntry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) {
        continue;
      }
      const runsDir = path.join(baseDir, runEntry.name);
      if (isOwn && existsSync(path.join(getStackDir(worktreeRoot, runEntry.name), "stack.json"))) {
        continue;
      }
      if (runsDirHasLivePid(runsDir)) {
        continue;
      }
      try {
        const st = statSync(runsDir);
        const fresh = Date.now() - st.mtimeMs <= maxAgeMs;
        if (isOwn ? fresh && !existsSync(path.join(runsDir, "hosts")) : fresh) {
          continue;
        }
      } catch {}
      rmSync(runsDir, { recursive: true, force: true });
      pruned.push(`${baseEntry.name}/${runEntry.name}`);
    }
  }
  return pruned;
}

function shouldReapRunDir(runDir, stackJsonPath, maxAgeMs) {
  if (existsSync(stackJsonPath)) {
    try {
      const stack = JSON.parse(readFileSync(stackJsonPath, "utf8"));
      const ageMs = Date.now() - Date.parse(stack.createdAt || 0);
      const hasDeadPid = (stack.hosts || []).some((h) => !isPidAlive(h.pid));
      return ageMs > maxAgeMs || hasDeadPid;
    } catch {
      return true;
    }
  }
  try {
    const st = statSync(runDir);
    return Date.now() - st.mtimeMs > maxAgeMs;
  } catch {
    return true;
  }
}

async function reapStaleStacks(devVerifyDir, worktreeRoot, maxAgeMs) {
  const reaped = [];
  if (!existsSync(devVerifyDir)) return reaped;
  const entries = readdirSync(devVerifyDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".node-compile-cache") continue;
    const runDir = path.join(devVerifyDir, entry.name);
    const stackJsonPath = path.join(runDir, "stack.json");
    if (shouldReapRunDir(runDir, stackJsonPath, maxAgeMs)) {
      await stackDown(entry.name, { worktreeRoot, quiet: true });
      reaped.push(entry.name);
    }
  }
  return reaped;
}

function collectLiveRunIds(devVerifyDir) {
  const liveRunIds = new Set();
  if (!existsSync(devVerifyDir)) return liveRunIds;
  for (const entry of readdirSync(devVerifyDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".node-compile-cache") continue;
    try {
      const stack = JSON.parse(
        readFileSync(path.join(devVerifyDir, entry.name, "stack.json"), "utf8"),
      );
      if (
        Array.isArray(stack.hosts) &&
        stack.hosts.length > 0 &&
        stack.hosts.every((h) => isPidAlive(h.pid))
      ) {
        liveRunIds.add(stack.runId || entry.name);
      }
    } catch {}
  }
  return liveRunIds;
}

/**
 * Sweep dead or stale stacks, sweep verify-* itsaplan leftovers, and prune old proof dirs.
 */
export async function stackSweep(options = {}) {
  const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
  const olderThanMinutes = options.olderThanMinutes ?? 120;
  const maxAgeMs = olderThanMinutes * 60 * 1000;
  const devVerifyDir = getDevVerifyDir(worktreeRoot);

  const reaped = await reapStaleStacks(devVerifyDir, worktreeRoot, maxAgeMs);
  const liveRunIds = collectLiveRunIds(devVerifyDir);
  const prunedRunsDirs = sweepOrphanRunsDirs(worktreeRoot, maxAgeMs);
  const itsaplanSweepResult = await sweepItsaplan(liveRunIds);
  const prunedProofDirs = sweepProofDirs();

  return {
    count: reaped.length,
    reaped,
    itsaplan: itsaplanSweepResult,
    prunedProofDirs,
    prunedRunsDirs,
  };
}

function parseCliArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--peer") {
      args.peer = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--reachable") {
      args.reachable = true;
    } else if (arg === "--no-password") {
      args.noPassword = true;
      args.password = false;
    } else if (arg === "--no-itsaplan") {
      args.noItsaplan = true;
      args.itsaplan = false;
    } else if (arg === "--no-commander") {
      args.noCommander = true;
      args.commander = false;
    } else if (arg === "--no-code-server") {
      args.noCodeServer = true;
      args.codeServer = false;
    } else if (arg === "--run-id" && i + 1 < argv.length) {
      args.runId = argv[++i];
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
    } else if (arg === "--older-than-minutes" && i + 1 < argv.length) {
      args.olderThanMinutes = Number(argv[++i]);
    } else if (arg.startsWith("--older-than-minutes=")) {
      args.olderThanMinutes = Number(arg.slice("--older-than-minutes=".length));
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/verify/stack.mjs <command> [options]

Commands:
  up [--peer] [--reachable] [--no-password] [--no-itsaplan] [--no-commander] [--no-code-server] [--run-id <id>] [--json] [--quiet]
      Bring up an isolated Paseo stack (1 commander daemon, or 2 peered daemons).

  down <runId> | --all [--quiet] [--json]
      Tear down an active stack by runId, or all stacks in the worktree.

  ls [--json]
      List active stacks and their health status.

  sweep [--older-than-minutes N] [--json] [--quiet]
      Reap stacks older than N minutes (default 120) or whose daemon pids are dead.
`);
}

function printStackUpDetails(stack) {
  const slowestBoot = Math.max(...stack.hosts.map((h) => h.bootMs));
  process.stdout.write(
    `Stack ${stack.runId} is up (${stack.peered ? "peered" : "single"}, boot ${slowestBoot}ms)\n`,
  );
  for (const host of stack.hosts) {
    process.stdout.write(`  - ${host.name} (${host.role}): ${host.httpUrl}/ (pid ${host.pid})\n`);
  }
  if (stack.password) {
    process.stdout.write(`  Password: ${stack.password}\n`);
  }
  if (stack.reachable) {
    process.stdout.write(`  Reachable host: ${stack.reachable.host}\n`);
  }
  if (stack.codeServer) {
    process.stdout.write(
      `  VS Code Web:  ${stack.codeServer.url}  (shared host code-server; ${stack.codeServer.healthy ? "healthy" : "UNHEALTHY"})\n`,
    );
  }
  process.stdout.write(`\nTo open the web UI, navigate to:\n  ${stack.hosts[0].httpUrl}/\n`);
  process.stdout.write(
    `\nTo tear down this stack, run:\n  node scripts/verify/stack.mjs down ${stack.runId}\n`,
  );
}

async function handleUpCommand(args) {
  const stack = await stackUp({
    peer: args.peer,
    reachable: args.reachable,
    noPassword: args.noPassword,
    noItsaplan: args.noItsaplan,
    noCommander: args.noCommander,
    noCodeServer: args.noCodeServer,
    runId: args.runId,
    quiet: args.quiet,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(stack, null, 2) + "\n");
  } else if (!args.quiet) {
    printStackUpDetails(stack);
  }
}

async function handleDownCommand(args) {
  const target = args._[1] || (args.all ? "--all" : null);
  if (!target && !args.all) {
    process.stderr.write("Error: 'down' requires a <runId> or '--all'\n");
    process.exit(1);
  }

  const result = await stackDown(target, { all: args.all, quiet: args.quiet });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (!args.quiet) {
    if (result.count === 0) {
      process.stdout.write("No stacks to tear down.\n");
    } else {
      process.stdout.write(`Torn down ${result.count} stack(s): ${result.reaped.join(", ")}\n`);
    }
  }
}

async function handleLsCommand(args) {
  const list = await stackList();
  if (args.json) {
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return;
  }
  if (list.length === 0) {
    process.stdout.write("No active stacks found.\n");
    return;
  }
  process.stdout.write("RUN ID      STATUS    PEERED  HOSTS (PORT / PID)\n");
  for (const item of list) {
    const hostSummary = item.hosts
      .map((h) => `${h.name}:${h.port}(${h.alive ? "alive" : "dead"})`)
      .join(", ");
    process.stdout.write(
      `${item.runId.padEnd(12)}${item.status.padEnd(10)}${item.peered ? "yes    " : "no     "}${hostSummary}\n`,
    );
  }
}

async function handleSweepCommand(args) {
  const result = await stackSweep({
    olderThanMinutes: args.olderThanMinutes,
    quiet: args.quiet,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (!args.quiet) {
    process.stdout.write(
      `Reaped ${result.count} stack(s)${result.reaped.length > 0 ? ": " + result.reaped.join(", ") : ""}.\n`,
    );
    if (result.itsaplan) {
      process.stdout.write(
        `Itsaplan sweep: ${result.itsaplan.agentsReaped} agent(s) reaped, ${result.itsaplan.webhooksReaped} webhook(s) reaped, ${result.itsaplan.issuesArchived} issue(s) archived.\n`,
      );
    }
    if (result.prunedProofDirs > 0) {
      process.stdout.write(`Pruned ${result.prunedProofDirs} old proof director(ies).\n`);
    }
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "up") {
    await handleUpCommand(args);
    return;
  }

  if (command === "down") {
    await handleDownCommand(args);
    return;
  }

  if (command === "ls") {
    await handleLsCommand(args);
    return;
  }

  if (command === "sweep") {
    await handleSweepCommand(args);
    return;
  }

  process.stderr.write(
    `Unknown command: ${command}\nRun 'node scripts/verify/stack.mjs --help' for usage.\n`,
  );
  process.exit(1);
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  });
}
