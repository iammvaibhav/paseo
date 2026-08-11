#!/usr/bin/env node
/**
 * Mission Control naming backfill (one-time, via omp scout).
 * docs/mission-control.md → "Naming backfill".
 *
 * Runs against ONE daemon (one host) and does three things:
 *
 *   1. Agent identity: reads agents missing name/title/description or whose
 *      title equals the deterministic first-prompt derivation (auto-generated;
 *      user-set titles are never touched), drives ONE omp one-shot
 *      (`omp -p --no-tools --model <model>`) to produce names/titles/
 *      descriptions in bulk JSON, and applies them via the existing
 *      `update_agent_request` RPC (name/title/shortDescription fields).
 *      The naming theme comes from the central Mission Control config
 *      (`mission_control.config.get` → config.namingTheme) unless overridden.
 *   2. Workspace rename proposals: the deterministic eligibility pass picks
 *      workspaces with no user title whose derived name is a branch/dir slug
 *      (never system/home workspaces like `<paseo-system>`); the SAME omp
 *      one-shot proposes a new descriptive name (max 5 words) per workspace,
 *      using its agents' titles+descriptions as context. The script emits ONE
 *      Mission Control proposal-style card (kind "proposal", origin commander,
 *      classification normal) listing the 'old -> new' lines. NEVER auto-applies.
 *   3. `--apply <approved.json>` applies an approved rename list via the
 *      existing `workspace.title.set.request` RPC (manual step; the card is
 *      advisory only).
 *
 * Usage:
 *   node --import tsx scripts/mc-backfill.mjs \
 *     --host 127.0.0.1:6768 --password <pw> [--dry-run] [--report report.md] [--apply approved.json]
 *
 * Options:
 *   --host <host[:port]>     daemon endpoint (default 127.0.0.1:6768)
 *   --password <pw>          daemon password (default $PASEO_PASSWORD)
 *   --dry-run                print the plan; apply nothing
 *   --report <path.md>       write a human-reviewable old→new markdown report
 *   --apply <file.json>      apply approved workspace renames
 *                           [{ "workspaceId": "...", "newName": "..." }]
 *   --model <model>          omp one-shot model (default @smol)
 *   --theme <theme>          naming theme override (default: central config)
 *   --no-agents              skip the agent identity pass
 *   --no-proposals           skip the workspace proposal pass
 *   --prompt-only            print the one-shot prompt and exit
 *   --target-agent <id>      proposal card target (default: the Commander)
 *   --timeout-ms <n>         omp one-shot timeout (default 300000)
 *
 * Safe by construction: agent writes only fill MISSING identity fields (and
 * replace titles whose current value equals the deterministic derivation —
 * user-set titles are never touched), the proposal card never auto-applies,
 * and workspace renames require --apply. The markdown report documents the
 * whole plan; rejected rows are simply deleted before applying.
 */

import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { WebSocket } from "ws";
import {
  buildBackfillMarkdownReport,
  buildBackfillPrompt,
  buildBackfillReportAgentChanges,
  formatRenameProposalMessage,
  parseBackfillResponse,
  resolveIdentityUpdates,
  resolveWorkspaceRenameProposals,
  selectBackfillCandidates,
  selectWorkspaceProposalCandidates,
} from "../packages/server/src/server/mission-control/naming-backfill.js";

const require = createRequire(import.meta.url);
// Advertise a real client version so the daemon does not treat this CLI as a
// legacy client (which hides non-legacy providers and returns zero agents).
const CLIENT_APP_VERSION = require("../packages/client/package.json").version;

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
      case "report":
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
    appVersion: CLIENT_APP_VERSION,
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

const MAX_EVENTS_FOR_HEADLINES = 2000;

/**
 * Prompt enrichment (spec "Naming backfill"): per agent, the first user
 * prompt excerpt (metadata prompt index — never a transcript) and the last
 * report_status headline (Mission Control events store). One bulk events
 * fetch + one prompt-index peek per agent; the omp one-shot stays a single
 * bulk call per host. Enrichment runs BEFORE candidate selection because
 * title-replacement eligibility (complete agents with auto-derived titles)
 * depends on the first prompt.
 */
async function enrichAgentsWithActivity(client, agents) {
  if (agents.length === 0) {
    return agents;
  }
  const [events, promptIndexes] = await Promise.all([
    client.missionControlEventsFetch({ limit: MAX_EVENTS_FOR_HEADLINES }).catch(() => null),
    Promise.all(
      agents.map((agent) => client.listAgentTimelinePrompts(agent.agentId).catch(() => null)),
    ),
  ]);
  // Events come back newest-first; the first self-report row per agent is its
  // latest report_status headline.
  const headlineByAgent = new Map();
  for (const event of events?.events ?? []) {
    if (event.source !== "self" || !event.headline) {
      continue;
    }
    if (!headlineByAgent.has(event.agentId)) {
      headlineByAgent.set(event.agentId, event.headline);
    }
  }
  return agents.map((agent, index) => ({
    ...agent,
    firstPrompt: promptIndexes[index]?.prompts?.[0]?.preview ?? null,
    lastReportHeadline: headlineByAgent.get(agent.agentId) ?? null,
  }));
}

/** Workspace → agents join by workspaceId, falling back to cwd containment. */
function agentsByWorkspaceId(workspaces, agents) {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, []]));
  for (const agent of agents) {
    const direct = agent.workspaceId ? byId.get(agent.workspaceId) : null;
    if (direct) {
      direct.push(agent);
      continue;
    }
    const dir = agent.cwd;
    if (!dir) {
      continue;
    }
    for (const workspace of workspaces) {
      const root = workspace.workspaceDirectory ?? workspace.projectRootPath;
      if (root && (dir === root || dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`))) {
        byId.get(workspace.id).push(agent);
        break;
      }
    }
  }
  return byId;
}

async function fetchBackfillInputs(client, args) {
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
      workspaceId: agent.workspaceId,
      archivedAt: agent.archivedAt ?? null,
    };
  });
  const workspaces = workspacesPayload.entries ?? [];
  const namingTheme = args.theme ?? configPayload?.config?.namingTheme ?? "mixed";
  return { agents, workspaces, namingTheme };
}

async function applyBackfillResults(client, args, hostLabel, updates, proposals) {
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

async function runBackfillPass(client, args, hostLabel) {
  const { agents, workspaces, namingTheme } = await fetchBackfillInputs(client, args);

  const workspaceAgents = agentsByWorkspaceId(workspaces, agents);
  const candidates = args.noAgents
    ? []
    : selectBackfillCandidates(await enrichAgentsWithActivity(client, agents));
  const workspaceCandidates = args.noProposals
    ? []
    : selectWorkspaceProposalCandidates(
        workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          title: workspace.title ?? null,
          cwd: workspace.workspaceDirectory ?? workspace.projectRootPath,
          agents: (workspaceAgents.get(workspace.id) ?? []).map((agent) => ({
            title: agent.title ?? null,
            shortDescription: agent.shortDescription ?? null,
          })),
        })),
        { homeDir: homedir() },
      );

  if (candidates.length === 0 && workspaceCandidates.length === 0) {
    console.log("No agent or workspace candidates to backfill on this host.");
    return;
  }

  const prompt = buildBackfillPrompt({
    hostLabel,
    namingTheme,
    candidates: candidates.slice(0, args.maxCandidates),
    workspaceCandidates,
  });
  if (args.promptOnly) {
    process.stdout.write(`${prompt}\n`);
    return;
  }

  const output = await runOmpOneShot(prompt, args.model, args.timeoutMs);
  const responses = parseBackfillResponse(output);
  if (!responses) {
    console.error("Failed to parse the omp one-shot response. Raw output was:\n");
    console.error(output.slice(0, 4000));
    process.exit(3);
  }
  const updates = resolveIdentityUpdates({ candidates, responses: responses.agents });
  const proposals = resolveWorkspaceRenameProposals(workspaceCandidates, responses.workspaces);

  if (args.report) {
    const report = buildBackfillMarkdownReport({
      hostLabel,
      namingTheme,
      generatedAt: new Date().toISOString(),
      agentChanges: buildBackfillReportAgentChanges(candidates, updates),
      workspaceProposals: proposals,
    });
    await writeFile(args.report, report, "utf8");
    console.log(`Wrote backfill report to ${args.report}`);
  }

  console.log(
    JSON.stringify(
      {
        host: args.host,
        namingTheme,
        agentCandidates: candidates.length,
        plannedAgentUpdates: updates,
        workspaceCandidates: workspaceCandidates.length,
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

  await applyBackfillResults(client, args, hostLabel, updates, proposals);
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
