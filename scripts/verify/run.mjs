#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

import { DaemonClient } from "../../packages/client/dist/daemon-client.js";
import { buildConnectSnippet } from "./lib/connect-snippet.mjs";
import { discoverCodeServer } from "./lib/paths.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, "../..");

function printHelp() {
  console.log(`Usage:
  node scripts/verify/run.mjs <check> [--stack <runId> | --up] [--expect pass|fail] [--video] [--proof] [--keep] [--json] [--reachable] [--no-password] [--no-itsaplan] [--no-commander]
  node scripts/verify/run.mjs --all [--tier daemon|ui|fleet] [--proof] [--json]
`);
}

function parseOptionFlag(arg, opts) {
  if (arg === "--video") {
    opts.video = true;
    return true;
  }
  if (arg === "--proof") {
    opts.proof = true;
    opts.video = true;
    return true;
  }
  if (arg === "--json") {
    opts.json = true;
    return true;
  }
  if (arg === "--keep") {
    opts.keep = true;
    return true;
  }
  if (arg === "--up") {
    opts.up = true;
    return true;
  }
  if (arg === "--all") {
    opts.all = true;
    return true;
  }
  if (arg === "--reachable") {
    opts.reachable = true;
    return true;
  }
  if (arg === "--no-password") {
    opts.noPassword = true;
    return true;
  }
  if (arg === "--no-itsaplan") {
    opts.noItsaplan = true;
    return true;
  }
  if (arg === "--no-commander") {
    opts.noCommander = true;
    return true;
  }
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  }
  return false;
}

function parseOptionWithVal(args, i) {
  const arg = args[i];
  if (arg === "--stack") return { val: args[i + 1], nextI: i + 1, key: "stack" };
  if (arg.startsWith("--stack="))
    return { val: arg.slice("--stack=".length), nextI: i, key: "stack" };
  if (arg === "--expect") return { val: args[i + 1], nextI: i + 1, key: "expect" };
  if (arg.startsWith("--expect="))
    return { val: arg.slice("--expect=".length), nextI: i, key: "expect" };
  if (arg === "--tier") return { val: args[i + 1], nextI: i + 1, key: "tier" };
  if (arg.startsWith("--tier=")) return { val: arg.slice("--tier=".length), nextI: i, key: "tier" };
  return null;
}

function parseArgs(args) {
  const opts = {
    check: null,
    stack: null,
    up: null,
    video: false,
    proof: false,
    json: false,
    keep: false,
    expect: "pass",
    all: false,
    tier: null,
    reachable: false,
    noPassword: false,
    noItsaplan: false,
    noCommander: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (parseOptionFlag(arg, opts)) {
      continue;
    }
    const withVal = parseOptionWithVal(args, i);
    if (withVal) {
      opts[withVal.key] = withVal.val;
      i = withVal.nextI;
      continue;
    }
    if (!arg.startsWith("-") && !opts.check) {
      opts.check = arg;
    }
  }

  if (opts.expect !== "pass" && opts.expect !== "fail") {
    console.error(`Error: --expect must be either "pass" or "fail", got "${opts.expect}"`);
    process.exit(1);
  }

  if (!opts.all && !opts.check) {
    console.error("Error: missing required <check> argument (or use --all)");
    printHelp();
    process.exit(1);
  }

  if (opts.up === null) {
    opts.up = !opts.stack;
  }

  return opts;
}

function resolveCheckFile(checkArg) {
  const candidates = [
    path.resolve(process.cwd(), checkArg),
    path.resolve(process.cwd(), `${checkArg}.mjs`),
    path.resolve(WORKTREE_ROOT, "scripts/verify/checks", checkArg),
    path.resolve(WORKTREE_ROOT, "scripts/verify/checks", `${checkArg}.mjs`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(
    `Could not resolve check "${checkArg}". Checked paths:\n${candidates.join("\n")}`,
  );
}

async function loadStackFromRunId(runId) {
  const candidates = [
    path.resolve(WORKTREE_ROOT, ".dev/verify", runId, "stack.json"),
    path.resolve(WORKTREE_ROOT, "artifacts/verify", runId, "stack.json"),
    path.resolve(runId, "stack.json"),
    path.resolve(runId),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const content = await fsp.readFile(candidate, "utf8");
      const stack = JSON.parse(content);
      if (stack.password === undefined) stack.password = null;
      if (stack.fixtureRepo === undefined) stack.fixtureRepo = path.join(stack.runDir, "fixture");
      if (stack.proofDir === undefined) {
        stack.proofDir = path.join(
          os.homedir(),
          ".paseo",
          "verify-proofs",
          path.basename(WORKTREE_ROOT),
          stack.runId,
        );
      }
      if (stack.reachable === undefined) stack.reachable = null;
      if (stack.codeServer === undefined) stack.codeServer = null;
      return stack;
    }
  }

  throw new Error(
    `Could not find stack.json for runId "${runId}". Checked:\n${candidates.join("\n")}`,
  );
}

async function runFallbackStackUp(options = {}) {
  const runId = `v-${crypto.randomBytes(4).toString("hex")}`;
  const runDir = path.join(WORKTREE_ROOT, ".dev/verify", runId);
  const artifactsDir = path.join(WORKTREE_ROOT, "artifacts/verify", runId);
  const webUiDistDir = "/data/paseo/packages/server/dist/server/web-ui";

  await fsp.mkdir(path.join(runDir, "hosts/commander"), { recursive: true });
  await fsp.mkdir(artifactsDir, { recursive: true });

  const cacheDir = path.join(WORKTREE_ROOT, ".dev/verify/.node-compile-cache");
  await fsp.mkdir(cacheDir, { recursive: true });

  const supervisorScript = path.join(
    WORKTREE_ROOT,
    "packages/server/dist/scripts/supervisor-entrypoint.js",
  );
  const hostHome = path.join(runDir, "hosts/commander");
  const logFile = path.join(hostHome, "daemon.log");
  const logFd = fs.openSync(logFile, "a");

  const password = options.noPassword ? null : crypto.randomBytes(12).toString("hex");

  const cleanEnv = { ...process.env };
  delete cleanEnv.PASEO_PASSWORD;
  delete cleanEnv.PASEO_AGENT_ID;
  delete cleanEnv.PASEO_AGENT_CWD;

  const env = {
    ...cleanEnv,
    PASEO_HOME: hostHome,
    PASEO_LISTEN: "127.0.0.1:0",
    PASEO_WEB_UI_ENABLED: "1",
    PASEO_WEB_UI_DIST_DIR: webUiDistDir,
    PASEO_RELAY_ENABLED: "0",
    PASEO_TUNNEL_AUTOSTART: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_SERVICE_PROXY_ENABLED: "0",
    PASEO_NODE_INSPECT: "0",
    PASEO_LOG_LEVEL: "warn",
    NODE_COMPILE_CACHE: cacheDir,
  };

  if (password) {
    env.PASEO_PASSWORD = password;
  }

  const startTime = Date.now();
  const child = spawn(process.execPath, [supervisorScript], {
    cwd: WORKTREE_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  const pidFile = path.join(hostHome, "paseo.pid");
  let port = null;

  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(pidFile)) {
      port = await readPortFromPidFile(pidFile);
    }

    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) {
          break;
        }
      } catch {}
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  if (!port) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    throw new Error(`Fallback stack up failed: daemon on ${hostHome} did not become ready`);
  }

  const bootMs = Date.now() - startTime;
  const proofDir = path.join(
    os.homedir(),
    ".paseo",
    "verify-proofs",
    path.basename(WORKTREE_ROOT),
    runId,
  );
  const fixtureRepo = path.join(runDir, "fixture");

  const stack = {
    runId,
    createdAt: new Date().toISOString(),
    worktree: WORKTREE_ROOT,
    runDir,
    artifactsDir,
    proofDir,
    fixtureRepo,
    password,
    reachable: null,
    commander: { enabled: !options.noCommander },
    itsaplan: options.noItsaplan ? null : { enabled: false },
    codeServer: await discoverCodeServer({ enabled: !options.noCodeServer }),
    webUiDistDir,
    auth: password ? "password" : "none",
    hosts: [
      {
        name: "commander",
        role: "commander",
        home: hostHome,
        port,
        httpUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        pid: child.pid,
        logFile,
        bootMs,
      },
    ],
    peered: false,
    _fallbackChildPid: child.pid,
  };

  await fsp.writeFile(path.join(runDir, "stack.json"), JSON.stringify(stack, null, 2), "utf8");
  return stack;
}

async function bringUpStack(needsPeer = false, options = {}) {
  const stackScript = path.join(WORKTREE_ROOT, "scripts/verify/stack.mjs");
  if (fs.existsSync(stackScript)) {
    try {
      const args = ["up", "--json"];
      if (needsPeer) args.push("--peer");
      if (options.reachable) args.push("--reachable");
      if (options.noPassword) args.push("--no-password");
      if (options.noItsaplan) args.push("--no-itsaplan");
      if (options.noCommander) args.push("--no-commander");
      if (options.noCodeServer) args.push("--no-code-server");

      const { stdout } = await execFileAsync(process.execPath, [stackScript, ...args], {
        cwd: WORKTREE_ROOT,
      });

      const jsonStart = stdout.indexOf("{");
      const jsonEnd = stdout.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
        if (parsed.password === undefined) parsed.password = null;
        if (parsed.fixtureRepo === undefined)
          parsed.fixtureRepo = path.join(parsed.runDir, "fixture");
        if (parsed.proofDir === undefined) {
          parsed.proofDir = path.join(
            os.homedir(),
            ".paseo",
            "verify-proofs",
            path.basename(WORKTREE_ROOT),
            parsed.runId,
          );
        }
        if (parsed.reachable === undefined) parsed.reachable = null;
        if (parsed.codeServer === undefined) parsed.codeServer = null;
        return { stack: parsed, viaStackScript: true };
      }
    } catch {
      // Fallback if stack.mjs throws or is incomplete
    }
  }

  const stack = await runFallbackStackUp({ needsPeer, ...options });
  return { stack, viaStackScript: false };
}

function killPidSafely(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

async function tearDownStack(stack, viaStackScript) {
  if (viaStackScript && stack?.runId) {
    const stackScript = path.join(WORKTREE_ROOT, "scripts/verify/stack.mjs");
    if (fs.existsSync(stackScript)) {
      try {
        await execFileAsync(process.execPath, [stackScript, "down", stack.runId, "--quiet"], {
          cwd: WORKTREE_ROOT,
        });
        return;
      } catch {
        // Fall back to process group kill
      }
    }
  }

  if (stack?._fallbackChildPid) {
    try {
      process.kill(-stack._fallbackChildPid, "SIGTERM");
    } catch {}
  } else if (Array.isArray(stack?.hosts)) {
    for (const host of stack.hosts) {
      if (host.pid) {
        killPidSafely(host.pid);
      }
    }
  }
}

async function setupPlaywright(stack, shouldRecordVideo, checkName = "check") {
  const { chromium } = await import("playwright");

  const candidates = [
    "/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
    process.env.CHROME_BIN,
  ].filter(Boolean);

  let executablePath;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      executablePath = c;
      break;
    }
  }

  const userDataDir = path.join(stack.runDir, `browser-user-data-${checkName}-${Date.now()}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const videoDir = path.join(stack.runDir, `video-${checkName}-${Date.now()}`);
  await fsp.mkdir(videoDir, { recursive: true });

  const contextOptions = {
    viewport: { width: 1280, height: 720 },
  };

  let videoStartMs = null;
  if (shouldRecordVideo) {
    contextOptions.recordVideo = {
      dir: videoDir,
      size: { width: 1280, height: 720 },
    };
    videoStartMs = Date.now();
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Playwright (ui tier): seed localStorage["@paseo:daemon-registry"] with a directTcp entry
  // carrying password via page.addInitScript, mirroring packages/app/e2e/support/fixtures.ts:150-185
  // and the schema in packages/app/src/types/host-connection.ts:365-420, and set @paseo:e2e="1"
  // so the connection-hint probe is skipped. With --no-password keep the v1 hint path.
  if (stack.password) {
    const nowIso = new Date().toISOString();
    const seededHosts = (stack.hosts || []).map((h) => {
      let serverId = h.name || "commander";
      try {
        const idPath = path.join(h.home, "server-id");
        if (fs.existsSync(idPath)) {
          const raw = fs.readFileSync(idPath, "utf8").trim();
          if (raw) serverId = raw;
        }
      } catch {}

      const endpoint = `127.0.0.1:${h.port}`;
      const hostProfile = {
        serverId,
        label: h.name || "localhost",
        connections: [
          {
            id: `direct:${endpoint}`,
            type: "directTcp",
            endpoint,
            password: stack.password,
          },
        ],
        preferredConnectionId: `direct:${endpoint}`,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (stack.codeServer?.healthy) {
        hostProfile.browserEditorUrl = stack.codeServer.url;
      }
      return hostProfile;
    });

    await page.addInitScript(
      ({ hosts }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify(hosts));
        localStorage.removeItem("@paseo:settings");
      },
      { hosts: seededHosts },
    );
  }

  return {
    browser,
    context,
    page,
    videoDir,
    videoStartMs,
  };
}

async function discoverChecks(filterTier = null) {
  const checksDir = path.join(WORKTREE_ROOT, "scripts/verify/checks");
  const files = (await fsp.readdir(checksDir)).filter((f) => f.endsWith(".mjs")).sort();

  const discovered = [];
  for (const file of files) {
    const filePath = path.join(checksDir, file);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const name = mod.meta?.name || path.basename(file, ".mjs");
      const tier = mod.meta?.tier || "daemon";
      const hosts = mod.meta?.hosts || 1;
      const video = Boolean(mod.meta?.video);
      const description = mod.meta?.description || "";
      const steps = Array.isArray(mod.steps) ? mod.steps : [];

      if (filterTier && tier !== filterTier) {
        continue;
      }

      discovered.push({
        filePath,
        file,
        name,
        tier,
        hosts,
        video,
        description,
        steps,
        mod,
      });
    } catch (err) {
      console.error(`Failed to import check ${file}:`, err);
    }
  }
  return discovered;
}

function extractCheckMeta(checkModule, resolvedPath, opts) {
  return {
    name: checkModule.meta?.name || path.basename(resolvedPath, ".mjs"),
    tier: checkModule.meta?.tier || "daemon",
    hosts: checkModule.meta?.hosts || 1,
    video: Boolean(checkModule.meta?.video || opts.video || opts.proof),
    description: checkModule.meta?.description || "",
  };
}

async function obtainStackForCheck(externalStack, opts, meta) {
  if (externalStack) {
    return { stack: externalStack, ownedStack: false, viaStackScript: false };
  }
  if (opts.stack) {
    const stack = await loadStackFromRunId(opts.stack);
    return { stack, ownedStack: false, viaStackScript: false };
  }
  const brought = await bringUpStack(meta.hosts > 1, opts);
  return { stack: brought.stack, ownedStack: true, viaStackScript: brought.viaStackScript };
}

function shimClientCompatibility(client) {
  const originalCreateWorkspace = client.createWorkspace.bind(client);
  client.createWorkspace = async function (input, requestId) {
    if (input && !input.source && (input.path || input.cwd)) {
      const pathVal = input.path || input.cwd;
      const titleVal = input.title || input.name;
      return originalCreateWorkspace(
        {
          source: { kind: "directory", path: pathVal },
          ...(titleVal !== undefined ? { title: titleVal } : {}),
          ...(input.firstAgentContext !== undefined
            ? { firstAgentContext: input.firstAgentContext }
            : {}),
        },
        requestId,
      );
    }
    return originalCreateWorkspace(input, requestId);
  };

  if (typeof client.listWorkspaces !== "function") {
    client.listWorkspaces = async function (options) {
      const res = await client.fetchWorkspaces(options);
      const list = res?.entries || [];
      return { workspaces: list, entries: list };
    };
  }

  const originalInstructionsOpen = client.missionControlInstructionsOpen.bind(client);
  client.missionControlInstructionsOpen = async function (options) {
    const res = await originalInstructionsOpen(options);
    if (!res.instruction && Array.isArray(res.instructions) && res.instructions.length > 0) {
      res.instruction = res.instructions[0];
    }
    return res;
  };
}

async function connectHostClients(stack, meta) {
  const hostClients = new Map();
  for (const host of stack.hosts) {
    const client = new DaemonClient({
      url: host.wsUrl,
      clientId: `verify-${stack.runId}-${meta.name}-${host.name}-${Date.now().toString(36)}`,
      clientType: "cli",
      appVersion: "0.1.70",
      password: stack.password || undefined,
    });
    shimClientCompatibility(client);
    await client.connect();
    try {
      await client.fetchAgents({
        subscribe: { subscriptionId: `verify-${stack.runId}-${meta.name}-${host.name}` },
      });
    } catch {}
    hostClients.set(host.name, client);
  }
  return hostClients;
}

async function closeHostClients(hostClients) {
  for (const client of hostClients.values()) {
    try {
      await client.close();
    } catch {}
  }
}

async function teardownPlaywright(pw, meta, stack) {
  let rawVideoPath = null;
  if (!pw) return rawVideoPath;
  try {
    if (pw.page) await pw.page.close().catch(() => {});
    if (pw.context) await pw.context.close().catch(() => {});
    if (pw.browser) await pw.browser.close().catch(() => {});
    if (meta.video) {
      const videoFiles = (await fsp.readdir(pw.videoDir)).filter((f) => f.endsWith(".webm"));
      if (videoFiles.length > 0) {
        const srcWebm = path.join(pw.videoDir, videoFiles[0]);
        const destWebm = path.join(stack.artifactsDir, `${meta.name}-raw.webm`);
        await fsp.copyFile(srcWebm, destWebm);
        rawVideoPath = destWebm;
      }
    }
  } catch {}
  return rawVideoPath;
}

function createCheckContext({ stack, hostClients, pw, meta, shotsDir, state }) {
  const ctx = {
    stack,
    artifactsDir: stack.artifactsDir,
    page: pw?.page || null,
    fixtureRepo: stack.fixtureRepo || path.join(stack.runDir, "fixture"),
    password: stack.password ?? null,
    codeServerUrl: stack.codeServer?.healthy ? stack.codeServer.url : null,
    reachableUrl(hostName) {
      const targetHost = ctx.host(hostName);
      if (stack.reachable?.urls) {
        const key = hostName || targetHost.name;
        if (stack.reachable.urls[key]) {
          return stack.reachable.urls[key];
        }
      }
      if (stack.reachable?.host) {
        return `http://${stack.reachable.host}:${targetHost.port}`;
      }
      return targetHost.httpUrl;
    },
    host(name) {
      const targetName = name || (stack.hosts[0] ? stack.hosts[0].name : "commander");
      const hostInfo = stack.hosts.find((h) => h.name === targetName) || stack.hosts[0];
      if (!hostInfo) {
        throw new Error(`Host "${targetName}" not found in stack.`);
      }
      return {
        ...hostInfo,
        client: hostClients.get(hostInfo.name),
      };
    },
    async shot(label) {
      if (!pw?.page) {
        throw new Error(
          "Cannot capture screenshot: Playwright page is not initialized (check tier is not 'ui')",
        );
      }
      const fileName = `${meta.name}-${state.currentStepId}-${label}-${Date.now()}.png`;
      const shotPath = path.join(shotsDir, fileName);
      await pw.page.screenshot({ path: shotPath, fullPage: false });

      if (!state.stepShotsMap.has(state.currentStepId)) {
        state.stepShotsMap.set(state.currentStepId, []);
      }
      state.stepShotsMap.get(state.currentStepId).push(shotPath);

      if (label === "before" && !state.shotsBefore) {
        state.shotsBefore = shotPath;
      } else if (label === "after") {
        state.shotsAfter = shotPath;
      }
      return shotPath;
    },
    expect(condition, message) {
      if (!condition) {
        throw new Error(message || "Assertion failed");
      }
    },
    log(msg) {
      if (!state.opts.json) {
        console.log(`    [log] ${msg}`);
      }
    },
    async readDaemonLog(hostName) {
      const targetHost = ctx.host(hostName);
      if (fs.existsSync(targetHost.logFile)) {
        return await fsp.readFile(targetHost.logFile, "utf8");
      }
      return "";
    },
  };
  return ctx;
}

function logStepStatus(opts, status, label, dur, detail, error) {
  if (opts.json) return;
  if (status === "pass") {
    console.log(`  ✓ [PASS] ${label} (${dur}s)${detail ? ` - ${detail}` : ""}`);
  } else {
    console.log(`  ✗ [FAIL] ${label} (${dur}s): ${error}`);
  }
}

async function executeSingleStep(step, ctx, pw, timeAnchor, opts, meta, state) {
  const stepStart = Date.now();
  const startMs = Math.max(0, stepStart - timeAnchor);
  let status = "pass";
  let detail = null;
  let error = null;

  try {
    const res = await step.run(ctx);
    if (typeof res === "string") {
      detail = res;
    } else if (res && typeof res.detail === "string") {
      detail = res.detail;
    }
  } catch (err) {
    status = "fail";
    error = err.message || String(err);
    state.executionFailed = true;
    if (pw?.page) {
      try {
        await ctx.shot("failure");
      } catch {}
    }
  }

  const stepEnd = Date.now();
  const endMs = Math.max(startMs, stepEnd - timeAnchor);
  logStepStatus(opts, status, step.label, ((stepEnd - stepStart) / 1000).toFixed(2), detail, error);

  return {
    id: step.id,
    label: step.label,
    narrate: step.narrate || "",
    kind: step.kind || meta.tier || "daemon",
    status,
    startMs,
    endMs,
    detail,
    error,
    shots: state.stepShotsMap.get(step.id) || [],
  };
}

async function runCheckSteps(checkSteps, ctx, pw, timeAnchor, opts, meta, state) {
  const stepResults = [];
  if (!opts.json) {
    const banner = state.externalStack
      ? `\n--- Running check: ${meta.name} (${meta.tier}) ---`
      : `\n=== Running check: ${meta.name} (${meta.tier}) ===`;
    console.log(banner);
    if (meta.description && !state.externalStack) {
      console.log(`    ${meta.description}\n`);
    }
  }

  for (const step of checkSteps) {
    state.currentStepId = step.id;
    state.stepShotsMap.set(step.id, []);

    if (state.executionFailed) {
      stepResults.push({
        id: step.id,
        label: step.label,
        narrate: step.narrate || "",
        kind: step.kind || meta.tier || "daemon",
        status: "skip",
        startMs: 0,
        endMs: 0,
        detail: "skipped after previous step failure",
        error: null,
        shots: [],
      });
      continue;
    }

    const record = await executeSingleStep(step, ctx, pw, timeAnchor, opts, meta, state);
    stepResults.push(record);
  }
  return stepResults;
}
async function mirrorProofMp4(targetMp4, standardMp4, externalStack) {
  if (externalStack) return;
  if (targetMp4 && fs.existsSync(targetMp4) && targetMp4 !== standardMp4) {
    await fsp.copyFile(targetMp4, standardMp4);
  }
}

async function assembleProofs(opts, meta, stack, resultFile, externalStack) {
  if (!opts.proof) return { proofMp4Path: null, proofError: null };
  const narrateDir = path.join(stack.runDir, "narration", meta.name);
  await fsp.mkdir(narrateDir, { recursive: true });

  const narrateScript = path.join(WORKTREE_ROOT, "scripts/verify/narrate.mjs");
  if (fs.existsSync(narrateScript)) {
    try {
      await execFileAsync(
        process.execPath,
        [narrateScript, "--result", resultFile, "--out", narrateDir],
        {
          cwd: WORKTREE_ROOT,
          timeout: 30000,
        },
      );
    } catch {}
  }

  const videoScript = path.join(WORKTREE_ROOT, "scripts/verify/video.py");
  const targetMp4 = path.join(stack.artifactsDir, `${meta.name}-proof.mp4`);
  const standardMp4 = path.join(stack.artifactsDir, "proof.mp4");
  let proofMp4Path = null;
  let proofError = null;

  if (fs.existsSync(videoScript)) {
    try {
      const videoArgs = [
        videoScript,
        "--result",
        resultFile,
        "--out",
        targetMp4,
        "--narrate-dir",
        narrateDir,
        "--fast",
      ];
      await execFileAsync("python3", videoArgs, { cwd: WORKTREE_ROOT, timeout: 60000 });
      if (fs.existsSync(targetMp4)) {
        proofMp4Path = targetMp4;
        await mirrorProofMp4(targetMp4, standardMp4, externalStack);
      }
    } catch (err) {
      proofError = err.message || String(err);
    }
  }
  return { proofMp4Path, proofError };
}

async function copyDurableArtifact(sourcePath, destPath, kind, label, proofs) {
  if (sourcePath && fs.existsSync(sourcePath)) {
    await fsp.copyFile(sourcePath, destPath);
    proofs.push({ kind, path: destPath, label });
  }
}

async function copyDurableProofs(opts, meta, stack, proofDir, proofMp4Path, state) {
  const proofs = [];
  if (!opts.proof) return proofs;
  const standardMp4 = path.join(stack.artifactsDir, "proof.mp4");
  const resolvedMp4 = proofMp4Path || (fs.existsSync(standardMp4) ? standardMp4 : null);
  await copyDurableArtifact(
    resolvedMp4,
    path.join(proofDir, "proof.mp4"),
    "video",
    `Proof: ${meta.name}`,
    proofs,
  );

  const standardBefore = path.join(stack.artifactsDir, "before.png");
  const resolvedBefore =
    state.shotsBefore || (fs.existsSync(standardBefore) ? standardBefore : null);
  await copyDurableArtifact(
    resolvedBefore,
    path.join(proofDir, "before.png"),
    "image",
    `Before: ${meta.name}`,
    proofs,
  );

  const standardAfter = path.join(stack.artifactsDir, "after.png");
  const resolvedAfter = state.shotsAfter || (fs.existsSync(standardAfter) ? standardAfter : null);
  await copyDurableArtifact(
    resolvedAfter,
    path.join(proofDir, "after.png"),
    "image",
    `After: ${meta.name}`,
    proofs,
  );

  return proofs;
}

async function writeResultArtifacts({
  intermediateResult,
  resultFile,
  standardResultFile,
  externalStack,
}) {
  await fsp.writeFile(resultFile, JSON.stringify(intermediateResult, null, 2), "utf8");
  if (!externalStack) {
    await fsp.writeFile(standardResultFile, JSON.stringify(intermediateResult, null, 2), "utf8");
  }
}

async function writeFinalResultFiles({
  finalResult,
  resultFile,
  standardResultFile,
  externalStack,
  proofDir,
  opts,
}) {
  await fsp.writeFile(resultFile, JSON.stringify(finalResult, null, 2), "utf8");
  if (!externalStack) {
    await fsp.writeFile(standardResultFile, JSON.stringify(finalResult, null, 2), "utf8");
  }
  if (opts.proof) {
    const durableResultFile = path.join(proofDir, "result.json");
    await fsp.writeFile(durableResultFile, JSON.stringify(finalResult, null, 2), "utf8");
  }
}

function buildFinalResult({
  intermediateResult,
  proofs,
  proofError,
  proofMp4Path,
  proofDir,
  meta,
  stack,
  opts,
  statSize,
}) {
  const finalResult = {
    ...intermediateResult,
    proofs,
    reproduce: [
      `node scripts/verify/run.mjs ${meta.name} --up --keep${opts.reachable ? " --reachable" : ""}`,
      "node scripts/verify/stack.mjs ls",
      `node scripts/verify/stack.mjs down ${stack.runId}`,
    ],
  };
  if (proofError) {
    finalResult.proofError = proofError;
  }
  if (proofMp4Path && statSize !== null) {
    finalResult.proof = {
      mp4: proofMp4Path,
      bytes: statSize,
      durablePath: path.join(proofDir, "proof.mp4"),
    };
  }
  return finalResult;
}

function printCheckSummary(
  finalResult,
  stack,
  ctx,
  proofDir,
  standardResultFile,
  passed,
  expectationMet,
  durationMs,
  keep,
) {
  console.log(
    `\n=== Result: ${passed ? "PASSED" : "FAILED"} (Expectation: ${finalResult.expectation}, Met: ${expectationMet}) in ${(durationMs / 1000).toFixed(2)}s ===`,
  );
  console.log("\n--- Stack Details ---");
  console.log(`Stack Run ID: ${stack.runId}`);
  console.log(`Password:     ${stack.password || "(none)"}`);
  console.log("Web UI:");
  for (const host of stack.hosts) {
    console.log(`  - ${host.name}: ${ctx.reachableUrl(host.name)}`);
  }
  if (stack.codeServer?.healthy) {
    console.log(
      `VS Code Web:  ${stack.codeServer.url}  (shared host code-server; paste into Settings -> host -> VS Code Web URL on the Mac)`,
    );
  }
  if (finalResult.proofs && finalResult.proofs.length > 0) {
    console.log(`\nDurable Proofs (${proofDir}):`);
    for (const p of finalResult.proofs) {
      console.log(`  - [${p.kind}] ${p.label}: ${p.path}`);
    }
  }
  console.log(`\nResult JSON:  ${standardResultFile}`);
  console.log("\nReproduce Recipe:");
  for (let i = 0; i < finalResult.reproduce.length; i++) {
    console.log(`  ${i + 1}. ${finalResult.reproduce[i]}`);
  }
  if (keep && stack.password) {
    console.log(
      `\nRegister the kept stack in a browser: open ${ctx.reachableUrl()}/ and paste this into the devtools console:\n`,
    );
    console.log(buildConnectSnippet(stack));
    console.log(`\n(or: node scripts/verify/stack.mjs connect ${stack.runId})`);
  }
  console.log("");
}

async function runSingleCheck(checkPath, opts, externalStack = null) {
  const resolvedPath = resolveCheckFile(checkPath);
  const checkModule = await import(pathToFileURL(resolvedPath).href);
  const meta = extractCheckMeta(checkModule, resolvedPath, opts);

  const checkSteps = Array.isArray(checkModule.steps) ? checkModule.steps : [];
  if (checkSteps.length === 0) {
    throw new Error(`Check ${resolvedPath} defines no steps.`);
  }

  const { stack, ownedStack, viaStackScript } = await obtainStackForCheck(
    externalStack,
    opts,
    meta,
  );

  await fsp.mkdir(stack.artifactsDir, { recursive: true });
  const shotsDir = path.join(stack.artifactsDir, "shots");
  await fsp.mkdir(shotsDir, { recursive: true });

  const proofDir =
    stack.proofDir ||
    path.join(os.homedir(), ".paseo", "verify-proofs", path.basename(WORKTREE_ROOT), stack.runId);
  await fsp.mkdir(proofDir, { recursive: true });

  const hostClients = await connectHostClients(stack, meta);
  let pw = null;
  if (meta.tier === "ui" || meta.video) {
    pw = await setupPlaywright(stack, meta.video, meta.name);
  }

  const runStartedAt = new Date().toISOString();
  const runStartPerf = Date.now();
  const timeAnchor = pw?.videoStartMs || runStartPerf;

  const state = {
    shotsBefore: null,
    shotsAfter: null,
    currentStepId: "init",
    stepShotsMap: new Map(),
    executionFailed: false,
    externalStack: Boolean(externalStack),
    opts,
  };

  const ctx = createCheckContext({ stack, hostClients, pw, meta, shotsDir, state });
  const stepResults = await runCheckSteps(checkSteps, ctx, pw, timeAnchor, opts, meta, state);

  const rawVideoPath = await teardownPlaywright(pw, meta, stack);
  await closeHostClients(hostClients);

  const durationMs = Date.now() - runStartPerf;
  const passed = !state.executionFailed && stepResults.every((s) => s.status === "pass");
  const expectationMet = opts.expect === "fail" ? !passed : passed;

  const cleanStack = { ...stack };
  delete cleanStack._fallbackChildPid;
  cleanStack.proofDir = proofDir;

  const intermediateResult = {
    name: meta.name,
    tier: meta.tier,
    startedAt: runStartedAt,
    durationMs,
    passed,
    expectation: opts.expect,
    expectationMet,
    stack: cleanStack,
    codeServer: cleanStack.codeServer,
    steps: stepResults,
    shots: {
      before: state.shotsBefore || null,
      after: state.shotsAfter || null,
    },
    video: rawVideoPath ? { raw: rawVideoPath, width: 1280, height: 720 } : null,
  };

  const resultFile = path.join(stack.artifactsDir, `${meta.name}-result.json`);
  const standardResultFile = path.join(stack.artifactsDir, "result.json");
  await writeResultArtifacts({ intermediateResult, resultFile, standardResultFile, externalStack });

  const { proofMp4Path, proofError } = await assembleProofs(
    opts,
    meta,
    stack,
    resultFile,
    externalStack,
  );
  const proofs = await copyDurableProofs(opts, meta, stack, proofDir, proofMp4Path, state);
  let statSize = null;
  if (proofMp4Path && fs.existsSync(proofMp4Path)) {
    const stat = await fsp.stat(proofMp4Path);
    statSize = stat.size;
  }
  const finalResult = buildFinalResult({
    intermediateResult,
    proofs,
    proofError,
    proofMp4Path,
    proofDir,
    meta,
    stack,
    opts,
    statSize,
  });

  await writeFinalResultFiles({
    finalResult,
    resultFile,
    standardResultFile,
    externalStack,
    proofDir,
    opts,
  });

  if (ownedStack && !opts.keep) {
    await tearDownStack(stack, viaStackScript);
  }

  if (!externalStack) {
    if (opts.json) {
      console.log(JSON.stringify(finalResult, null, 2));
    } else {
      printCheckSummary(
        finalResult,
        stack,
        ctx,
        proofDir,
        standardResultFile,
        passed,
        expectationMet,
        durationMs,
        opts.keep,
      );
    }
  }

  return {
    ...finalResult,
    stepsPassed: stepResults.filter((s) => s.status === "pass").length,
    stepsTotal: stepResults.length,
  };
}

async function runAll(opts) {
  const startTime = Date.now();
  const checks = await discoverChecks(opts.tier);
  if (checks.length === 0) {
    if (opts.tier) {
      console.error(`No checks found matching tier "${opts.tier}"`);
    } else {
      console.error("No checks found in scripts/verify/checks");
    }
    process.exit(1);
  }

  // Group by meta.hosts
  const groups = new Map();
  for (const check of checks) {
    const h = check.hosts;
    if (!groups.has(h)) {
      groups.set(h, []);
    }
    groups.get(h).push(check);
  }

  // Sort groups by host count ascending (1, 2, ...)
  const sortedHostKeys = [...groups.keys()].sort((a, b) => a - b);
  const allResults = [];
  const stackUsage = [];

  for (const hostCount of sortedHostKeys) {
    const groupChecks = groups.get(hostCount);
    const peer = hostCount > 1;

    if (!opts.json) {
      console.log(`\n======================================================`);
      console.log(`Bringing up stack for hosts:${hostCount} (${groupChecks.length} check(s))`);
      console.log(`======================================================`);
    }

    const brought = await bringUpStack(peer, opts);
    const stack = brought.stack;
    const viaStackScript = brought.viaStackScript;

    stackUsage.push({
      hosts: hostCount,
      runId: stack.runId,
      checkCount: groupChecks.length,
    });

    try {
      for (const check of groupChecks) {
        try {
          const result = await runSingleCheck(check.filePath, opts, stack);
          allResults.push(result);
        } catch (err) {
          allResults.push({
            name: check.name,
            tier: check.tier,
            passed: false,
            expectation: opts.expect,
            expectationMet: false,
            durationMs: 0,
            stepsPassed: 0,
            stepsTotal: check.steps.length,
            error: err.message || String(err),
          });
        }
      }
    } finally {
      if (!opts.keep) {
        if (!opts.json) {
          console.log(`Tearing down stack ${stack.runId} for hosts:${hostCount}...`);
        }
        await tearDownStack(stack, viaStackScript);
      }
    }
  }

  const totalWallMs = Date.now() - startTime;
  const passedCount = allResults.filter((r) => r.passed).length;
  const failedCount = allResults.length - passedCount;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          total: allResults.length,
          passed: passedCount,
          failed: failedCount,
          wallMs: totalWallMs,
          stacks: stackUsage,
          checks: allResults,
        },
        null,
        2,
      ),
    );
  } else {
    // Format table
    const checkColWidth = Math.max(26, ...allResults.map((r) => r.name.length));
    const header = `┌─${"─".repeat(checkColWidth)}─┬────────┬───────┬────────┬──────────┐`;
    const footer = `└─${"─".repeat(checkColWidth)}─┴────────┴───────┴────────┴──────────┘`;
    const divider = `├─${"─".repeat(checkColWidth)}─┼────────┼───────┼────────┼──────────┤`;

    console.log(`\n=== Verification Suite: ${allResults.length} checks ===\n`);
    console.log(header);
    console.log(`│ ${"Check".padEnd(checkColWidth)} │ Tier   │ Steps │ Status │ Duration │`);
    console.log(divider);

    for (const r of allResults) {
      const statusStr = r.passed ? "PASS" : "FAIL";
      const durStr = `${(r.durationMs / 1000).toFixed(2)}s`;
      const stepsStr = `${r.stepsPassed}/${r.stepsTotal}`;
      console.log(
        `│ ${r.name.padEnd(checkColWidth)} │ ${r.tier.padEnd(6)} │ ${stepsStr.padEnd(5)} │ ${statusStr.padEnd(6)} │ ${durStr.padStart(8)} │`,
      );
    }
    console.log(footer);

    console.log(
      `\nTotal: ${allResults.length} checks (${passedCount} passed, ${failedCount} failed) in ${(totalWallMs / 1000).toFixed(2)}s wall time.`,
    );
    for (const s of stackUsage) {
      console.log(`One stack (${s.runId}) used for hosts:${s.hosts} (${s.checkCount} check(s)).`);
    }
    console.log("");
  }

  process.exit(failedCount === 0 ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.all) {
    await runAll(opts);
    return;
  }

  const result = await runSingleCheck(opts.check, opts);
  process.exit(result.expectationMet ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error running check:", err);
  process.exit(1);
});
