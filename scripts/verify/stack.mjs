#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateRunId,
  getArtifactsVerifyDir,
  getDevVerifyDir,
  getNodeCompileCacheDir,
  getStackArtifactsDir,
  getStackDir,
  getWorktreeRoot,
  resolveWebUiDistDir,
} from "./lib/paths.mjs";
import { allocatePorts, isPidAlive, isPortFree, killProcessGroup, waitForPortFree } from "./lib/procs.mjs";
import { spawnDaemonHost, waitForDaemonHealth } from "./lib/daemon.mjs";
import { verifyPeeringLive } from "./lib/client.mjs";

/**
 * Bring up an isolated stack (1 commander daemon, or 2 peered daemons).
 */
export async function stackUp(options = {}) {
  const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
  const runId = options.runId ?? generateRunId();
  const peer = Boolean(options.peer);
  const quiet = Boolean(options.quiet);

  const runDir = getStackDir(worktreeRoot, runId);
  const artifactsDir = getStackArtifactsDir(worktreeRoot, runId);

  mkdirSync(runDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(getNodeCompileCacheDir(worktreeRoot), { recursive: true });

  const webUiDistDir = resolveWebUiDistDir(worktreeRoot);
  if (!webUiDistDir && !quiet) {
    process.stderr.write(
      "Warning: Web UI dist directory not found. Stack will boot, but UI-tier checks cannot run.\n",
    );
  }

  const hosts = [];

  if (!peer) {
    // Single commander daemon
    const [port] = await allocatePorts(1);
    const commanderHome = path.join(runDir, "hosts", "commander");

    mkdirSync(path.join(commanderHome, "mission-control"), { recursive: true });
    writeFileSync(
      path.join(commanderHome, "config.json"),
      JSON.stringify(
        {
          peers: [],
          missionControl: { hostAlias: "commander", enabled: true },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(commanderHome, "mission-control", "central-config.json"),
      JSON.stringify({ commanderHost: "commander" }, null, 2) + "\n",
      "utf8",
    );

    spawnDaemonHost({
      hostName: "commander",
      homeDir: commanderHome,
      port,
      webUiDistDir,
      worktreeRoot,
    });

    const bootInfo = await waitForDaemonHealth({
      homeDir: commanderHome,
      expectedPort: port,
      timeoutMs: 30000,
    });

    hosts.push({
      name: "commander",
      role: "commander",
      home: commanderHome,
      port: bootInfo.port,
      httpUrl: bootInfo.httpUrl,
      wsUrl: bootInfo.wsUrl,
      pid: bootInfo.pid,
      logFile: bootInfo.logFile,
      bootMs: bootInfo.bootMs,
    });
  } else {
    // Peered two-daemon stack: commander and peer-b
    const [commanderPort, peerBPort] = await allocatePorts(2);

    const commanderHome = path.join(runDir, "hosts", "commander");
    const peerBHome = path.join(runDir, "hosts", "peer-b");

    mkdirSync(path.join(commanderHome, "mission-control"), { recursive: true });
    mkdirSync(path.join(peerBHome, "mission-control"), { recursive: true });

    writeFileSync(
      path.join(commanderHome, "config.json"),
      JSON.stringify(
        {
          peers: [{ name: "peer-b", url: `tcp://127.0.0.1:${peerBPort}` }],
          missionControl: { hostAlias: "commander", enabled: true },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(commanderHome, "mission-control", "central-config.json"),
      JSON.stringify({ commanderHost: "commander" }, null, 2) + "\n",
      "utf8",
    );

    writeFileSync(
      path.join(peerBHome, "config.json"),
      JSON.stringify(
        {
          peers: [{ name: "commander", url: `tcp://127.0.0.1:${commanderPort}` }],
          missionControl: { hostAlias: "peer-b", enabled: true },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(peerBHome, "mission-control", "central-config.json"),
      JSON.stringify({ commanderHost: "commander" }, null, 2) + "\n",
      "utf8",
    );

    spawnDaemonHost({
      hostName: "commander",
      homeDir: commanderHome,
      port: commanderPort,
      webUiDistDir,
      worktreeRoot,
    });

    spawnDaemonHost({
      hostName: "peer-b",
      homeDir: peerBHome,
      port: peerBPort,
      webUiDistDir,
      worktreeRoot,
    });

    const [commanderBoot, peerBBoot] = await Promise.all([
      waitForDaemonHealth({
        homeDir: commanderHome,
        expectedPort: commanderPort,
        timeoutMs: 30000,
      }),
      waitForDaemonHealth({
        homeDir: peerBHome,
        expectedPort: peerBPort,
        timeoutMs: 30000,
      }),
    ]);

    // Verify peering is live and peer-b is online
    await verifyPeeringLive({
      commanderWsUrl: commanderBoot.wsUrl,
      peerName: "peer-b",
      timeoutMs: 15000,
    });

    hosts.push(
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
    );
  }

  const stackData = {
    runId,
    createdAt: new Date().toISOString(),
    worktree: worktreeRoot,
    runDir,
    artifactsDir,
    webUiDistDir,
    auth: "none",
    hosts,
    peered: peer,
  };

  writeFileSync(
    path.join(runDir, "stack.json"),
    JSON.stringify(stackData, null, 2) + "\n",
    "utf8",
  );

  return stackData;
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

  const targets = [];
  if (target === "--all" || options.all) {
    const entries = readdirSync(devVerifyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== ".node-compile-cache") {
        targets.push(entry.name);
      }
    }
  } else if (target) {
    targets.push(target);
  } else {
    throw new Error("Missing target runId or --all");
  }

  const reaped = [];

  for (const id of targets) {
    const runDir = getStackDir(worktreeRoot, id);
    const stackJsonPath = path.join(runDir, "stack.json");

    if (existsSync(stackJsonPath)) {
      try {
        const raw = readFileSync(stackJsonPath, "utf8");
        const stack = JSON.parse(raw);
        if (Array.isArray(stack.hosts)) {
          for (const host of stack.hosts) {
            if (host.pid) {
              await killProcessGroup(host.pid);
            }
            if (host.port) {
              await waitForPortFree(host.port, { timeoutMs: 3000 });
            }
          }
        }
      } catch {
        // Continue cleanup even if stack.json is corrupted
      }
    }

    // Also check for any leftover paseo.pid files in hosts directory
    const hostsDir = path.join(runDir, "hosts");
    if (existsSync(hostsDir)) {
      try {
        const hostEntries = readdirSync(hostsDir, { withFileTypes: true });
        for (const hostEntry of hostEntries) {
          if (hostEntry.isDirectory()) {
            const pidPath = path.join(hostsDir, hostEntry.name, "paseo.pid");
            if (existsSync(pidPath)) {
              try {
                const info = JSON.parse(readFileSync(pidPath, "utf8"));
                if (info.pid) {
                  await killProcessGroup(info.pid);
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
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
      const status = allAlive ? "running" : anyAlive ? "degraded" : "stopped";

      results.push({
        runId: stack.runId,
        createdAt: stack.createdAt,
        ageMs: Date.now() - Date.parse(stack.createdAt || 0),
        peered: Boolean(stack.peered),
        status,
        hosts: hostsInfo,
      });
    } catch {}
  }

  return results;
}

/**
 * Sweep dead or stale stacks.
 */
export async function stackSweep(options = {}) {
  const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
  const olderThanMinutes = options.olderThanMinutes ?? 120;
  const maxAgeMs = olderThanMinutes * 60 * 1000;
  const devVerifyDir = getDevVerifyDir(worktreeRoot);

  if (!existsSync(devVerifyDir)) {
    return { count: 0, reaped: [] };
  }

  const reaped = [];
  const entries = readdirSync(devVerifyDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".node-compile-cache") {
      continue;
    }

    const runDir = path.join(devVerifyDir, entry.name);
    const stackJsonPath = path.join(runDir, "stack.json");
    let shouldReap = false;

    if (existsSync(stackJsonPath)) {
      try {
        const stack = JSON.parse(readFileSync(stackJsonPath, "utf8"));
        const ageMs = Date.now() - Date.parse(stack.createdAt || 0);
        const hasDeadPid = (stack.hosts || []).some((h) => !isPidAlive(h.pid));

        if (ageMs > maxAgeMs || hasDeadPid) {
          shouldReap = true;
        }
      } catch {
        shouldReap = true;
      }
    } else {
      // Missing stack.json: check directory age or if dead
      try {
        const st = statSync(runDir);
        if (Date.now() - st.mtimeMs > maxAgeMs) {
          shouldReap = true;
        }
      } catch {
        shouldReap = true;
      }
    }

    if (shouldReap) {
      await stackDown(entry.name, { worktreeRoot, quiet: true });
      reaped.push(entry.name);
    }
  }

  return { count: reaped.length, reaped };
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

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`Usage: node scripts/verify/stack.mjs <command> [options]

Commands:
  up [--peer] [--run-id <id>] [--json] [--quiet]
      Bring up an isolated Paseo stack (1 commander daemon, or 2 peered daemons).

  down <runId> | --all [--quiet]
      Tear down an active stack by runId, or all stacks in the worktree.

  ls [--json]
      List active stacks and their health status.

  sweep [--older-than-minutes N] [--json] [--quiet]
      Reap stacks older than N minutes (default 120) or whose daemon pids are dead.
`);
    return;
  }

  if (command === "up") {
    const stack = await stackUp({
      peer: args.peer,
      runId: args.runId,
      quiet: args.quiet,
    });

    if (args.json) {
      process.stdout.write(JSON.stringify(stack, null, 2) + "\n");
    } else if (!args.quiet) {
      const slowestBoot = Math.max(...stack.hosts.map((h) => h.bootMs));
      process.stdout.write(`Stack ${stack.runId} is up (${stack.peered ? "peered" : "single"}, boot ${slowestBoot}ms)
`);
      for (const host of stack.hosts) {
        process.stdout.write(`  - ${host.name} (${host.role}): ${host.httpUrl}/ (pid ${host.pid})\n`);
      }
      process.stdout.write(`\nTo open the web UI, navigate to:\n  ${stack.hosts[0].httpUrl}/\n`);
      process.stdout.write(`\nTo tear down this stack, run:\n  node scripts/verify/stack.mjs down ${stack.runId}\n`);
    }
    return;
  }

  if (command === "down") {
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
    return;
  }

  if (command === "ls") {
    const list = await stackList();
    if (args.json) {
      process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    } else {
      if (list.length === 0) {
        process.stdout.write("No active stacks found.\n");
        return;
      }
      process.stdout.write(`RUN ID      STATUS    PEERED  HOSTS (PORT / PID)\n`);
      for (const item of list) {
        const hostSummary = item.hosts.map((h) => `${h.name}:${h.port}(${h.alive ? "alive" : "dead"})`).join(", ");
        process.stdout.write(
          `${item.runId.padEnd(12)}${item.status.padEnd(10)}${item.peered ? "yes    " : "no     "}${hostSummary}\n`,
        );
      }
    }
    return;
  }

  if (command === "sweep") {
    const result = await stackSweep({
      olderThanMinutes: args.olderThanMinutes,
      quiet: args.quiet,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (!args.quiet) {
      process.stdout.write(`Reaped ${result.count} stack(s)${result.reaped.length > 0 ? ": " + result.reaped.join(", ") : ""}.\n`);
    }
    return;
  }

  process.stderr.write(`Unknown command: ${command}\nRun 'node scripts/verify/stack.mjs --help' for usage.\n`);
  process.exit(1);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  });
}
