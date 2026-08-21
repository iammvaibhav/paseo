import type {
  MissionControlEvent,
  MissionControlProof,
} from "@getpaseo/protocol/mission-control/types";
import type { MissionControlVerdict } from "./store.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";

/**
 * M6 context architecture (docs/commander.md "Context architecture"): compact
 * per-run records assembled deterministically at run end / ready-for-review
 * from data the daemon already holds — launch brief, report_status history,
 * verdict, proofs. No transcript reads, no model calls. Run records feed the
 * workspace/project rollups (rollups.ts), the spawn-brief enrichment, the
 * fleet_context tool, and the Hindsight fleet bank writes (hindsight.ts).
 */

/** Launch brief cap: the first user_message row, bounded to this many chars. */
export const RUN_RECORD_BRIEF_MAX_CHARS = 2000;
/** Self-report history cap per run record (oldest -> newest). */
export const RUN_RECORD_REPORTS_MAX = 40;
/** Proof cap per run record. */
export const RUN_RECORD_PROOFS_MAX = 20;
/** Run records considered by one workspace rollup (latest first). */
export const ROLLUP_RUNS_PER_WORKSPACE = 8;
/** Run records considered by one project rollup (across its workspaces). */
export const ROLLUP_RUNS_PER_PROJECT = 12;
/** Spawn-brief enrichment block budget (docs: ~2KB max). */
export const PRIOR_WORK_BLOCK_MAX_BYTES = 2048;

export type MissionControlRunOutcome =
  | "finished"
  | "failed"
  | "interrupted"
  | "blocked"
  | "ready"
  | "running";

export interface MissionControlRunReport {
  ts: string;
  kind: MissionControlEvent["kind"];
  headline: string;
  detail?: string;
  /** Original report_status kind (finding/fix/milestone/decision/progress). */
  reportKind?: string;
}

export interface MissionControlRunProof {
  kind: MissionControlProof["kind"];
  label?: string;
  url?: string;
  path?: string;
  excerpt?: string;
}

/**
 * One run's deterministic record. Keyed by (agentId, runEpoch): re-assembly
 * is idempotent and the latest assembly for a key wins on store load.
 */
export interface MissionControlRunRecord {
  /** Stable per (agentId, runEpoch): "mcr_<agentId>_<runEpoch>". Re-assembly
   *  of the same run upserts this id; the latest line wins on store load. */
  id: string;
  agentId: string;
  /** Fleet name (write-once identity; the feed's name chip). */
  agentName: string;
  /** Living title at assembly time. */
  agentTitle: string;
  /** Host alias this agent runs on ("local" fallback). */
  hostAlias: string;
  serverId: string;
  workspaceId: string | null;
  workspaceTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  runEpoch: number;
  startedAt: string; // ISO
  endedAt: string; // ISO
  outcome: MissionControlRunOutcome;
  /** Launch brief: first non-empty user_message timeline row. */
  brief: string | null;
  /** report_status history for this run (oldest -> newest). */
  reports: MissionControlRunReport[];
  verdict: MissionControlVerdict | null;
  proofs: MissionControlRunProof[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Workspace/project attribution frozen into the record at assembly time. */
export interface MissionControlRunPlacement {
  workspaceId: string | null;
  workspaceTitle: string | null;
  projectId: string | null;
  projectName: string | null;
}

export interface RunRecordAssemblyInput {
  agentId: string;
  agentName: string;
  agentTitle: string;
  hostAlias: string;
  serverId: string;
  runEpoch: number;
  /** All retained events (includeSuperseded), append order = chronological. */
  events: MissionControlEvent[];
  /** Timeline rows; empty when the agent is closed and rows are unavailable. */
  timelineRows: AgentTimelineRow[];
  /** Current review-state verdict (included only when it belongs to this run). */
  reviewVerdict: MissionControlVerdict | null;
  placement: MissionControlRunPlacement | null;
  now?: string;
}

function isRunEvent(event: MissionControlEvent, agentId: string, runEpoch: number): boolean {
  return event.agentId === agentId && (event.runEpoch ?? 0) === runEpoch;
}

const RUN_TERMINAL_KINDS: Record<MissionControlEvent["kind"], boolean> = {
  started: false,
  finished: true,
  failed: true,
  blocked: false,
  stalled: false,
  milestone: false,
  finding: false,
  diverged: false,
  proposal: false,
  verdict: false,
  interrupted: true,
  clarification: false,
  answer: false,
};

/** The launch brief: first non-empty user_message timeline row (same reader as the verifier). */
export function readLaunchBrief(timelineRows: AgentTimelineRow[]): string | null {
  const row = timelineRows.find(
    (candidate): candidate is AgentTimelineRow & { item: { type: "user_message" } } =>
      candidate.item.type === "user_message" && candidate.item.text.trim().length > 0,
  );
  if (!row) {
    return null;
  }
  const brief = row.item.text.trim();
  return brief.length > RUN_RECORD_BRIEF_MAX_CHARS
    ? `${brief.slice(0, RUN_RECORD_BRIEF_MAX_CHARS)}…`
    : brief;
}

function toRunProof(proof: MissionControlProof): MissionControlRunProof {
  return {
    kind: proof.kind,
    ...(proof.label ? { label: proof.label } : {}),
    ...(proof.url ? { url: proof.url } : {}),
    ...(proof.path ? { path: proof.path } : {}),
    ...(proof.excerpt ? { excerpt: proof.excerpt } : {}),
  };
}

function proofKey(proof: MissionControlRunProof): string {
  return `${proof.kind}:${proof.url ?? ""}:${proof.path ?? ""}:${proof.excerpt ?? ""}`;
}

/** Chronological events for one run (store events arrive newest-first). */
function collectRunEvents(input: RunRecordAssemblyInput): MissionControlEvent[] {
  const runEvents = input.events.filter((event) =>
    isRunEvent(event, input.agentId, input.runEpoch),
  );
  // seq is the monotonic append order (ts can tie within a millisecond), so
  // sort by seq primarily, ts as the tiebreak.
  runEvents.sort(
    (left, right) => (left.seq ?? 0) - (right.seq ?? 0) || left.ts.localeCompare(right.ts),
  );
  return runEvents;
}

interface RunRecordWindow {
  startedAt: string;
  endedAt: string;
  terminalEvent: MissionControlEvent | undefined;
}

/** Run window: the started event (or first event) opens it, the latest terminal event closes it. */
function resolveRunWindow(runEvents: MissionControlEvent[], now: string): RunRecordWindow {
  const startedEvent = runEvents.find((event) => event.kind === "started");
  // Latest terminal event wins (events array is chronological).
  let terminalEvent: MissionControlEvent | undefined;
  for (const event of runEvents) {
    if (RUN_TERMINAL_KINDS[event.kind]) {
      terminalEvent = event;
    }
  }
  const startedAt = startedEvent?.ts ?? runEvents[0]?.ts ?? now;
  const endedAt = terminalEvent?.ts ?? runEvents[runEvents.length - 1]?.ts ?? now;
  return { startedAt, endedAt, terminalEvent };
}

/**
 * The verdict is included only when its recorded time falls inside this run's
 * window, so a verdict from an EARLIER run never leaks into a later run's
 * record (the review state persists across runs until the next completion).
 */
function resolveRunVerdict(
  reviewVerdict: MissionControlVerdict | null,
  startedAt: string,
): MissionControlVerdict | null {
  if (!reviewVerdict || reviewVerdict.at < startedAt) {
    return null;
  }
  return reviewVerdict;
}

function resolveRunOutcome(
  terminalEvent: MissionControlEvent | undefined,
  hasVerdict: boolean,
): MissionControlRunOutcome {
  if (!terminalEvent) {
    // A run with a verdict but no terminal event was closed via the review
    // lifecycle (user marked done/cleared) — closed is not running.
    return hasVerdict ? "finished" : "running";
  }
  if (terminalEvent.kind === "finished") {
    return "finished";
  }
  if (terminalEvent.kind === "failed") {
    return "failed";
  }
  return "interrupted";
}

/** Self-report history for the record (oldest -> newest), capped at RUN_RECORD_REPORTS_MAX. */
function collectRunReports(runEvents: MissionControlEvent[]): MissionControlRunReport[] {
  const reports: MissionControlRunReport[] = [];
  for (const event of runEvents) {
    if (event.source !== "self") {
      continue;
    }
    reports.push({
      ts: event.ts,
      kind: event.kind,
      headline: event.headline,
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.reportKind ? { reportKind: event.reportKind } : {}),
    });
    if (reports.length >= RUN_RECORD_REPORTS_MAX) {
      break;
    }
  }
  return reports;
}

/** Run proofs: flattened from events, deduped by content, capped at RUN_RECORD_PROOFS_MAX. */
function collectRunProofs(runEvents: MissionControlEvent[]): MissionControlRunProof[] {
  const proofs: MissionControlRunProof[] = [];
  const seenProofs = new Set<string>();
  for (const event of runEvents) {
    for (const proof of event.proof ?? []) {
      const converted = toRunProof(proof);
      const key = proofKey(converted);
      if (seenProofs.has(key)) {
        continue;
      }
      seenProofs.add(key);
      proofs.push(converted);
      if (proofs.length >= RUN_RECORD_PROOFS_MAX) {
        break;
      }
    }
    if (proofs.length >= RUN_RECORD_PROOFS_MAX) {
      break;
    }
  }
  return proofs;
}

/** Workspace/project attribution frozen into the record at assembly time. */
function placementRecordFields(
  placement: MissionControlRunPlacement | null,
): MissionControlRunPlacement {
  const workspaceId = placement?.workspaceId ?? null;
  const workspaceTitle = placement?.workspaceTitle ?? null;
  const projectId = placement?.projectId ?? null;
  const projectName = placement?.projectName ?? null;
  return { workspaceId, workspaceTitle, projectId, projectName };
}

/**
 * Deterministic run-record assembly from data the daemon already holds. The
 * output is a pure function of the input: re-assembly is idempotent.
 */
export function assembleRunRecord(input: RunRecordAssemblyInput): MissionControlRunRecord {
  const now = input.now ?? new Date().toISOString();
  const runEvents = collectRunEvents(input);
  const { startedAt, endedAt, terminalEvent } = resolveRunWindow(runEvents, now);
  const verdict = resolveRunVerdict(input.reviewVerdict, startedAt);
  const outcome = resolveRunOutcome(terminalEvent, verdict !== null);

  return {
    id: `mcr_${input.agentId}_${input.runEpoch}`,
    agentId: input.agentId,
    agentName: input.agentName,
    agentTitle: input.agentTitle,
    hostAlias: input.hostAlias,
    serverId: input.serverId,
    ...placementRecordFields(input.placement),
    runEpoch: input.runEpoch,
    startedAt,
    endedAt,
    outcome,
    brief: readLaunchBrief(input.timelineRows),
    reports: collectRunReports(runEvents),
    verdict,
    proofs: collectRunProofs(runEvents),
    createdAt: now,
    updatedAt: now,
  };
}

/** Run-record identity for hindsight document ids: stable and unique per run. */
export function runRecordDocumentId(record: MissionControlRunRecord): string {
  return `paseo-run:${record.agentId}:${record.runEpoch}`;
}

/** Hindsight tags for a run record (host/project/workspace/agent attribution). */
export function runRecordTags(record: MissionControlRunRecord): string[] {
  const tags = [`host:${record.hostAlias}`, `agent:${record.agentName}`];
  if (record.projectName) {
    tags.push(`project:${record.projectName}`);
  }
  if (record.workspaceTitle) {
    tags.push(`workspace:${record.workspaceTitle}`);
  }
  return tags;
}

const TERMINAL_RUN_KINDS: Record<MissionControlRunOutcome, boolean> = {
  finished: true,
  failed: true,
  interrupted: true,
  blocked: true,
  ready: false,
  running: false,
};

/** Whether the run has settled enough to be written to the fleet memory bank. */
export function isFinalizableRunRecord(record: MissionControlRunRecord): boolean {
  return TERMINAL_RUN_KINDS[record.outcome] || record.verdict !== null;
}
