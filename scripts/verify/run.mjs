#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

import { DaemonClient } from "../../packages/client/dist/daemon-client.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, "../..");

function parseArgs(args) {
  const opts = {
    check: null,
    stack: null,
    up: null,
    video: false,
    json: false,
    keep: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--video") {
      opts.video = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--up") {
      opts.up = true;
    } else if (arg === "--stack") {
      opts.stack = args[++i];
    } else if (arg.startsWith("--stack=")) {
      opts.stack = arg.slice("--stack=".length);
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: node scripts/verify/run.mjs <check> [--stack <runId>] [--up] [--video] [--json] [--keep]`);
      process.exit(0);
    } else if (!arg.startsWith("-") && !opts.check) {
      opts.check = arg;
    }
  }

  if (!opts.check) {
    console.error("Error: missing required <check> argument");
    console.error("Usage: node scripts/verify/run.mjs <check> [--stack <runId>] [--up] [--video] [--json] [--keep]");
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

  throw new Error(`Could not resolve check "${checkArg}". Checked paths:\n${candidates.join("\n")}`);
}

async function loadStackFromRunId(runId) {
  const candidates = [
    path.resolve(WORKTREE_ROOT, ".dev/verify", runId, "stack.json"),
    path.resolve(runId, "stack.json"),
    path.resolve(runId),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const content = await fsp.readFile(candidate, "utf8");
      return JSON.parse(content);
    }
  }

  throw new Error(`Could not find stack.json for runId "${runId}". Checked:\n${candidates.join("\n")}`);
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

  const supervisorScript = path.join(WORKTREE_ROOT, "packages/server/dist/scripts/supervisor-entrypoint.js");
  const hostHome = path.join(runDir, "hosts/commander");
  const logFile = path.join(hostHome, "daemon.log");
  const logFd = fs.openSync(logFile, "a");

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
      try {
        const pidData = JSON.parse(await fsp.readFile(pidFile, "utf8"));
        if (pidData.listen) {
          const match = String(pidData.listen).match(/:(\d+)$/);
          if (match) {
            port = parseInt(match[1], 10);
          }
        }
      } catch {}
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
  const stack = {
    runId,
    createdAt: new Date().toISOString(),
    worktree: WORKTREE_ROOT,
    runDir,
    artifactsDir,
    webUiDistDir,
    auth: "none",
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

async function bringUpStack(needsPeer = false) {
  const stackScript = path.join(WORKTREE_ROOT, "scripts/verify/stack.mjs");
  if (fs.existsSync(stackScript)) {
    try {
      const args = ["up", "--json"];
      if (needsPeer) args.push("--peer");
      const { stdout } = await execFileAsync(process.execPath, [stackScript, ...args], {
        cwd: WORKTREE_ROOT,
      });

      // Parse JSON from output
      const jsonStart = stdout.indexOf("{");
      const jsonEnd = stdout.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
        return { stack: parsed, viaStackScript: true };
      }
    } catch (err) {
      // Fallback if stack.mjs throws or is incomplete
    }
  }

  const stack = await runFallbackStackUp({ needsPeer });
  return { stack, viaStackScript: false };
}

async function tearDownStack(stack, viaStackScript) {
  if (viaStackScript) {
    const stackScript = path.join(WORKTREE_ROOT, "scripts/verify/stack.mjs");
    if (fs.existsSync(stackScript)) {
      try {
        await execFileAsync(process.execPath, [stackScript, "down", stack.runId], {
          cwd: WORKTREE_ROOT,
        });
        return;
      } catch {}
    }
  }

  // Fallback kill
  if (stack._fallbackChildPid) {
    try {
      process.kill(-stack._fallbackChildPid, "SIGTERM");
    } catch {}
  } else if (Array.isArray(stack.hosts)) {
    for (const host of stack.hosts) {
      if (host.pid) {
        try {
          process.kill(host.pid, "SIGTERM");
        } catch {}
      }
    }
  }
}

async function setupPlaywright(stack, shouldRecordVideo) {
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

  const userDataDir = path.join(stack.runDir, "browser-user-data");
  await fsp.mkdir(userDataDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const videoDir = path.join(stack.runDir, "video");
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

  return {
    browser,
    context,
    page,
    videoDir,
    videoStartMs,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const checkPath = resolveCheckFile(opts.check);
  const checkModule = await import(pathToFileURL(checkPath).href);

  const meta = {
    name: checkModule.meta?.name || path.basename(checkPath, ".mjs"),
    tier: checkModule.meta?.tier || "daemon",
    hosts: checkModule.meta?.hosts || 1,
    video: Boolean(checkModule.meta?.video || opts.video),
    description: checkModule.meta?.description || "",
  };

  const checkSteps = Array.isArray(checkModule.steps) ? checkModule.steps : [];
  if (checkSteps.length === 0) {
    throw new Error(`Check ${checkPath} defines no steps.`);
  }

  let stack = null;
  let ownedStack = false;
  let viaStackScript = false;

  if (opts.stack) {
    stack = await loadStackFromRunId(opts.stack);
  } else {
    ownedStack = true;
    const brought = await bringUpStack(meta.hosts > 1);
    stack = brought.stack;
    viaStackScript = brought.viaStackScript;
  }

  await fsp.mkdir(stack.artifactsDir, { recursive: true });
  const shotsDir = path.join(stack.artifactsDir, "shots");
  await fsp.mkdir(shotsDir, { recursive: true });

  // Connect daemon clients for all hosts
  const hostClients = new Map();
  for (const host of stack.hosts) {
    const client = new DaemonClient({
      url: host.wsUrl,
      appVersion: "0.1.70",
    });
    await client.connect();
    try {
      await client.fetchAgents({ subscribe: { subscriptionId: `verify-${stack.runId}-${host.name}` } });
    } catch {}
    hostClients.set(host.name, client);
  }

  let pw = null;
  if (meta.tier === "ui" || meta.video) {
    pw = await setupPlaywright(stack, meta.video);
  }

  const runStartedAt = new Date().toISOString();
  const runStartPerf = Date.now();
  const timeAnchor = pw?.videoStartMs || runStartPerf;

  let shotsBefore = null;
  let shotsAfter = null;
  let currentStepId = "init";
  const stepShotsMap = new Map();

  const ctx = {
    stack,
    artifactsDir: stack.artifactsDir,
    page: pw?.page || null,
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
        throw new Error("Cannot capture screenshot: Playwright page is not initialized (check tier is not 'ui')");
      }
      const fileName = `${currentStepId}-${label}-${Date.now()}.png`;
      const shotPath = path.join(shotsDir, fileName);
      await pw.page.screenshot({ path: shotPath, fullPage: false });

      if (!stepShotsMap.has(currentStepId)) {
        stepShotsMap.set(currentStepId, []);
      }
      stepShotsMap.get(currentStepId).push(shotPath);

      if (label === "before" && !shotsBefore) {
        shotsBefore = shotPath;
      } else if (label === "after") {
        shotsAfter = shotPath;
      }
      return shotPath;
    },
    expect(condition, message) {
      if (!condition) {
        throw new Error(message || "Assertion failed");
      }
    },
    log(msg) {
      if (!opts.json) {
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

  const stepResults = [];
  let executionFailed = false;

  if (!opts.json) {
    console.log(`\n=== Running check: ${meta.name} (${meta.tier}) ===`);
    if (meta.description) {
      console.log(`    ${meta.description}\n`);
    }
  }

  for (const step of checkSteps) {
    currentStepId = step.id;
    stepShotsMap.set(step.id, []);

    if (executionFailed) {
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
      executionFailed = true;

      if (pw?.page) {
        try {
          await ctx.shot("failure");
        } catch {}
      }
    }

    const stepEnd = Date.now();
    const endMs = Math.max(startMs, stepEnd - timeAnchor);

    const stepRecord = {
      id: step.id,
      label: step.label,
      narrate: step.narrate || "",
      kind: step.kind || meta.tier || "daemon",
      status,
      startMs,
      endMs,
      detail,
      error,
      shots: stepShotsMap.get(step.id) || [],
    };
    stepResults.push(stepRecord);

    if (!opts.json) {
      const dur = ((stepEnd - stepStart) / 1000).toFixed(2);
      if (status === "pass") {
        console.log(`  ✓ [PASS] ${step.label} (${dur}s)${detail ? ` - ${detail}` : ""}`);
      } else {
        console.log(`  ✗ [FAIL] ${step.label} (${dur}s): ${error}`);
      }
    }
  }

  // Teardown Playwright
  let rawVideoPath = null;
  if (pw) {
    try {
      if (pw.page) await pw.page.close().catch(() => {});
      if (pw.context) await pw.context.close().catch(() => {});
      if (pw.browser) await pw.browser.close().catch(() => {});

      if (meta.video) {
        const videoFiles = (await fsp.readdir(pw.videoDir)).filter((f) => f.endsWith(".webm"));
        if (videoFiles.length > 0) {
          const srcWebm = path.join(pw.videoDir, videoFiles[0]);
          const destWebm = path.join(stack.artifactsDir, "raw.webm");
          await fsp.copyFile(srcWebm, destWebm);
          rawVideoPath = destWebm;
        }
      }
    } catch {}
  }

  // Close daemon clients
  for (const client of hostClients.values()) {
    try {
      await client.close();
    } catch {}
  }

  const durationMs = Date.now() - runStartPerf;
  const passed = !executionFailed && stepResults.every((s) => s.status === "pass");

  const cleanStack = { ...stack };
  delete cleanStack._fallbackChildPid;

  const result = {
    name: meta.name,
    tier: meta.tier,
    startedAt: runStartedAt,
    durationMs,
    passed,
    stack: cleanStack,
    steps: stepResults,
    shots: {
      before: shotsBefore || null,
      after: shotsAfter || null,
    },
    video: rawVideoPath ? { raw: rawVideoPath, width: 1280, height: 720 } : null,
    reproduce: [
      meta.hosts > 1 ? "node scripts/verify/stack.mjs up --peer" : "node scripts/verify/stack.mjs up",
      `node scripts/verify/run.mjs ${meta.name} --stack ${stack.runId}`,
    ],
  };

  const resultFile = path.join(stack.artifactsDir, "result.json");
  await fsp.writeFile(resultFile, JSON.stringify(result, null, 2), "utf8");

  if (ownedStack && !opts.keep) {
    await tearDownStack(stack, viaStackScript);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Result: ${passed ? "PASSED" : "FAILED"} in ${(durationMs / 1000).toFixed(2)}s ===`);
    console.log(`    Result JSON: ${resultFile}`);
    if (result.video) {
      console.log(`    Raw Video:   ${result.video.raw}`);
    }
  }

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error running check:", err);
  process.exit(1);
});
