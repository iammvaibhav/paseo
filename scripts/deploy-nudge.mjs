#!/usr/bin/env node
/**
 * Deploy self-wake nudge (client-based).
 *
 * The detached deploy restart (scripts/deploy.sh) kills in-flight agent
 * provider processes along with the daemon. The daemon respawns an agent's
 * provider process on demand when a message is delivered to it, so the agents
 * that were running before the restart can be brought back without a human:
 * the orchestrating agent just needs a nudge to re-check its task state.
 *
 * This script has two modes, meant to bracket a daemon restart:
 *
 *   --snapshot <file>   connect to the local daemon and write every agent with
 *                       status "running" as [{ "id": ..., "title": ... }] to
 *                       <file>. Run BEFORE stopping the daemon.
 *   --nudge <file>      read the snapshot and send each agent a message
 *                       (default: resume prompt). Run AFTER the daemon is
 *                       healthy again. Per-agent errors are logged, never
 *                       fatal; the process always exits 0.
 *
 * Usage:
 *   node scripts/deploy-nudge.mjs --snapshot <file> [--host HOST] [--password PW]
 *   node scripts/deploy-nudge.mjs --nudge <file> [--message <text>] [--host HOST] [--password PW]
 *
 * Env:
 *   PASEO_NUDGE_URL       daemon endpoint (default 127.0.0.1:6767)
 *   PASEO_NUDGE_PASSWORD  daemon password (default $PASEO_PASSWORD)
 *
 * Timeouts are bounded (10s connect); any connect/send failure is logged and
 * the script exits 0 so a nudge problem can NEVER fail a deploy.
 */

import { DaemonClient } from "@getpaseo/client";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
// Advertise a real client version so the daemon does not treat this CLI as a
// legacy client (which hides non-legacy providers and returns zero agents).
const CLIENT_APP_VERSION = require("../packages/client/package.json").version;

const DEFAULT_HOST = "127.0.0.1:6767";
const CONNECT_TIMEOUT_MS = 10_000;

// Default resume prompt: tells a resurrected agent why it is being woken and
// to re-verify (not assume) any mid-flight verification work.
const DEFAULT_MESSAGE =
  "Deploy finished; the daemon restarted and you were resurrected. " +
  "Re-check your task state and continue — if you were mid-verification, " +
  "re-verify instead of assuming.";

function parseArgs(argv) {
  const args = { host: DEFAULT_HOST, message: DEFAULT_MESSAGE };
  let mode = null;
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--snapshot" || part === "--nudge") {
      if (mode) {
        console.error("deploy-nudge: pass exactly one of --snapshot or --nudge");
        process.exit(2);
      }
      mode = part.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`deploy-nudge: --${mode} requires a file path`);
        process.exit(2);
      }
      args[mode] = next;
      i += 1;
      continue;
    }
    if (part === "--host" || part === "--password" || part === "--message") {
      const key = part.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`deploy-nudge: --${key} requires a value`);
        process.exit(2);
      }
      args[key] = next;
      i += 1;
      continue;
    }
    console.error(`deploy-nudge: unknown option: ${part}`);
    process.exit(2);
  }
  if (!mode) {
    console.error("deploy-nudge: pass --snapshot <file> or --nudge <file>");
    process.exit(2);
  }
  return args;
}

function createClient(host, password) {
  const url = /^wss?:\/\//.test(host) ? host : `ws://${host}/ws`;
  return new DaemonClient({
    url,
    clientId: `deploy-nudge-${process.pid}`,
    clientType: "cli",
    appVersion: CLIENT_APP_VERSION,
    password,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    webSocketFactory: (targetUrl, options) =>
      new WebSocket(targetUrl, options?.protocols, { headers: options?.headers }),
    reconnect: { enabled: false },
  });
}

// Connect with a bounded timeout. On any failure log and exit 0 — the nudge
// must never fail a deploy (a dead daemon mid-restart is expected here).
async function connectOrSkip(host, password, label) {
  const client = createClient(host, password);
  try {
    await client.connect();
    return client;
  } catch (error) {
    console.log(
      `${label} skipped: cannot connect to daemon at ${host}: ${error?.message ?? error}`,
    );
    return null;
  }
}

async function runSnapshot(client, file, label) {
  let payload;
  try {
    payload = await client.fetchAgents({});
  } catch (error) {
    console.log(`${label} snapshot skipped: list agents failed: ${error?.message ?? error}`);
    return;
  }
  const running = (payload?.entries ?? [])
    .map((entry) => entry?.agent)
    .filter((agent) => agent && agent.status === "running")
    .map((agent) => ({ id: agent.id, title: agent.title ?? null }));
  await writeFile(file, `${JSON.stringify(running, null, 2)}\n`, "utf8");
  console.log(`${label} snapshot: wrote ${running.length} running agent(s) to ${file}`);
}

async function runNudge(client, file, message, label) {
  let agents;
  try {
    const raw = await readFile(file, "utf8");
    agents = JSON.parse(raw);
  } catch (error) {
    console.log(`${label} nudge skipped: cannot read snapshot ${file}: ${error?.message ?? error}`);
    return;
  }
  if (!Array.isArray(agents)) {
    console.log(`${label} nudge skipped: snapshot ${file} is not a JSON array`);
    return;
  }
  for (const entry of agents) {
    const id = entry?.id;
    if (typeof id !== "string" || id.length === 0) {
      console.log(`${label} nudge skipped malformed entry: ${JSON.stringify(entry)}`);
      continue;
    }
    try {
      await client.sendAgentMessage(id, message, {});
      console.log(`${label} ${id} nudged`);
    } catch (error) {
      console.log(`${label} ${id} failed: ${error?.message ?? error}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const host = process.env.PASEO_NUDGE_URL || args.host;
  const password =
    process.env.PASEO_NUDGE_PASSWORD ||
    (process.env.PASEO_PASSWORD ? process.env.PASEO_PASSWORD : args.password);
  const label = args.snapshot ? "snapshot" : "nudge";

  const client = await connectOrSkip(host, password, label);
  if (!client) {
    return;
  }
  try {
    if (args.snapshot) {
      await runSnapshot(client, args.snapshot, label);
    } else {
      await runNudge(client, args.nudge, args.message, label);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.log(`deploy-nudge failed: ${error?.message ?? error}`);
  process.exit(0);
});
