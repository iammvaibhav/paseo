import type { Logger } from "pino";

import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import {
  supportsDiskTimeline,
  tryReadProviderTimelineFromDisk,
} from "../agent/provider-disk-history.js";
import { hasMissionControlLabels } from "./naming.js";
import { isSameOrDescendantPath } from "../path-utils.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import type { MissionControlFetchOptions } from "./store.js";

// ============================================================================
// Fleet search — "who worked on X?" without spelunking.
//
// Spec: docs/mission-control.md "Fleet search (fleet_search)". One tool,
// tiered inside the daemon, cross-host via peering, results merged:
//
//   Tier 1 — deterministic context (always): substring + fuzzy over what the
//            daemon already holds (agent names/titles/descriptions, launch
//            briefs of loaded timelines, report_status history, workspace and
//            project names/descriptions). Instant, no disk reads.
//   Tier 2 — full-text transcript scan (when tier 1 is thin): bounded scan of
//            stored agent timelines (last 30 days, newest first, capped work
//            per host). This is where a PR URL pasted into a prompt is found.
//   Tier 3 — History Ask (only when deep: true and tiers 1-2 found nothing):
//            falls back to the existing History Ask LLM machinery (an omp
//            agent that reads transcripts on disk and answers with paseo://
//            citations) and maps its matches into the same result shape.
//
// Cross-host: each daemon runs the tiers on its own data (mission_control
// .search RPC); the Commander-host fleet_search tool merges + ranks + caps.
//
// Result row: { host, agentId, name?, title, status?, matchedIn, snippet }.
// matchedIn ranking: identity > brief > reports > transcript.
// ============================================================================

/** Default fleet-wide result cap. */
export const SEARCH_DEFAULT_LIMIT = 20;
/** Hard ceiling for a single fleet_search call (schema-level max 50). */
export const SEARCH_MAX_LIMIT = 50;

// --- Tier 2 caps (documented per spec "capped work per host") -------------
// A full-text transcript scan is the expensive tier: it can read provider
// session files off disk. These caps bound worst-case work per host:
/** Scan only agents with activity within the last 30 days. */
export const SEARCH_TIER2_WINDOW_DAYS = 30;
/** Max stored agents scanned per host, newest-activity first. */
export const SEARCH_TIER2_MAX_AGENTS_PER_HOST = 40;
/** Max timeline items inspected per agent (newest first). */
export const SEARCH_TIER2_MAX_ITEMS_PER_AGENT = 400;
/** Max timeline items inspected per host across all agents. */
export const SEARCH_TIER2_MAX_ITEMS_PER_HOST = 2000;

/**
 * Tier 1 is "thin" (and tier 2 runs) when it yields fewer than this many
 * matches. Spec: "Tier 2 ... (when tier 1 is thin)".
 */
export const SEARCH_TIER1_THIN_THRESHOLD = 5;

/**
 * Tier 3 (History Ask spawn) runs only when tiers 1-2 found nothing
 * ("The Commander asks for deep explicitly when tiers 1-2 fail").
 */
export const SEARCH_TIER3_TIMEOUT_MS = 5 * 60_000;

/** Snippet display cap: the matched line, trimmed. */
const SNIPPET_MAX_CHARS = 180;

/** Label key the app's History Ask agents carry; excluded from fleet search. */
const HISTORY_ASK_LABEL_KEY = "paseo.history-ask";
const HISTORY_ASK_LABEL_VALUE = "1";

export type FleetSearchMatchedIn = "identity" | "brief" | "reports" | "transcript";

export interface FleetSearchMatch {
  /** Host label: "local" for this daemon, peer config name for peers. */
  host: string;
  agentId: string;
  name?: string;
  title: string | null;
  status?: string;
  matchedIn: FleetSearchMatchedIn;
  /** The matched line, trimmed and capped. */
  snippet: string;
}

/** Ranking: identity matches > brief > reports > transcript. */
export function rankFleetSearchMatch(matchedIn: FleetSearchMatchedIn): number {
  switch (matchedIn) {
    case "identity":
      return 4;
    case "brief":
      return 3;
    case "reports":
      return 2;
    case "transcript":
      return 1;
  }
}

export interface FleetSearchTier3Runner {
  /**
   * Run a History Ask agent on this host for the query and return its
   * structured matches (host left empty; the caller stamps it). Null when the
   * host cannot run one (no provider, spawn failure, timeout, no matches).
   */
  run(input: { query: string }): Promise<FleetSearchMatch[] | null>;
}

export interface FleetSearchHostDeps {
  agentManager: Pick<
    AgentManager,
    "getAgent" | "getTimeline" | "fetchTimeline" | "hasTimeline" | "seedTimelineFromItems"
  >;
  agentStorage: Pick<AgentStorage, "list">;
  /** Report_status history (tier 1 "reports"). Absent → reports skipped. */
  missionControlService?: {
    fetchEvents(options?: MissionControlFetchOptions): MissionControlEvent[];
  } | null;
  /** Workspace/project names + descriptions (tier 1 context). */
  workspaceRegistry?: Pick<WorkspaceRegistry, "list"> | null;
  projectRegistry?: Pick<ProjectRegistry, "list"> | null;
  logger: Logger;
  serverId?: string;
  /** Tier 3 History Ask runner. Absent → deep searches skip tier 3. */
  tier3?: FleetSearchTier3Runner | null;
}

export interface FleetSearchHostStats {
  tiersUsed: string[];
  tier1Matches: number;
  tier2ScannedAgents: number;
  tier2ScannedItems: number;
  tier2Matches: number;
  tier3: "ran" | "skipped" | "unavailable";
  durationMs: number;
}

function isSearchableRecord(record: StoredAgentRecord): boolean {
  if (record.internal === true) {
    return false;
  }
  if (hasMissionControlLabels(record.labels)) {
    // Commander/Verifier are machinery, not fleet work.
    return false;
  }
  if (record.labels[HISTORY_ASK_LABEL_KEY] === HISTORY_ASK_LABEL_VALUE) {
    // History Ask agents are ephemeral search agents, hidden everywhere.
    return false;
  }
  return true;
}

// --- Matching ---------------------------------------------------------------

/** Bounded Levenshtein distance; early-exits once the cost exceeds 1. */
function editDistanceWithinOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }
  const a = left;
  const b = right;
  let prev: number[] = [];
  let curr: number[] = [];
  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > 1) {
      return false;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] <= 1;
}

function tokenMatchesFuzzy(token: string, haystack: string): boolean {
  if (haystack.includes(token)) {
    return true;
  }
  // Typo tolerance only for tokens long enough to be distinctive.
  if (token.length < 4) {
    return false;
  }
  const words = haystack.split(/[^a-z0-9]+/).filter((word) => word.length >= 2);
  return words.some((word) => editDistanceWithinOne(token, word));
}

/**
 * Multi-token case-insensitive substring + fuzzy matcher (the deterministic
 * tier-1/tier-2 matcher). Every whitespace-separated token must match the text
 * as a substring or within edit distance 1 of one of its words. Mirrors the
 * History Ask fuzzy convention (packages/app/src/history-ask/fuzzy.ts) plus
 * typo tolerance.
 */
export function matchesSearchQuery(query: string, text: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  const haystack = text.trim().toLowerCase();
  if (!haystack) {
    return false;
  }
  return tokens.every((token) => tokenMatchesFuzzy(token, haystack));
}

function truncateSnippet(line: string): string {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (trimmed.length <= SNIPPET_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

/**
 * The matched line, trimmed. Falls back to the first non-empty line when no
 * single line matches (e.g. the fuzzy hit spans lines).
 */
export function extractSearchSnippet(text: string, query: string): string {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (matchesSearchQuery(query, line)) {
      return truncateSnippet(line);
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return truncateSnippet(line);
    }
  }
  return truncateSnippet(text);
}

// --- Tier 1 -----------------------------------------------------------------

interface Tier1Field {
  text: string;
  matchedIn: FleetSearchMatchedIn;
}

function recordIdentityFields(record: StoredAgentRecord): Tier1Field[] {
  const fields: Tier1Field[] = [];
  if (typeof record.name === "string" && record.name.trim()) {
    fields.push({ text: record.name, matchedIn: "identity" });
  }
  if (typeof record.title === "string" && record.title.trim()) {
    fields.push({ text: record.title, matchedIn: "identity" });
  }
  if (typeof record.shortDescription === "string" && record.shortDescription.trim()) {
    fields.push({ text: record.shortDescription, matchedIn: "identity" });
  }
  return fields;
}

function recordWorkspaceProjectFields(
  record: StoredAgentRecord,
  workspaces: PersistedWorkspaceRecord[],
  projects: PersistedProjectRecord[],
): Tier1Field[] {
  const workspace =
    workspaces.find((candidate) => candidate.workspaceId === record.workspaceId) ??
    workspaces.find(
      (candidate) => !candidate.archivedAt && isSameOrDescendantPath(candidate.cwd, record.cwd),
    );
  if (!workspace) {
    return [];
  }
  const workspaceName = workspace.title?.trim() || workspace.displayName.trim();
  const project = projects.find((candidate) => candidate.projectId === workspace.projectId);
  const fields: Tier1Field[] = [];
  if (workspaceName) {
    fields.push({ text: workspaceName, matchedIn: "identity" });
  }
  if (project) {
    const projectName = project.customName?.trim() || project.displayName.trim();
    if (projectName) {
      fields.push({ text: projectName, matchedIn: "identity" });
    }
    if (project.description?.trim()) {
      fields.push({ text: project.description, matchedIn: "identity" });
    }
  }
  return fields;
}

function recordBriefField(record: StoredAgentRecord, deps: FleetSearchHostDeps): Tier1Field | null {
  // Launch brief = the agent's first user message. Only agents with a loaded
  // timeline are searched here ("what the daemon already holds" — instant);
  // stored prompt bodies are tier 2's job.
  if (!deps.agentManager.hasTimeline(record.id)) {
    return null;
  }
  const timeline = deps.agentManager.getTimeline(record.id);
  for (const item of timeline) {
    if (item.type === "user_message" && item.text.trim()) {
      return { text: item.text, matchedIn: "brief" };
    }
  }
  return null;
}

function reportEventFields(event: MissionControlEvent): Tier1Field[] {
  const fields: Tier1Field[] = [];
  const push = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      fields.push({ text: trimmed, matchedIn: "reports" });
    }
  };
  push(event.headline);
  if (event.detail) {
    push(event.detail);
  }
  for (const proof of event.proof ?? []) {
    if (proof.label) {
      push(proof.label);
    }
    if (proof.url) {
      push(proof.url);
    }
    if (proof.path) {
      push(proof.path);
    }
    if (proof.excerpt) {
      push(proof.excerpt);
    }
  }
  return fields;
}

function recordReportFields(
  record: StoredAgentRecord,
  events: MissionControlEvent[],
): Tier1Field[] {
  const fields: Tier1Field[] = [];
  for (const event of events) {
    if (event.agentId !== record.id || event.source !== "self") {
      continue;
    }
    fields.push(...reportEventFields(event));
  }
  return fields;
}

/**
 * Tier 1: deterministic context over what the daemon already holds. One row
 * per matching agent, keeping the highest-priority match (identity > brief >
 * reports) with its snippet.
 */
export async function searchTier1(
  query: string,
  deps: FleetSearchHostDeps,
): Promise<FleetSearchMatch[]> {
  const records = (await deps.agentStorage.list()).filter(isSearchableRecord);
  const [workspaces, projects, events] = await Promise.all([
    deps.workspaceRegistry?.list() ?? Promise.resolve([]),
    deps.projectRegistry?.list() ?? Promise.resolve([]),
    Promise.resolve(deps.missionControlService?.fetchEvents() ?? []),
  ]);

  const matches: FleetSearchMatch[] = [];
  for (const record of records) {
    const fields: Tier1Field[] = [
      ...recordIdentityFields(record),
      ...recordWorkspaceProjectFields(record, workspaces, projects),
    ];
    const brief = recordBriefField(record, deps);
    if (brief) {
      fields.push(brief);
    }
    fields.push(...recordReportFields(record, events));

    let match: FleetSearchMatch | null = null;
    for (const field of fields) {
      if (matchesSearchQuery(query, field.text)) {
        match = {
          host: "local",
          agentId: record.id,
          ...(typeof record.name === "string" ? { name: record.name } : {}),
          title: record.title ?? null,
          status: resolveRecordStatus(record, deps),
          matchedIn: field.matchedIn,
          snippet: extractSearchSnippet(field.text, query),
        };
        break;
      }
    }
    if (match) {
      matches.push(match);
    }
  }
  return matches;
}

function resolveRecordStatus(
  record: StoredAgentRecord,
  deps: FleetSearchHostDeps,
): string | undefined {
  const live = deps.agentManager.getAgent(record.id);
  if (live?.lifecycle) {
    return live.lifecycle;
  }
  return record.lastStatus;
}

// --- Tier 2 -----------------------------------------------------------------

function timelineItemTexts(item: AgentTimelineItem): string[] {
  switch (item.type) {
    case "user_message":
      return item.text ? [item.text] : [];
    case "assistant_message":
      return item.text ? [item.text] : [];
    case "error":
      return item.message ? [item.message] : [];
    case "tool_call": {
      const detail = item.detail as { type?: string; command?: unknown } | null;
      if (detail && typeof detail === "object" && typeof detail.command === "string") {
        return [detail.command];
      }
      return [];
    }
    default:
      return [];
  }
}

async function loadTimelineRows(
  record: StoredAgentRecord,
  deps: FleetSearchHostDeps,
): Promise<AgentTimelineRow[] | null> {
  if (deps.agentManager.hasTimeline(record.id)) {
    return deps.agentManager.fetchTimeline(record.id, { direction: "tail", limit: 0 }).rows;
  }
  const sessionId = record.persistence?.sessionId;
  if (sessionId && supportsDiskTimeline(record.provider)) {
    const diskItems = await tryReadProviderTimelineFromDisk(
      {
        provider: record.provider,
        cwd: record.cwd,
        sessionId,
        ...(typeof record.persistence?.nativeHandle === "string"
          ? { nativeHandle: record.persistence.nativeHandle }
          : {}),
      },
      { logger: deps.logger },
    );
    if (diskItems && diskItems.length > 0) {
      deps.agentManager.seedTimelineFromItems(record.id, diskItems);
      return deps.agentManager.fetchTimeline(record.id, { direction: "tail", limit: 0 }).rows;
    }
  }
  return null;
}

/**
 * Tier 2: bounded full-text scan of stored agent timelines — last 30 days,
 * newest activity first, hard work caps per host (see SEARCH_TIER2_* above).
 * Runs when tier 1 is thin; this is where a PR URL pasted into a prompt is
 * found.
 */
export async function searchTier2(
  query: string,
  deps: FleetSearchHostDeps,
): Promise<{ matches: FleetSearchMatch[]; scannedAgents: number; scannedItems: number }> {
  const cutoffMs = Date.now() - SEARCH_TIER2_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const records = (await deps.agentStorage.list())
    .filter(isSearchableRecord)
    .filter((record) => {
      const updatedAt = Date.parse(record.updatedAt);
      return !Number.isNaN(updatedAt) && updatedAt >= cutoffMs;
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, SEARCH_TIER2_MAX_AGENTS_PER_HOST);

  const matches: FleetSearchMatch[] = [];
  let scannedAgents = 0;
  let scannedItems = 0;

  for (const record of records) {
    if (scannedItems >= SEARCH_TIER2_MAX_ITEMS_PER_HOST) {
      break;
    }
    const rows = await loadTimelineRows(record, deps);
    if (!rows) {
      continue;
    }
    scannedAgents++;
    let itemsScannedForAgent = 0;
    let found = false;
    for (const row of rows) {
      if (row.timestamp) {
        const rowMs = Date.parse(row.timestamp);
        if (!Number.isNaN(rowMs) && rowMs < cutoffMs) {
          break; // tail is newest-first; nothing older can match the window.
        }
      }
      if (itemsScannedForAgent >= SEARCH_TIER2_MAX_ITEMS_PER_AGENT) {
        break;
      }
      if (scannedItems >= SEARCH_TIER2_MAX_ITEMS_PER_HOST) {
        break;
      }
      itemsScannedForAgent++;
      scannedItems++;
      for (const text of timelineItemTexts(row.item)) {
        if (matchesSearchQuery(query, text)) {
          matches.push({
            host: "local",
            agentId: record.id,
            ...(typeof record.name === "string" ? { name: record.name } : {}),
            title: record.title ?? null,
            status: resolveRecordStatus(record, deps),
            matchedIn: "transcript",
            snippet: extractSearchSnippet(text, query),
          });
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
  }

  return { matches, scannedAgents, scannedItems };
}

// --- Tier 3 (History Ask) ---------------------------------------------------

/**
 * Server-side History Ask brief: instructs an omp agent to read stored agent
 * transcripts on this host and answer with paseo:// citations. Mirrors the
 * app's History Ask brief contract (packages/app/src/history-ask/brief.ts) —
 * same citation shape, same "never invent sessions" rule — so the link parser
 * below and the app's history row opener agree.
 */
export function buildFleetHistoryAskBrief(query: string, serverId: string): string {
  return [
    "You are a fleet history search agent. Find which past agent sessions match the question by reading transcripts stored on this host, then answer with clickable citations.",
    "",
    `Question: ${query.trim()}`,
    "",
    "Search:",
    "1. Paseo agent catalogs under `~/.paseo/agents/{sanitized-cwd}/` (sanitize the cwd by stripping the FS root and replacing path separators with `-`). Scan titles, `updatedAt`, and stored JSON for matching text.",
    "2. Open matching transcripts (follow `persistence` / native handles into OMP / Claude / Codex / Grok session files). Skim log and message text for answers — do not invent sessions that are not on disk.",
    "",
    "Answer with clickable citations (required):",
    "- For every matching session, emit exactly one markdown link:",
    "  `[Session title](paseo://h/<urlencoded-serverId>/agent/<urlencoded-agentId>)`",
    `- This host's serverId is \`${serverId}\`.`,
    "- Under each link: **cwd** + a short **snippet** of the matched text.",
    "- Never invent agent ids. If nothing matches, say so clearly.",
  ].join("\n");
}

const PASE0_LINK_PATTERN = /\[([^\]]*)\]\((paseo:\/\/[^)\s]+)\)/g;

/**
 * Map a History Ask agent's answer (markdown `[Title](paseo://h/…/agent/…)`
 * citations with cwd/snippet lines underneath) into fleet search rows. Rows
 * come back host-less; the caller stamps the host. Pure and deterministic so
 * tier 3's output shape is testable without spawning an agent.
 */
export function parseHistoryAskMatches(text: string, _serverId: string): FleetSearchMatch[] {
  const matches: FleetSearchMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    PASE0_LINK_PATTERN.lastIndex = 0;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = PASE0_LINK_PATTERN.exec(line)) !== null) {
      const [, label, url] = linkMatch;
      const target = parseAgentDeepLink(url);
      if (!target) {
        continue;
      }
      // Snippet: this line plus the cwd/snippet lines that follow until the
      // next link or a blank line.
      const snippetLines = [line.trim()];
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next]!.trim();
        if (!candidate || candidate.includes("paseo://h/")) {
          break;
        }
        snippetLines.push(candidate);
        if (snippetLines.length >= 3) {
          break;
        }
      }
      matches.push({
        host: "",
        agentId: target.agentId,
        title: label.trim() || null,
        matchedIn: "transcript",
        snippet: truncateSnippet(snippetLines.join(" ")),
      });
    }
  }
  return matches;
}

// --- Merge + rank (fleet-wide) ----------------------------------------------

/**
 * Merge per-host result sets: one row per (host, agentId) keeping the
 * highest-ranked match (identity > brief > reports > transcript), sorted by
 * rank then host then agentId, capped at `limit`. Pure so the fleet merge is
 * testable against fake per-host results.
 */
export function mergeFleetSearchMatches(
  matches: readonly FleetSearchMatch[],
  limit: number = SEARCH_DEFAULT_LIMIT,
): FleetSearchMatch[] {
  const bestByKey = new Map<string, FleetSearchMatch>();
  for (const match of matches) {
    const key = `${match.host}|${match.agentId}`;
    const existing = bestByKey.get(key);
    if (
      !existing ||
      rankFleetSearchMatch(match.matchedIn) > rankFleetSearchMatch(existing.matchedIn)
    ) {
      bestByKey.set(key, match);
    }
  }
  const merged = [...bestByKey.values()];
  merged.sort((a, b) => {
    const rankDelta = rankFleetSearchMatch(b.matchedIn) - rankFleetSearchMatch(a.matchedIn);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    const hostDelta = a.host.localeCompare(b.host);
    if (hostDelta !== 0) {
      return hostDelta;
    }
    return a.agentId.localeCompare(b.agentId);
  });
  return merged.slice(0, limit);
}

// --- Host runner ------------------------------------------------------------

/**
 * Run the full tiered search on this daemon's own data (local tool path and
 * the mission_control.search peer RPC path). Rows are stamped host "local";
 * the Commander-host fleet_search tool re-stamps peer rows and merges.
 */
export async function runFleetSearchHost(input: {
  query: string;
  limit?: number;
  deep?: boolean;
  deps: FleetSearchHostDeps;
}): Promise<FleetSearchMatch[]> {
  const { query, deps } = input;
  const limit = Math.min(
    Math.max(1, Math.floor(input.limit ?? SEARCH_DEFAULT_LIMIT)),
    SEARCH_MAX_LIMIT,
  );
  const deep = input.deep === true;
  const searchLogger = deps.logger.child({ module: "mission-control", component: "search" });
  const startedAt = Date.now();

  const tier1 = await searchTier1(query, deps);
  const stats: FleetSearchHostStats = {
    tiersUsed: ["tier1"],
    tier1Matches: tier1.length,
    tier2ScannedAgents: 0,
    tier2ScannedItems: 0,
    tier2Matches: 0,
    tier3: deep ? "unavailable" : "skipped",
    durationMs: 0,
  };

  let result: FleetSearchMatch[] = [...tier1];

  if (tier1.length < SEARCH_TIER1_THIN_THRESHOLD) {
    const tier2 = await searchTier2(query, deps);
    stats.tiersUsed.push("tier2");
    stats.tier2ScannedAgents = tier2.scannedAgents;
    stats.tier2ScannedItems = tier2.scannedItems;
    stats.tier2Matches = tier2.matches.length;
    result = mergeFleetSearchMatches([...result, ...tier2.matches], limit);
  }

  if (deep && tier1.length + stats.tier2Matches === 0) {
    if (deps.tier3) {
      try {
        const tier3Matches = (await deps.tier3.run({ query })) ?? [];
        stats.tier3 = "ran";
        result = mergeFleetSearchMatches(
          [...result, ...tier3Matches.map((match) => Object.assign({}, match, { host: "local" }))],
          limit,
        );
      } catch (error) {
        stats.tier3 = "ran";
        searchLogger.warn({ err: error }, "mission_control.fleet_search.tier3_failed");
      }
    } else {
      stats.tier3 = "unavailable";
    }
  } else if (deep) {
    stats.tier3 = "skipped";
  }

  stats.durationMs = Date.now() - startedAt;
  searchLogger.info(
    {
      query,
      deep,
      limit,
      tiersUsed: stats.tiersUsed.join(","),
      tier1Matches: stats.tier1Matches,
      tier2ScannedAgents: stats.tier2ScannedAgents,
      tier2ScannedItems: stats.tier2ScannedItems,
      tier2Matches: stats.tier2Matches,
      tier3: stats.tier3,
      matches: result.length,
      durationMs: stats.durationMs,
    },
    "mission_control.fleet_search.host",
  );

  return result;
}
