#!/usr/bin/env node
/**
 * Dormant-agent health check.
 *
 * Answers one question per running agent: is it actually working, or is it
 * parked? The signature of a parked agent is specific — a run in flight, NO
 * tool call in flight, and no timeline output for a long time. An agent sitting
 * inside a declared tool call (a long build, `hub wait`) is working, not stalled,
 * so it is never flagged.
 *
 * Reads agent records and their omp session transcripts directly, so it works
 * without a healthy daemon and without an RPC round-trip.
 *
 * Usage:
 *   node scripts/stall-check.mjs                # this host
 *   node scripts/stall-check.mjs --fleet        # all hosts over ssh
 *   node scripts/stall-check.mjs --threshold 180
 *   node scripts/stall-check.mjs --recover      # interrupt + resume anything dormant
 *   node scripts/stall-check.mjs --json
 *
 * Exit code is 1 when any agent is dormant, so it can gate a cron or alert.
 *
 * Recovery sends a prompt, which carries interrupt semantics: it cancels the
 * parked run and starts a fresh one. That is the only action known to clear this
 * state — see docs/observability.md for why nothing inside omp can.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FLEET_HOSTS = (process.env.PASEO_FLEET_HOSTS || "blrofc3,iammvaibhav")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

function parseArgs(argv) {
  const args = {
    threshold: Number(process.env.STALL_CHECK_THRESHOLD) || 300,
    fleet: false,
    recover: process.env.STALL_CHECK_RECOVER === "1",
    json: process.env.STALL_CHECK_JSON === "1",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fleet") args.fleet = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--recover") args.recover = true;
    else if (argv[i] === "--threshold") args.threshold = Number(argv[++i]);
  }
  return args;
}

/** Clear a parked run: a prompt replaces the in-flight run and resumes work. */
function recoverAgent(id) {
  try {
    execFileSync(
      "paseo",
      [
        "agent",
        "send",
        id,
        "--no-wait",
        "--prompt",
        "You appear to have stalled with no tool running. Continue from where you left off.",
      ],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return "recovered";
  } catch (error) {
    return `recovery failed: ${String(error.message).slice(0, 60)}`;
  }
}
/** Walk one omp session transcript for last-activity time and unmatched tool calls. */
function inspectSession(sessionFile) {
  let lastTs;
  let started = new Set();
  let ended = new Set();
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.timestamp) lastTs = row.timestamp;
    // A turn boundary closes every open tool call. A tool cannot still be
    // executing once the model has produced its next message, and an aborted
    // turn never writes the tool's result row — without this, one abort leaves
    // a permanent ghost "in flight" that masks a genuinely parked agent.
    if (row.message?.role === "assistant") {
      started = new Set();
      ended = new Set();
    }
    if (row.type === "custom" && row.customType === "tool_execution_start") {
      const id = row.data?.toolCallId;
      if (id) started.add(id);
    }
    if (row.message?.role === "toolResult" && row.message.toolCallId) {
      ended.add(row.message.toolCallId);
    }
  }
  for (const id of ended) started.delete(id);
  return { lastTs, toolsInFlight: started.size };
}

/** Verdict for one agent. A declared tool in flight always means healthy. */
function classify(toolsInFlight, ageSeconds, threshold) {
  if (toolsInFlight > 0) return "working (in tool)";
  return ageSeconds > threshold ? "DORMANT" : "ok";
}

function collectLocal(threshold) {
  const root = join(homedir(), ".paseo", "agents");
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith(".json")) continue;
      let record;
      try {
        record = JSON.parse(readFileSync(join(dirPath, file), "utf8"));
      } catch {
        continue;
      }
      if (record.lastStatus !== "running") continue;
      const sessionFile = record.persistence?.nativeHandle;
      const entry = {
        id: String(record.id || "?").slice(0, 8),
        title: String(record.title || "").slice(0, 34),
        model: record.runtimeInfo?.model || "?",
        ageSeconds: null,
        toolsInFlight: null,
        verdict: "unknown",
      };
      if (!sessionFile || !existsSync(sessionFile)) {
        entry.verdict = "no-session-file";
        out.push(entry);
        continue;
      }
      const { lastTs, toolsInFlight } = inspectSession(sessionFile);
      if (!lastTs) {
        entry.verdict = "empty-transcript";
        out.push(entry);
        continue;
      }
      entry.ageSeconds = Math.round((Date.now() - Date.parse(lastTs)) / 1000);
      entry.toolsInFlight = toolsInFlight;
      // A tool in flight means the agent is legitimately working, however long
      // it takes. Only silence with nothing in flight is a park.
      entry.verdict = classify(toolsInFlight, entry.ageSeconds, threshold);
      out.push(entry);
    }
  }
  return out.sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1));
}

function collectRemote(host, threshold, recover) {
  const script = readFileSync(new URL(import.meta.url), "utf8");
  try {
    // The script travels on stdin so no shell quoting is involved, and the
    // remote reads its options from the environment instead of argv. node is
    // resolved on the remote because hosts disagree about where it lives and
    // a non-interactive login shell does not always have it on PATH
    // (blrofc3: ~/.local/bin, iammvaibhav: nvm).
    const remote =
      'NODE=$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); ' +
      `[ -n "$NODE" ] || { echo "node not found on ${host}" >&2; exit 127; }; ` +
      `STALL_CHECK_JSON=1 STALL_CHECK_THRESHOLD=${threshold} STALL_CHECK_RECOVER=${recover ? 1 : 0} "$NODE" --input-type=module`;
    const stdout = execFileSync("ssh", ["-o", "ConnectTimeout=8", host, `bash -lc '${remote}'`], {
      encoding: "utf8",
      input: script,
      timeout: 60_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const reason = String(error.stderr || error.message)
      .split("\n")
      .find((l) => l.trim())
      ?.slice(0, 70);
    return [{ id: "-", title: reason || "ssh failed", verdict: "unreachable", unreachable: true }];
  }
}

const args = parseArgs(process.argv.slice(2));
const results = { local: collectLocal(args.threshold) };
// Each host recovers its own agents: `paseo agent send` needs that host's daemon.
if (args.recover) {
  for (const entry of results.local) {
    if (entry.verdict === "DORMANT") entry.recovery = recoverAgent(entry.id);
  }
}
if (args.fleet) {
  for (const host of FLEET_HOSTS) results[host] = collectRemote(host, args.threshold, args.recover);
}

if (args.json) {
  // Remote invocations read this back; keep it a bare array for the local host.
  console.log(JSON.stringify(args.fleet ? results : results.local));
  process.exit(0);
}

let dormant = 0;
for (const [host, entries] of Object.entries(results)) {
  const unreachable = entries.find((e) => e.unreachable);
  if (unreachable) {
    console.log(`\n=== ${host} — unreachable: ${unreachable.title}`);
    continue;
  }
  console.log(`\n=== ${host} — ${entries.length} running agent(s)`);
  if (entries.length === 0) continue;
  console.log(
    `${"age".padStart(9)} ${"tools".padStart(5)}  ${"id".padEnd(8)} ${"title".padEnd(34)} verdict`,
  );
  for (const e of entries) {
    if (e.verdict === "DORMANT") dormant++;
    const age = e.ageSeconds == null ? "-" : `${e.ageSeconds}s`;
    console.log(
      `${age.padStart(9)} ${String(e.toolsInFlight ?? "-").padStart(5)}  ${e.id.padEnd(8)} ${e.title.padEnd(34)} ${e.verdict}${e.recovery ? ` [${e.recovery}]` : ""}${e.verdict === "DORMANT" ? `  (${e.model})` : ""}`,
    );
  }
}
console.log(
  dormant > 0
    ? `\n${dormant} dormant agent(s) — recover with: paseo agent send <id> "continue"  (or re-run with --recover)`
    : "\nNo dormant agents.",
);
process.exit(dormant > 0 ? 1 : 0);
