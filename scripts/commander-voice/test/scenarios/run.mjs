#!/usr/bin/env node
// Commander Voice scenario bench — runner (spec 08 Layer 3).
//
//   node scripts/commander-voice/test/scenarios/run.mjs [--scenario N] [--burnin N] [--out DIR] [--keep]
//
// Boots ONE in-process test daemon per run (bootstrap.ts, OS port — never
// 6767/6768), starts the voice node in-process (direct mode, production voice
// model, thinking minimal), speaks the scenario utterances as Gemini TTS
// audio, and asserts on the session JSONL + {spoken,data} payloads + ledger
// rows + proposals + daemon state — never on speech quality.
//
// Writes per-scenario verdicts + evidence paths to /tmp/voice-scenarios/
// report.json. --burnin 5 runs the full suite 5 consecutive times (the
// direct-default flip pass bar). Quota-blocked scenarios are marked "skip"
// with the exact error and the run continues.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startVoiceServer } from "../../server.js";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import { resolveGeminiApiKey } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const BOOTSTRAP = path.join(__dirname, "bootstrap.ts");
const DEFAULT_OUT = "/tmp/voice-scenarios";
const SCENARIO_COUNT = 9;
const SCENARIO_TIMEOUT_MS = 420_000;
const BOOTSTRAP_TIMEOUT_MS = 180_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { scenario: null, burnin: 1, outDir: DEFAULT_OUT, keep: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--scenario" && args[i + 1]) {
      out.scenario = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === "--burnin" && args[i + 1]) {
      out.burnin = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === "--out" && args[i + 1]) {
      out.outDir = args[i + 1];
      i += 1;
    } else if (args[i] === "--keep") {
      out.keep = true;
    }
  }
  if (out.scenario !== null && (out.scenario < 1 || out.scenario > SCENARIO_COUNT)) {
    throw new Error(`--scenario must be 1..${SCENARIO_COUNT}, got ${out.scenario}`);
  }
  return out;
}

/** True when the error is a TTS/Live quota or capability block. */
export function isQuotaError(error) {
  const text = String(error?.message ?? error ?? "");
  return /quota|resource_exhausted|429|403|insufficient|402|payment|rate.?limit|max.*turns?|text.turn/i.test(
    text,
  );
}

async function spawnBootstrap({ keep }) {
  const child = spawn("npx", ["tsx", BOOTSTRAP, ...(keep ? ["--keep"] : [])], {
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { promise, resolve, reject } = Promise.withResolvers();
  let buffer = "";
  let readyResolved = false;
  const timer = setTimeout(() => {
    reject(new Error(`bootstrap did not report ready within ${BOOTSTRAP_TIMEOUT_MS}ms`));
  }, BOOTSTRAP_TIMEOUT_MS);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === "ready") {
          clearTimeout(timer);
          readyResolved = true;
          resolve(parsed);
        }
      } catch {
        // not JSON or not the ready line — keep buffering
      }
      buffer = buffer.slice(newline + 1);
    }
  });
  child.on("exit", (code) => {
    if (!readyResolved) {
      clearTimeout(timer);
      reject(new Error(`bootstrap exited before ready (code ${code})`));
    }
  });
  const ready = await promise;
  return { child, ready };
}

async function shutdownBootstrap(child) {
  if (child.exitCode !== null) return;
  const { promise, resolve } = Promise.withResolvers();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve();
  }, 30_000);
  child.on("exit", () => {
    clearTimeout(timer);
    resolve();
  });
  try {
    child.stdin.write("shutdown\n");
  } catch {
    child.kill("SIGTERM");
  }
  await promise;
}

function scenarioModulePath(id) {
  return path.join(__dirname, `scenario-${id}.mjs`);
}

function classifyVerdict(result) {
  const verdict = result?.verdict;
  if (verdict === "pass") return "pass";
  if (verdict === "skip") return "skip";
  return "fail";
}

function timeoutFor(id) {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`scenario ${id} exceeded ${SCENARIO_TIMEOUT_MS}ms`)),
      SCENARIO_TIMEOUT_MS,
    ),
  );
}

async function runOneScenario(ctx, module, id, startedAt) {
  const verdict = {
    id,
    name: module.name ?? `scenario-${id}`,
    verdict: "fail",
    details: {},
    evidence: [],
    at: new Date().toISOString(),
  };
  try {
    const result = await Promise.race([module.run(ctx), timeoutFor(id)]);
    verdict.verdict = classifyVerdict(result);
    verdict.details = result?.details ?? {};
    verdict.evidence = result?.evidence ?? [];
    if (result?.error) verdict.error = String(result.error);
  } catch (error) {
    if (isQuotaError(error)) {
      verdict.verdict = "skip";
      verdict.error = `quota/blocked: ${error.message}`;
    } else {
      verdict.error = error?.stack ?? String(error);
    }
  }
  verdict.ms = Date.now() - startedAt;
  return verdict;
}

async function runRound({ round, options, apiKey }) {
  const runDir = path.join(options.outDir, `run-${round}`);
  const sessionsDir = path.join(runDir, "sessions");
  const evidenceDir = path.join(runDir, "evidence");
  await mkdir(runDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  const { child, ready } = await spawnBootstrap({ keep: options.keep });

  let client;
  const verdicts = {};
  try {
    client = new DaemonClient({
      url: `ws://127.0.0.1:${ready.port}/ws`,
      clientId: `voice-scenario-runner-${round}`,
      clientType: "cli",
      appVersion: ready.appVersion,
      connectTimeoutMs: 15_000,
      webSocketFactory: (targetUrl, wsOpts) =>
        new WebSocket(targetUrl, wsOpts?.protocols, { headers: wsOpts?.headers }),
      reconnect: { enabled: true },
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: `voice-scenario-${round}` } });

    const ids = options.scenario
      ? [options.scenario]
      : [...Array(SCENARIO_COUNT).keys()].map((i) => i + 1);
    for (const id of ids) {
      const module = await import(pathToFileURL(scenarioModulePath(id)).href);
      // A FRESH voice node per scenario. The announce policy injects
      // proposal/needs-you events into EVERY live Gemini session, so a shared
      // node lets a previous scenario's tail events (leftover pending
      // proposals, late harness replays) broadcast into the next scenario's
      // live window and derail the model (seen: S6 hearing S5's "dupe"
      // proposal announce and dropping its enum-retry). A per-scenario node
      // also resets the announce buffer, which only drains via pending_updates.
      const voice = await startVoiceServer({
        port: 0,
        host: "127.0.0.1",
        paseoWsUrl: `ws://127.0.0.1:${ready.port}/ws`,
        paseoClientVersion: ready.appVersion,
        voiceMode: "direct",
        thinkingLevel: "minimal",
        sessionLogDir: sessionsDir,
        geminiApiKey: apiKey,
        updateBufferCap: 256,
      });
      // The voice node's own daemon connection: satisfy any fetchAgents
      // handshake the session may expect (harmless otherwise).
      await voice.daemon.client
        .fetchAgents({ subscribe: { subscriptionId: `voice-node-${round}-${id}` } })
        .catch(() => undefined);
      const voicePort = voice.server.address().port;
      const ctx = {
        round,
        scenarioId: id,
        client,
        daemonPort: ready.port,
        deepseek: ready.deepseek,
        deepseekModelId: ready.deepseekModelId,
        providerMode: ready.providerMode,
        seed: ready.seed,
        voicePort,
        sessionLogDir: sessionsDir,
        evidenceDir,
        runDir,
        log: (msg) => console.log(`[run ${round}][S${id}] ${msg}`),
      };
      try {
        const verdict = await runOneScenario(ctx, module, id, Date.now());
        verdicts[id] = verdict;
        ctx.log(
          `${verdict.verdict}${verdict.error ? ` — ${verdict.error}` : ""} (${verdict.ms}ms)`,
        );
      } finally {
        const t0 = Date.now();
        try {
          await voice.close();
          console.log(`[run ${round}][S${id}] voice.close ${Date.now() - t0}ms`);
        } catch (error) {
          console.log(`[run ${round}][S${id}] voice.close failed: ${error.message}`);
        }
      }
    }
  } finally {
    const t0 = Date.now();
    try {
      await client?.close();
    } catch {
      // best-effort
    }
    await shutdownBootstrap(child);
    console.log(`[run ${round}] bootstrap shutdown ${Date.now() - t0}ms`);
  }
  return { runDir, verdicts };
}

async function main() {
  const opts = parseArgs();
  const apiKey = resolveGeminiApiKey();
  await mkdir(opts.outDir, { recursive: true });

  const rounds = [];
  for (let round = 1; round <= opts.burnin; round += 1) {
    console.log(`\n=== burnin round ${round}/${opts.burnin} ===`);
    const result = await runRound({ round, options: opts, apiKey });
    rounds.push(result);
    if (opts.scenario) {
      const v = result.verdicts[opts.scenario];
      console.log(`\nS${opts.scenario} ${v.name}: ${v.verdict}${v.error ? ` — ${v.error}` : ""}`);
    } else {
      const counts = { pass: 0, fail: 0, skip: 0 };
      for (const v of Object.values(result.verdicts)) counts[v.verdict] += 1;
      console.log(`round ${round}: ${JSON.stringify(counts)}`);
    }
  }

  const allPassed = rounds.every((r) =>
    Object.values(r.verdicts).every((v) => v.verdict === "pass"),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    suite: "commander-voice Layer 3 scenarios",
    burnin: { required: opts.burnin, passed: allPassed, rounds: rounds.length },
    rounds: rounds.map((r, i) => ({
      round: i + 1,
      runDir: r.runDir,
      scenarios: r.verdicts,
    })),
    directDefaultFlip: { bar: "5 consecutive green runs", green: allPassed && opts.burnin >= 5 },
    scenario: opts.scenario ?? "all",
  };
  const reportPath = path.join(opts.outDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nREPORT: ${reportPath}`);
  console.log(
    `burn-in: ${allPassed ? "GREEN" : "NOT GREEN"} (${opts.burnin} round(s)${allPassed ? "" : " — see report for failures"})`,
  );
}

main().catch((error) => {
  console.error(`run.mjs failed: ${error?.stack ?? error}`);
  process.exit(1);
});
