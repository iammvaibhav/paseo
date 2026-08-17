/**
 * Mission Control lifecycle-bucket audit (spec 01, "Audit script").
 *
 * Read-only diagnostic. Without starting a daemon, this script inspects a
 * paseo home directly — agent records under agents/, mission-control
 * review-state.json, proposals.jsonl, stop-origins.json, events.jsonl — and
 * prints, for every stored agent, the three legacy bucket derivations versus
 * the new canonical bucket (spec 01 precedence), flagging disagreement rows.
 *
 * Outputs an aligned table to stdout and a JSON snapshot to
 * /tmp/bucket-audit.json. Never writes to the paseo home and never peers
 * over the network (the orchestrator runs one instance per host).
 *
 * Run: npx tsx packages/server/src/server/mission-control/audit-lifecycle-buckets.ts [--home ~/.paseo] [--json-only]
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deriveAgentStateBucket,
  deriveLifecycleBucket,
  type AgentStateBucketInput,
  type LifecycleBucket,
} from "@getpaseo/protocol/agent-state-bucket";

// ============================================================================
// Wire-shaped types (lenient: malformed lines/records are skipped, mirroring
// the daemon store's load paths; additive fields from newer daemons pass).
// ============================================================================

interface StoredAgentRecord {
  id: string;
  cwd: string;
  name?: string;
  title?: string | null;
  shortDescription?: string;
  updatedAt?: string;
  lastStatus?: string;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  internal?: boolean;
  archivedAt?: string | null;
  labels?: Record<string, string>;
}

interface StoredEvent {
  ts?: string;
  seq?: number;
  agentId: string;
  kind: string;
  headline: string;
  stoppedBy?: "user" | "machinery" | "system";
  proposal?: { status?: string } | null;
}

interface StoredProposal {
  id: string;
  targetAgentId: string;
  status: string;
}

type ReviewStateValue = "none" | "ready" | "done" | "cleared";
type StopOrigin = "user" | "machinery" | "system";

// ============================================================================
// Legacy derivations, reimplemented over stored state. The canonical bucket
// comes from the protocol package (deriveLifecycleBucket, spec 01) — one
// derivation for every consumer.
// ============================================================================

/**
 * Old server-roster bucket (context.ts:276-291). The original takes a live
 * agent snapshot; without a daemon the stored record proxies it:
 * attention.requiresAttention := record.requiresAttention, lifecycle :=
 * record.lastStatus. Note the original only treats lifecycle "running" as
 * running (initializing reads as idle), which this copy preserves.
 */
function oldRosterBucket(record: StoredAgentRecord, reviewState: ReviewStateValue): string {
  if (record.requiresAttention === true || record.lastStatus === "error") {
    return "needs you";
  }
  if (record.lastStatus === "running") {
    return "running";
  }
  if (reviewState === "ready") {
    return "ready for review";
  }
  if (reviewState === "done") {
    return "done";
  }
  return "idle";
}

/**
 * Old app-board bucket (lifecycle.ts:221-270). The original folds each
 * agent's events (lifecycle.ts:148-203) into reviewState /
 * pendingProposalCount / snapshotStoppedBy, then derives the bucket. This
 * copy folds the FULL stored event log (the app's newest-200-per-host fetch,
 * use-aggregated-mission-control-events.ts:22-26, can evict old `finished`
 * events — a client-side divergence this local audit cannot reproduce).
 * Live-agent fields are proxied from the stored record: status := lastStatus,
 * pendingPermissionCount := attentionReason=="permission", stoppedBy :=
 * stop-origins.json.
 */
function oldBoardBucket(
  record: StoredAgentRecord,
  fold: {
    reviewState: ReviewStateValue;
    pendingProposalCount: number;
    snapshotStoppedBy: StopOrigin | null;
    hasEvents: boolean;
  },
  stoppedBy: StopOrigin | null,
): string {
  const pendingPermission = record.attentionReason === "permission";
  const failed = record.lastStatus === "error" || record.attentionReason === "error";
  const running = record.lastStatus === "running" || record.lastStatus === "initializing";
  const userStopped =
    fold.snapshotStoppedBy === "user" || (!fold.hasEvents && stoppedBy === "user");
  if ((pendingPermission || failed) && !userStopped) {
    return "needs_you";
  }
  if (running) {
    return "running";
  }
  if (fold.pendingProposalCount > 0 && !userStopped) {
    return "needs_you";
  }
  if (userStopped && fold.reviewState === "none") {
    return "done";
  }
  if (fold.reviewState === "done") {
    return "done";
  }
  if (fold.reviewState === "ready") {
    return "ready";
  }
  return "dormant";
}

/** Old sidebar bucket: the current protocol derivation (agent-state-bucket.ts), fed from stored state. */
function oldSidebarBucket(record: StoredAgentRecord): string {
  // lastStatus is persisted from the agent lifecycle enum; lenient cast keeps
  // malformed records from failing the audit.
  const status = (record.lastStatus ?? "closed") as AgentStateBucketInput["status"];
  const input: AgentStateBucketInput = {
    status,
    pendingPermissionCount: record.attentionReason === "permission" ? 1 : 0,
    requiresAttention: record.requiresAttention === true,
    attentionReason: record.attentionReason ?? null,
  };
  return deriveAgentStateBucket(input);
}

// ============================================================================
// Disagreement comparison: each legacy vocabulary maps to the canonical
// bucket(s) it expresses. A row disagrees when the canonical bucket is not in
// the mapped set for a legacy derivation.
// ============================================================================

const ROSTER_TO_CANONICAL: Record<string, readonly LifecycleBucket[]> = {
  "needs you": ["needs_you"],
  running: ["running"],
  "ready for review": ["ready"],
  done: ["done"],
  idle: ["idle"],
};

const BOARD_TO_CANONICAL: Record<string, readonly LifecycleBucket[]> = {
  needs_you: ["needs_you"],
  running: ["running"],
  ready: ["ready"],
  done: ["done"],
  dormant: ["idle"],
};

const SIDEBAR_TO_CANONICAL: Record<string, readonly LifecycleBucket[]> = {
  needs_input: ["needs_you"],
  failed: ["needs_you"],
  running: ["running"],
  attention: ["needs_you"],
  // The sidebar's terminal bucket "done" covers both idle and verdict-done
  // agents (its vocabulary has no ready/verdict distinction; the attention
  // gap on finished agents is what the audit surfaces instead).
  done: ["idle", "done"],
};

// ============================================================================
// Stored-state loaders (read-only).
// ============================================================================

const MC_DIR = "mission-control";
const EVENTS_FILENAME = "events.jsonl";
const REVIEW_STATE_FILENAME = "review-state.json";
const PROPOSALS_FILENAME = "proposals.jsonl";
const STOP_ORIGINS_FILENAME = "stop-origins.json";
const AUDIT_JSON_PATH = "/tmp/bucket-audit.json";

async function loadAgentRecords(agentsDir: string): Promise<StoredAgentRecord[]> {
  const records: StoredAgentRecord[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(await readFile(fullPath, "utf8"));
        if (isStoredAgentRecord(parsed)) {
          records.push(parsed);
        } else {
          process.stderr.write(`Skipping invalid agent record ${fullPath}\n`);
        }
      } catch {
        process.stderr.write(`Skipping unreadable agent record ${fullPath}\n`);
      }
    }
  };
  await walk(agentsDir);
  return records;
}

/** Extract the Node errno code (ENOENT, ...) from a thrown unknown, if present. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function loadJsonLines<T>(
  file: string,
  isEntry: (value: unknown) => value is T,
): Promise<T[]> {
  const out: T[] = [];
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return out;
    }
    throw error;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEntry(parsed)) {
        out.push(parsed);
      }
    } catch {
      // Malformed line: skip, matching the daemon store's load paths.
    }
  }
  return out;
}

async function loadJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    // Persisted JSON object files: narrow to a plain object before indexing.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function isStoredAgentRecord(value: unknown): value is StoredAgentRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    "cwd" in value &&
    typeof value.cwd === "string"
  );
}

function isStoredEvent(value: unknown): value is StoredEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "agentId" in value &&
    typeof value.agentId === "string" &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function isStoredProposal(value: unknown): value is StoredProposal {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    "targetAgentId" in value &&
    typeof value.targetAgentId === "string" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

// ============================================================================
// Event fold (board) and verdict parsing (lifecycle.ts:148-203, 74-106).
// ============================================================================

const CLEARED_HEADLINE = "Cleared";
const MARKED_DONE_HEADLINE = "Marked done";

function eventTimeMs(event: StoredEvent): number {
  const ts = Date.parse(event.ts ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

function parseVerdictReviewState(event: StoredEvent): "done" | "cleared" | null {
  if (event.kind !== "verdict") {
    return null;
  }
  if (event.headline === CLEARED_HEADLINE) {
    return "cleared";
  }
  if (event.headline === MARKED_DONE_HEADLINE) {
    return "done";
  }
  return "done";
}

interface BoardFold {
  reviewState: ReviewStateValue;
  pendingProposalCount: number;
  snapshotStoppedBy: StopOrigin | null;
  hasEvents: boolean;
}

/** Fold one agent's events (ascending) into the board predicate's inputs. */
function foldBoardEvents(events: readonly StoredEvent[]): BoardFold {
  const ordered = [...events].sort((left, right) => {
    const timeCmp = eventTimeMs(left) - eventTimeMs(right);
    if (timeCmp !== 0) {
      return timeCmp;
    }
    return (left.seq ?? -1) - (right.seq ?? -1);
  });
  let reviewState: ReviewStateValue = "none";
  let pendingProposalCount = 0;
  let snapshotStoppedBy: StopOrigin | null = null;
  for (const event of ordered) {
    if (event.stoppedBy !== undefined) {
      snapshotStoppedBy = event.stoppedBy;
    }
    if (event.kind === "proposal") {
      if (event.proposal?.status === "pending") {
        pendingProposalCount += 1;
      }
      continue;
    }
    if (event.kind === "started") {
      // A new run reopens the lifecycle and clears the previous run's stop.
      reviewState = "none";
      snapshotStoppedBy = event.stoppedBy ?? null;
      continue;
    }
    if (event.kind === "finished") {
      reviewState = "ready";
      continue;
    }
    const verdictState = parseVerdictReviewState(event);
    if (verdictState) {
      reviewState = verdictState;
    }
  }
  return { reviewState, pendingProposalCount, snapshotStoppedBy, hasEvents: events.length > 0 };
}

// ============================================================================
// Row assembly.
// ============================================================================

interface AuditRow {
  agentId: string;
  name: string | null;
  title: string | null;
  /** Record updatedAt: sort key (newest first) and fixture context. */
  updatedAt: string | null;
  oldRosterBucket: string;
  oldBoardBucket: string;
  oldSidebarBucket: string;
  canonicalBucket: LifecycleBucket;
  stopOrigin: StopOrigin | null;
  attentionReason: string | null;
  reviewState: ReviewStateValue;
  pendingProposalCount: number;
  hasEvents: boolean;
  archived: boolean;
  internal: boolean;
  disagreements: Array<"roster" | "board" | "sidebar">;
}

function buildRows(
  records: readonly StoredAgentRecord[],
  reviewStateByAgent: Map<string, ReviewStateValue>,
  stopOriginByAgent: Map<string, StopOrigin>,
  pendingProposalByAgent: Map<string, number>,
  eventsByAgent: Map<string, StoredEvent[]>,
): AuditRow[] {
  return records.map((record) => {
    const reviewState = reviewStateByAgent.get(record.id) ?? "none";
    const stopOrigin = stopOriginByAgent.get(record.id) ?? null;
    const pendingProposalCount = pendingProposalByAgent.get(record.id) ?? 0;
    const events = eventsByAgent.get(record.id) ?? [];
    const fold = foldBoardEvents(events);

    const rosterBucket = oldRosterBucket(record, reviewState);
    const boardBucket = oldBoardBucket(record, fold, stopOrigin);
    const sidebarBucket = oldSidebarBucket(record);

    // lastStatus defaults to "closed" on the stored-record schema.
    const lastStatus = record.lastStatus ?? "closed";
    const canonicalBucket = deriveLifecycleBucket({
      pendingPermissionCount: record.attentionReason === "permission" ? 1 : 0,
      pendingProposalCount,
      attentionReason: record.attentionReason ?? null,
      lastStatus,
      running: lastStatus === "running" || lastStatus === "initializing",
      reviewState,
      stopOrigin,
    });

    const disagreements: AuditRow["disagreements"] = [];
    if (!ROSTER_TO_CANONICAL[rosterBucket]?.includes(canonicalBucket)) {
      disagreements.push("roster");
    }
    if (!BOARD_TO_CANONICAL[boardBucket]?.includes(canonicalBucket)) {
      disagreements.push("board");
    }
    if (!SIDEBAR_TO_CANONICAL[sidebarBucket]?.includes(canonicalBucket)) {
      disagreements.push("sidebar");
    }

    return {
      agentId: record.id,
      name: record.name ?? null,
      title: record.title ?? null,
      updatedAt: record.updatedAt ?? null,
      oldRosterBucket: rosterBucket,
      oldBoardBucket: boardBucket,
      oldSidebarBucket: sidebarBucket,
      canonicalBucket,
      stopOrigin,
      attentionReason: record.attentionReason ?? null,
      reviewState,
      pendingProposalCount,
      hasEvents: fold.hasEvents,
      archived: record.archivedAt !== undefined && record.archivedAt !== null,
      internal: record.internal === true,
      disagreements,
    };
  });
}

// ============================================================================
// Output: aligned table + JSON snapshot.
// ============================================================================

const COLUMNS = [
  { header: "FLAG", width: 5 },
  { header: "AGENT ID", width: 36 },
  { header: "NAME", width: 24 },
  { header: "TITLE", width: 36 },
  { header: "ROSTER", width: 14 },
  { header: "BOARD", width: 10 },
  { header: "SIDEBAR", width: 10 },
  { header: "CANONICAL", width: 10 },
  { header: "STOP", width: 11 },
  { header: "ATTENTION", width: 11 },
  { header: "REVIEW", width: 8 },
  { header: "PROPOSALS", width: 9 },
] as const;

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function printTable(rows: readonly AuditRow[]): void {
  const header = COLUMNS.map((column) => column.header.padEnd(column.width)).join(" ");
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${COLUMNS.map((column) => "-".repeat(column.width)).join(" ")}\n`);
  for (const row of rows) {
    const flag = row.disagreements.length > 0 ? "!" : "";
    const cells = [
      flag.padEnd(COLUMNS[0].width),
      row.agentId.padEnd(COLUMNS[1].width),
      truncate(row.name ?? "", COLUMNS[2].width).padEnd(COLUMNS[2].width),
      truncate(row.title ?? "", COLUMNS[3].width).padEnd(COLUMNS[3].width),
      row.oldRosterBucket.padEnd(COLUMNS[4].width),
      row.oldBoardBucket.padEnd(COLUMNS[5].width),
      row.oldSidebarBucket.padEnd(COLUMNS[6].width),
      row.canonicalBucket.padEnd(COLUMNS[7].width),
      (row.stopOrigin ?? "-").padEnd(COLUMNS[8].width),
      (row.attentionReason ?? "-").padEnd(COLUMNS[9].width),
      row.reviewState.padEnd(COLUMNS[10].width),
      String(row.pendingProposalCount).padEnd(COLUMNS[11].width),
    ];
    process.stdout.write(`${cells.join(" ")}\n`);
  }
}

async function writeJsonSnapshot(home: string, rows: readonly AuditRow[]): Promise<void> {
  const disagreementCount = rows.filter((row) => row.disagreements.length > 0).length;
  const payload = {
    generatedAt: new Date().toISOString(),
    home,
    counts: {
      agents: rows.length,
      disagreements: disagreementCount,
    },
    rows,
  };
  await writeFile(AUDIT_JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`Wrote ${AUDIT_JSON_PATH}\n`);
}

// ============================================================================
// CLI.
// ============================================================================

interface AuditArgs {
  home: string;
  jsonOnly: boolean;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Mission Control lifecycle-bucket audit (read-only; never starts a daemon).",
      "",
      "Usage: npx tsx packages/server/src/server/mission-control/audit-lifecycle-buckets.ts [options]",
      "",
      "Options:",
      "  --home <path>   Paseo home to audit (default ~/.paseo).",
      "  --json-only     Suppress the table; only write /tmp/bucket-audit.json.",
      "  -h, --help      Show this help.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): AuditArgs {
  const args: AuditArgs = { home: join(homedir(), ".paseo"), jsonOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--home") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--home requires a path argument");
      }
      args.home = value;
      i += 1;
    } else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value) {
        throw new Error("--home requires a path argument");
      }
      args.home = value;
    } else if (arg === "--json-only") {
      args.jsonOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agentsDir = join(args.home, "agents");
  const mcDir = join(args.home, MC_DIR);

  const [records, reviewStateRaw, stopOriginsRaw, proposals, events] = await Promise.all([
    loadAgentRecords(agentsDir),
    loadJsonObject(join(mcDir, REVIEW_STATE_FILENAME)),
    loadJsonObject(join(mcDir, STOP_ORIGINS_FILENAME)),
    loadJsonLines(join(mcDir, PROPOSALS_FILENAME), isStoredProposal),
    loadJsonLines(join(mcDir, EVENTS_FILENAME), isStoredEvent),
  ]);

  const reviewStateByAgent = new Map<string, ReviewStateValue>();
  for (const [agentId, value] of Object.entries(reviewStateRaw)) {
    // review-state.json entries are { reviewState, doneAt, clearedAt, verdict }.
    if (typeof value === "object" && value !== null && "reviewState" in value) {
      const reviewState = value.reviewState;
      if (
        reviewState === "none" ||
        reviewState === "ready" ||
        reviewState === "done" ||
        reviewState === "cleared"
      ) {
        reviewStateByAgent.set(agentId, reviewState);
      }
    }
  }

  const stopOriginByAgent = new Map<string, StopOrigin>();
  for (const [agentId, value] of Object.entries(stopOriginsRaw)) {
    if (value === "user" || value === "machinery" || value === "system") {
      stopOriginByAgent.set(agentId, value);
    }
  }

  // Proposal index: latest line per id wins (the store's JSONL append pattern).
  const proposalsById = new Map<string, StoredProposal>();
  for (const proposal of proposals) {
    proposalsById.set(proposal.id, proposal);
  }
  const pendingProposalByAgent = new Map<string, number>();
  for (const proposal of proposalsById.values()) {
    if (proposal.status === "pending") {
      pendingProposalByAgent.set(
        proposal.targetAgentId,
        (pendingProposalByAgent.get(proposal.targetAgentId) ?? 0) + 1,
      );
    }
  }

  const eventsByAgent = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const agentEvents = eventsByAgent.get(event.agentId);
    if (agentEvents) {
      agentEvents.push(event);
    } else {
      eventsByAgent.set(event.agentId, [event]);
    }
  }

  const rows = buildRows(
    records,
    reviewStateByAgent,
    stopOriginByAgent,
    pendingProposalByAgent,
    eventsByAgent,
  );
  rows.sort((left, right) => {
    const updatedAtCmp = Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");
    if (!Number.isNaN(updatedAtCmp) && updatedAtCmp !== 0) {
      return updatedAtCmp;
    }
    return left.agentId.localeCompare(right.agentId);
  });

  await writeJsonSnapshot(args.home, rows);

  if (!args.jsonOnly) {
    printTable(rows);
    const disagreementCount = rows.filter((row) => row.disagreements.length > 0).length;
    process.stdout.write(
      `\n${rows.length} agents audited; ${disagreementCount} rows disagree with the canonical bucket.\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
