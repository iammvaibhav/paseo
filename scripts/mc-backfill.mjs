#!/usr/bin/env node
/**
 * Mission Control naming backfill (one-time, via omp scout).
 * docs/mission-control.md → "Naming backfill".
 *
 * Runs against ONE daemon (one host) and does three things:
 *
 *   1. Agent identity: reads agents missing name/title/description (idempotent
 *      filter — complete agents are never touched), drives ONE omp one-shot
 *      (`omp -p --no-tools --model <model>`) to produce names/titles/
 *      descriptions in bulk JSON, and applies them via the existing
 *      `update_agent_request` RPC (name/title/shortDescription fields).
 *      The naming theme comes from the central Mission Control config
 *      (`mission_control.config.get` → config.namingTheme) unless overridden.
 *   2. Workspace rename proposals: computes old→new proposals (max 5 words,
 *      descriptive) ONLY for workspaces whose title is a derived default
 *      (branch/dir slug), and emits ONE Mission Control proposal-style card
 *      (kind "proposal", origin commander, classification normal) listing the
 *      'old -> new' lines. NEVER auto-applies.
 *   3. `--apply <approved.json>` applies an approved rename list via the
 *      existing `workspace.title.set.request` RPC (manual step; the card is
 *      advisory only).
 *
 * Usage:
 *   node --import tsx scripts/mc-backfill.mjs \
 *     --host 127.0.0.1:6768 --password <pw> [--dry-run] [--apply approved.json]
 *
 * Options:
 *   --host <host[:port]>     daemon endpoint (default 127.0.0.1:6768)
 *   --password <pw>          daemon password (default $PASEO_PASSWORD)
 *   --dry-run                print the plan; apply nothing
 *   --apply <file.json>      apply approved workspace renames
 *                           [{ "workspaceId": "...", "newName": "..." }]
 *   --model <model>          omp one-shot model (default @smol)
 *   --theme <theme>          naming theme override (default: central config)
 *   --no-agents              skip the agent identity pass
 *   --no-proposals           skip the workspace proposal card
 *   --prompt-only            print the one-shot prompt and exit
 *   --target-agent <id>      proposal card target (default: the Commander)
 *   --timeout-ms <n>         omp one-shot timeout (default 300000)
 *
 * Safe by construction: agent writes only fill MISSING identity fields, the
 * proposal card never auto-applies, and workspace renames require --apply.
 */

import { DaemonClient } from "@getpaseo/client";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import {
  buildBackfillPrompt,
  buildWorkspaceRenameProposals,
  formatRenameProposalMessage,
  parseBackfillResponse,
  resolveIdentityUpdates,
  selectBackfillCandidates,
} from "../packages/server/src/server/mission-control/naming-backfill.js";

const DEFAULT_HOST = "127.0.0.1:6768";
const DEFAULT_MODEL = "@smol";
const DEFAULT_OMP_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CANDIDATES = 100;

function kebabToCamel(key) {
  return key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  const args = {
    host: DEFAULT_HOST,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_OMP_TIMEOUT_MS,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    dryRun: false,
    noAgents: false,
    noProposals: false,
    promptOnly: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) {
      continue;
    }
    const key = kebabToCamel(part.slice(2));
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    switch (key) {
      case "dryRun":
      case "noAgents":
      case "noProposals":
      case "promptOnly":
        args[key] = true;
        break;
      case "host":
      case "password":
      case "apply":
      case "model":
      case "theme":
      case "targetAgent":
      case "hostLabel":
      case "timeoutMs":
      case "maxCandidates":
        if (!hasValue) {
          console.error(`--${part.slice(2)} requires a value`);
          process.exit(2);
        }
        args[key] = next;
        i += 1;
        break;
      default:
        console.error(`Unknown option: --${part.slice(2)}`);
        process.exit(2);
    }
  }
  args.timeoutMs = Number(args.timeoutMs);
  args.maxCandidates = Number(args.maxCandidates);
  return args;
}

function createClient(host, password) {
  const url = /^wss?:\/\//.test(host) ? host : `ws://${host}/ws`;
  return new DaemonClient({
    url,
    clientId: `mc-backfill-${process.pid}`,
    clientType: "cli",
    appVersion: "mc-backfill",
    password,
    connectTimeoutMs: 15_000,
    webSocketFactory: (targetUrl, options) =>
      new WebSocket(targetUrl, options?.protocols, { headers: options?.headers }),
    reconnect: { enabled: false },
  });
}

function runOmpOneShot(prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("omp", ["-p", "--no-tools", "--model", model, prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`omp one-shot timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`omp one-shot exited ${code}: ${stderr.slice(-400) || "(no stderr)"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function applyApprovedRenames(client, applyPath) {
  let approved;
  try {
    approved = JSON.parse(await readFile(applyPath, "utf8"));
  } catch (error) {
    console.error(`--apply file is not valid JSON (${applyPath}): ${error.message}`);
    process.exit(2);
  }
  if (!Array.isArray(approved)) {
    console.error("--apply file must be a JSON array of { workspaceId, newName }");
    process.exit(2);
  }
  for (const entry of approved) {
    if (typeof entry?.workspaceId !== "string" || typeof entry?.newName !== "string") {
      console.error(`Invalid apply entry: ${JSON.stringify(entry)}`);
      process.exit(2);
    }
  }
  for (const entry of approved) {
    await client.setWorkspaceTitle(entry.workspaceId, entry.newName);
    console.log(`renamed workspace ${entry.workspaceId} -> ${entry.newName}`);
  }
  console.log(`Applied ${approved.length} workspace rename(s).`);
}

async function runBackfillPass(client, args, hostLabel) {
  const [agentsPayload, workspacesPayload, configPayload] = await Promise.all([
    client.fetchAgents({}),
    client.fetchWorkspaces({}),
    client.missionControlConfigGet().catch(() => null),
  ]);
  const agents = (agentsPayload.entries ?? []).map((entry) => {
    const agent = entry.agent;
    return {
      agentId: agent.id,
      name: agent.name ?? null,
      title: agent.title ?? null,
      shortDescription: agent.shortDescription ?? null,
      labels: agent.labels ?? {},
      cwd: agent.cwd,
      archivedAt: agent.archivedAt ?? null,
    };
  });
  const workspaces = workspacesPayload.entries ?? [];
  const namingTheme = args.theme ?? configPayload?.config?.namingTheme ?? "mixed";

  const proposals = args.noProposals
    ? []
    : buildWorkspaceRenameProposals(
        workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          title: workspace.title ?? null,
        })),
      );

  const candidates = args.noAgents ? [] : selectBackfillCandidates(agents);
  const updates = await runAgentIdentityPass(client, args, hostLabel, namingTheme, candidates);
  if (args.promptOnly) {
    // The prompt was printed (or "no candidates" logged) inside the pass.
    return;
  }

  console.log(
    JSON.stringify(
      {
        host: args.host,
        namingTheme,
        agentCandidates: candidates.length,
        plannedAgentUpdates: updates,
        workspaceProposals: proposals,
      },
      null,
      2,
    ),
  );

  if (args.dryRun) {
    console.log("\nDRY RUN: nothing was applied.");
    return;
  }

  for (const update of updates) {
    await client.updateAgent(update.agentId, {
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.shortDescription !== undefined
        ? { shortDescription: update.shortDescription }
        : {}),
    });
    console.log(`applied agent identity ${update.agentId}: ${JSON.stringify(update)}`);
  }
  console.log(`Applied identity to ${updates.length} agent(s).`);

  if (proposals.length > 0) {
    const result = await client.missionControlProposalsCreate({
      message: formatRenameProposalMessage(proposals, hostLabel),
      reason: `Workspace rename proposals (${proposals.length})`,
      ...(args.targetAgent ? { targetAgentId: args.targetAgent } : {}),
    });
    if (!result.ok) {
      throw new Error(result.error ?? "proposal card creation failed");
    }
    console.log(
      `Emitted Mission Control proposal card ${result.proposalId} with ${proposals.length} workspace rename proposal(s).`,
    );
  }
}

async function runAgentIdentityPass(client, args, hostLabel, namingTheme, candidates) {
  if (candidates.length === 0) {
    if (args.promptOnly) {
      console.log("No agent candidates to backfill on this host.");
    }
    return [];
  }
  const prompt = buildBackfillPrompt({
    hostLabel,
    namingTheme,
    candidates: candidates.slice(0, args.maxCandidates),
  });
  if (args.promptOnly) {
    process.stdout.write(`${prompt}\n`);
    return [];
  }
  const output = await runOmpOneShot(prompt, args.model, args.timeoutMs);
  const responses = parseBackfillResponse(output);
  if (!responses) {
    console.error("Failed to parse the omp one-shot response. Raw output was:\n");
    console.error(output.slice(0, 4000));
    process.exit(3);
  }
  return resolveIdentityUpdates({ candidates, responses });
}

async function main() {
  const args = parseArgs(process.argv);
  const password = args.password ?? process.env.PASEO_PASSWORD;
  const hostLabel = args.hostLabel ?? args.host;

  const client = createClient(args.host, password);
  try {
    await client.connect();
  } catch (error) {
    console.error(`Cannot connect to daemon at ${args.host}: ${error.message}`);
    process.exit(2);
  }

  try {
    if (args.apply) {
      await applyApprovedRenames(client, args.apply);
      return;
    }
    await runBackfillPass(client, args, hostLabel);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`mc-backfill failed: ${error?.message ?? error}`);
  process.exit(1);
});
