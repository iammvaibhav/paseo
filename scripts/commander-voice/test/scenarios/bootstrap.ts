// Commander Voice scenario bench — isolated daemon bootstrap (spec 08 Layer 3).
//
// A tsx-run child process that owns ONE in-process test daemon (never 6767/6768):
//   - seeds a workspace ("Alpha Project") + a couple of roster agents,
//   - resolves the deepseek v4 flash invocable provider string from the daemon's
//     provider snapshot (real omp client when the CLI exists; else fakes),
//   - prints a single JSON "ready" line to stdout for the runner,
//   - serves a stdin protocol: "shutdown" (or stdin EOF) tears the daemon down.
//
// The runner (run.mjs) spawns this with `npx tsx` from the repo root. Scripts in
// packages/server/src must be reachable — tsx resolves the relative imports below
// (the same pattern docs/ad-hoc-daemon-testing.md prescribes).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import pino from "pino";

import { createTestPaseoDaemon } from "../../../../packages/server/src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../../../../packages/server/src/server/test-utils/daemon-client.js";
import { createTestAgentClients } from "../../../../packages/server/src/server/test-utils/fake-agent-client.js";
import { createRealProviderClient } from "../../../../packages/server/src/server/daemon-e2e/real-provider-test-config.js";
import { isCommandAvailable } from "../../../../packages/server/src/executable-resolution/executable-resolution.js";

const CLIENT_APP_VERSION = "0.4.0";
const WORKER_MODEL_PATTERNS = [/google-antigravity\/gemini-3\.7-flash/i, /gemini-3\.7-flash/i];
const SNAPSHOT_POLL_MS = 60_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { root: null as string | null, keep: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      out.root = args[i + 1];
      i += 1;
    } else if (args[i] === "--keep") {
      out.keep = true;
    }
  }
  return out;
}

/** Prefer google-antigravity/gemini-3.7-flash (per instructions), else
 * match the first gemini-3.7-flash model in the omp snapshot. */
function pickWorkerModel(models: Array<{ id?: string | null }>): string | null {
  const ids = models.map((m) => m.id).filter((id): id is string => Boolean(id));
  const exact = ids.find((id) => id === "google-antigravity/gemini-3.7-flash");
  if (exact) return exact;
  for (const pattern of WORKER_MODEL_PATTERNS) {
    const match = ids.find((id) => pattern.test(id));
    if (match) return match;
  }
  return null;
}

async function resolveWorkerModel(client, logger) {
  let workerModelString = null;
  let workerModelId = null;
  let snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
  const pollStartedAt = Date.now();
  while (Date.now() - pollStartedAt < SNAPSHOT_POLL_MS) {
    const ompEntry = snapshot.entries.find((e) => e.provider === "omp");
    if (ompEntry && ompEntry.status !== "loading" && ompEntry.status !== "idle") {
      const model = pickWorkerModel(ompEntry.models ?? []);
      if (model) {
        workerModelId = model;
        workerModelString = `omp/${model}`;
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
    snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
  }
  if (!workerModelString && isCommandAvailable("omp")) {
    const ompEntry = snapshot.entries.find((e) => e.provider === "omp");
    const available = (ompEntry?.models ?? []).map((m) => m.id).join(", ");
    throw new Error(
      `Worker model google-antigravity/gemini-3.7-flash not found in omp snapshot. Available models: ${available}`,
    );
  }
  if (workerModelString && workerModelId) {
    // Pin the composer last-pick so fleet_list_models reports the worker
    // model as the host's default worker model with thinking high.
    await client
      .patchDaemonConfig({
        composerPreferences: {
          provider: "omp",
          providerPreferences: {
            omp: {
              model: workerModelId,
              thinkingByModel: { [workerModelId]: "high" },
            },
          },
        },
      })
      .catch((error) => {
        logger.warn({ err: error }, "composerPreferences patch failed");
      });
  }
  return {
    workerModelString,
    workerModelId,
    deepseekString: workerModelString,
    deepseekModelId: workerModelId,
  };
}

async function seedFleet(client, root, logger) {
  const seedDir = path.join(root, "workspace-seed");
  await mkdir(seedDir, { recursive: true });
  const workspaceResp = await client.createWorkspace({
    source: { kind: "directory", path: seedDir },
    title: "Alpha Project",
  });
  const workspace = workspaceResp.workspace ?? workspaceResp;
  const workspaceId = workspace?.id ?? workspace?.workspaceId ?? null;
  const projectId = workspace?.projectId ?? null;

  const seedAgents = [];
  for (const [title, initialPrompt] of [
    ["Keen Heisenberg", "Seed worker one. Stay idle."],
    ["Ada Lovelace", "Seed worker two. Stay idle."],
  ]) {
    const created = await client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: seedDir,
      title,
      initialPrompt,
      modeId: "full-access",
    });
    seedAgents.push({ id: created.id, name: created.name ?? null, title: created.title ?? title });
  }
  logger.info({ workspaceId, projectId, seedAgents }, "voice scenario seeds ready");
  return { workspaceId, projectId, workspaceTitle: "Alpha Project", seedDir, agents: seedAgents };
}

async function serveShutdown(client, daemon, root, keep) {
  const shutdown = async (): Promise<void> => {
    try {
      await client.close().catch(() => undefined);
    } finally {
      await daemon.close().catch(() => undefined);
      if (!keep) {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
          () => undefined,
        );
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "shutdown") {
      void shutdown();
    }
  });
  rl.on("close", () => void shutdown());
}

async function main() {
  const { root: rootArg, keep } = parseArgs();
  const root = rootArg ?? (await mkdtemp(path.join(os.tmpdir(), "voice-scenario-")));
  await mkdir(root, { recursive: true });
  const paseoHome = path.join(root, ".paseo");
  await mkdir(path.join(paseoHome, "mission-control"), { recursive: true });
  // Central config, written BEFORE the daemon boots: the store reads it at
  // initialize(). voiceMode "direct" is the mode under test (spec 05); mode
  // "ask" keeps every mutation approval-gated so scenarios exercise the
  // proposal flow (and the voice node's fetchVoiceMode sees "direct").
  //
  // commanderHost "local" designates THIS host as the fleet Commander host, so
  // the daemon boot-ensures a Commander agent (ensureCommanderOnBoot). Without
  // one, the voice card machinery has nobody to attribute cards to: post_answer
  // / clarify / tag_message all fail with "No Commander ...", and ledger rows
  // never close by citing cards — scenario 7's ledger-close assertion can never
  // pass. The Commander is a real (idle) roster agent; every digest assertion
  // recomputes from the model's own filter args, so the extra idle agent does
  // not change any spoken-count expectation.
  await writeFile(
    path.join(paseoHome, "mission-control", "central-config.json"),
    JSON.stringify({ voiceMode: "direct", mode: "ask", commanderHost: "local" }, null, 2),
    "utf8",
  );

  const logger = pino(
    { level: process.env.VOICE_SCENARIO_LOG_LEVEL ?? "warn" },
    pino.destination(2),
  );
  const realOmp = await isCommandAvailable("omp");
  const agentClients = {
    ...createTestAgentClients(),
    ...(realOmp ? { omp: createRealProviderClient("omp", logger) } : {}),
  };
  const providerOverrides = realOmp ? { omp: { enabled: true } } : undefined;

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    agentClients,
    providerOverrides,
    logger,
    cleanup: false,
  });

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: CLIENT_APP_VERSION,
    clientId: "voice-scenario-bootstrap",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "voice-scenario-bootstrap" } });

  // --- Resolve gemini 3.7 flash from the provider snapshot ------------------
  const { workerModelString, deepseekString, deepseekModelId } = await resolveWorkerModel(
    client,
    logger,
  );
  const providerMode = workerModelString ? "real" : "fake";

  // --- Seed a workspace + roster agents -------------------------------------
  const seed = await seedFleet(client, root, logger);

  // --- Ready handshake --------------------------------------------------------
  const ready = {
    type: "ready",
    port: daemon.port,
    paseoHome,
    paseoHomeRoot: root,
    staticDir: daemon.staticDir,
    appVersion: CLIENT_APP_VERSION,
    deepseek: deepseekString,
    deepseekModelId,
    providerMode,
    seed,
  };
  process.stdout.write(JSON.stringify(ready) + "\n");

  await serveShutdown(client, daemon, root, keep);
}

main().catch((error) => {
  console.error(`bootstrap failed: ${error?.stack ?? error}`);
  process.exit(1);
});
