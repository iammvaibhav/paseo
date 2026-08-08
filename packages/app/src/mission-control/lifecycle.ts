import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";

/**
 * Mission Control board lifecycle (spec: "Lifecycle").
 *
 * Pure derivation from the agent directory + the aggregated mission-control
 * event feed. reviewState is folded from each agent's events oldest→newest:
 * a started run reopens the lifecycle, a finished run moves to ready-for-
 * review, and verdict cards mark done/cleared. All of this is kept pure so
 * the board, the sidebar badge, and the tests share one model.
 */

export type LifecycleBucket = "needs_you" | "running" | "ready" | "done" | "dormant";

export type LifecycleReviewState = "none" | "ready" | "done" | "cleared";

/** Why a row is Done without a verdict card (spec "Lifecycle"). */
export type LifecycleDoneReason = "stopped-by-user";

export interface LifecycleVerdict {
  by: "verifier" | "user";
  summary: string;
  at: string;
}

export interface AgentLifecycleState {
  bucket: LifecycleBucket;
  reviewState: LifecycleReviewState;
  verdict: LifecycleVerdict | null;
  /**
   * Distinct Done marker: the user stopped the agent's last run (spec:
   * user-stopped ≠ Needs-you). Null for every other bucket — verdict-done
   * rows carry `verdict` instead, and cleared rows leave the lifecycle.
   */
  doneReason: LifecycleDoneReason | null;
  /** Latest meaningful status headline (non-proposal), newest event wins. */
  lastReportHeadline: string | null;
  /** Millisecond timestamp of the agent's newest mission-control event. */
  lastEventAt: number | null;
  /** Live pending proposals (status "pending") — these put the row in Needs you. */
  pendingProposalCount: number;
  /** True when the agent has no place in the active lifecycle (pre-rollout
   * idle, cleared, or long-idle) — hidden by default, shown by the toggle. */
  dormant: boolean;
  /** True when lastActivityAt falls inside the retention window. */
  withinWindow: boolean;
  /**
   * Emit-time identity snapshots for recorded buckets (Done / Ready / Dormant):
   * the agent's title and short description as of its newest mission-control
   * event — never the live directory values (which the daemon may rewrite
   * later). Null when no event ever carried the field; Running / Needs-you
   * rows render live identity instead (they are current state, not history).
   */
  snapshotTitle: string | null;
  snapshotShortDescription: string | null;
  /**
   * Stop origin snapshotted at the last run's terminal event (who cancelled
   * the agent's last run). Null when no stop was in effect at emit time or
   * the row is in a live bucket. Recorded rows render this, never the live
   * directory stoppedBy.
   */
  snapshotStoppedBy: "user" | "machinery" | "system" | null;
}

export const DEFAULT_RETENTION_DAYS = 30;

export const LIFECYCLE_BUCKET_ORDER: readonly LifecycleBucket[] = [
  "needs_you",
  "running",
  "ready",
  "done",
  "dormant",
] as const;

export const LIFECYCLE_BUCKET_LABELS: Record<LifecycleBucket, string> = {
  needs_you: "Needs you",
  running: "Running",
  ready: "Ready for review",
  done: "Done",
  dormant: "Dormant",
};

const VERIFIER_DONE_PREFIX = "Done — ";
const MARKED_DONE_HEADLINE = "Marked done";
const CLEARED_HEADLINE = "Cleared";

function eventTimeMs(event: MissionControlEvent): number {
  const ts = Date.parse(event.ts);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Parse a kind:"verdict" card into a review-state transition. The daemon's
 * verdict headlines are the contract (service.ts emitVerdictEvent): verifier
 * verdicts read "Done — <summary>", user actions read "Marked done"/"Cleared".
 */
export function parseVerdictEvent(
  event: MissionControlEvent,
): { reviewState: "done" | "cleared"; verdict: LifecycleVerdict } | null {
  if (event.kind !== "verdict") {
    return null;
  }
  if (event.headline === CLEARED_HEADLINE) {
    return {
      reviewState: "cleared",
      verdict: { by: "user", summary: event.detail ?? CLEARED_HEADLINE, at: event.ts },
    };
  }
  if (event.headline === MARKED_DONE_HEADLINE) {
    return {
      reviewState: "done",
      verdict: { by: "user", summary: event.detail ?? MARKED_DONE_HEADLINE, at: event.ts },
    };
  }
  if (event.headline.startsWith(VERIFIER_DONE_PREFIX)) {
    return {
      reviewState: "done",
      verdict: {
        by: "verifier",
        summary: event.detail ?? event.headline.slice(VERIFIER_DONE_PREFIX.length),
        at: event.ts,
      },
    };
  }
  return {
    reviewState: "done",
    verdict: {
      by: event.source === "verifier" ? "verifier" : "user",
      summary: event.detail ?? event.headline,
      at: event.ts,
    },
  };
}

interface LifecycleFold {
  reviewState: LifecycleReviewState;
  verdict: LifecycleVerdict | null;
  lastReportHeadline: string | null;
  lastEventAt: number | null;
  pendingProposalCount: number;
  snapshotTitle: string | null;
  snapshotShortDescription: string | null;
  snapshotStoppedBy: "user" | "machinery" | "system" | null;
}

/** Fold one agent's events (ascending) into lifecycle bookkeeping. */
function foldLifecycleEvents(events: readonly MissionControlEvent[]): LifecycleFold {
  let reviewState: LifecycleReviewState = "none";
  let verdict: LifecycleVerdict | null = null;
  let lastReportHeadline: string | null = null;
  let lastEventAt: number | null = null;
  let pendingProposalCount = 0;
  let snapshotTitle: string | null = null;
  let snapshotShortDescription: string | null = null;
  let snapshotStoppedBy: "user" | "machinery" | "system" | null = null;

  for (const event of events) {
    const tsMs = eventTimeMs(event);
    if (lastEventAt === null || tsMs > lastEventAt) {
      lastEventAt = tsMs;
    }
    // Identity snapshots: every event carries the agent's emit-time title;
    // shortDescription and stoppedBy are stamped when present. Newest wins.
    snapshotTitle = event.agentTitle;
    if (event.shortDescription !== undefined) {
      snapshotShortDescription = event.shortDescription;
    }
    if (event.stoppedBy !== undefined) {
      snapshotStoppedBy = event.stoppedBy;
    }
    if (event.kind === "proposal") {
      if (event.proposal?.status === "pending") {
        pendingProposalCount += 1;
      }
      continue;
    }
    // Proposal cards are machinery; the row's one-liner shows the latest real
    // status (report, run transition, verdict) instead.
    lastReportHeadline = event.headline;
    if (event.kind === "started") {
      // A new run reopens the lifecycle: prior done/cleared is bookkeeping,
      // and the previous run's stop origin no longer describes this one (the
      // daemon clears the origin before emitting the started card, so the
      // started event's own snapshot — usually absent — is the new truth).
      reviewState = "none";
      verdict = null;
      snapshotStoppedBy = event.stoppedBy ?? null;
      continue;
    }
    if (event.kind === "finished") {
      reviewState = "ready";
      continue;
    }
    const verdictParse = parseVerdictEvent(event);
    if (verdictParse) {
      reviewState = verdictParse.reviewState;
      verdict = verdictParse.verdict;
    }
  }

  return {
    reviewState,
    verdict,
    lastReportHeadline,
    lastEventAt,
    pendingProposalCount,
    snapshotTitle,
    snapshotShortDescription,
    snapshotStoppedBy,
  };
}

function deriveLifecycleBucket(input: {
  agent: AggregatedAgent;
  reviewState: LifecycleReviewState;
  pendingProposalCount: number;
  snapshotStoppedBy: "user" | "machinery" | "system" | null;
}): { bucket: LifecycleBucket; doneReason: LifecycleDoneReason | null } {
  const { agent, reviewState, pendingProposalCount, snapshotStoppedBy } = input;
  const pendingPermission =
    (agent.pendingPermissionCount ?? 0) > 0 || agent.attentionReason === "permission";
  const failed = agent.status === "error" || agent.attentionReason === "error";
  const running = agent.status === "running" || agent.status === "initializing";
  // Recorded stop origin (who stopped the LAST run, per its terminal event) —
  // never the live directory stoppedBy, which the daemon may rewrite later.
  const userStopped = snapshotStoppedBy === "user";

  if ((pendingPermission || failed || pendingProposalCount > 0) && !userStopped) {
    // Live attention signals (permission / error / proposals) outrank running
    // and the review fold — except when the USER performed the stop: nothing
    // new needs them (spec "User-stopped ≠ Needs you"; the live bug was a
    // user-stopped agent reading as Needs-you via these signals).
    return { bucket: "needs_you", doneReason: null };
  }
  if (running) {
    // Reopen: any new run returns the agent to Running (spec "Lifecycle").
    return { bucket: "running", doneReason: null };
  }
  if (userStopped && reviewState === "none") {
    // User-stopped ≠ Needs you (spec "Lifecycle"): the user performed the
    // stop, nothing needs them — Done with a "Stopped by you" marker. If the
    // agent actually finished (reviewState "ready"), was marked done, or cleared,
    // those terminal review states take precedence without the stopped chip.
    return { bucket: "done", doneReason: "stopped-by-user" };
  }
  if (reviewState === "done") {
    // reviewState outranks the agent's finished attention: the daemon does not
    // clear requiresAttention on a verdict, so a done agent would otherwise
    // keep reading as ready-for-review.
    return { bucket: "done", doneReason: null };
  }
  if (reviewState === "ready") {
    // Ready accrues only from server-recorded lifecycle (finished events /
    // reportSelfStatus completed) — spec: pre-rollout idle agents are Dormant,
    // never retroactively "Ready for review".
    return { bucket: "ready", doneReason: null };
  }
  return { bucket: "dormant", doneReason: null };
}

/**
 * Derive one agent's board lifecycle from its own events (any order; the
 * feed is newest-first, so the fold sorts ascending). Events must already be
 * scoped to this agent AND this server — the caller filters by serverId.
 */
export function deriveAgentLifecycle(input: {
  agent: AggregatedAgent;
  events: readonly MissionControlEvent[];
  now: number;
  retentionMs: number;
}): AgentLifecycleState {
  const { agent, events, now, retentionMs } = input;

  const ordered = [...events].sort((left, right) => {
    const timeCmp = eventTimeMs(left) - eventTimeMs(right);
    if (timeCmp !== 0) {
      return timeCmp;
    }
    return (left.seq ?? -1) - (right.seq ?? -1);
  });

  const fold = foldLifecycleEvents(ordered);
  const derived = deriveLifecycleBucket({
    agent,
    reviewState: fold.reviewState,
    pendingProposalCount: fold.pendingProposalCount,
    snapshotStoppedBy: fold.snapshotStoppedBy,
  });

  return {
    bucket: derived.bucket,
    reviewState: fold.reviewState,
    verdict: fold.verdict,
    doneReason: derived.doneReason,
    lastReportHeadline: fold.lastReportHeadline,
    lastEventAt: fold.lastEventAt,
    pendingProposalCount: fold.pendingProposalCount,
    dormant: derived.bucket === "dormant",
    withinWindow: agent.lastActivityAt.getTime() >= now - retentionMs,
    snapshotTitle: fold.snapshotTitle,
    snapshotShortDescription: fold.snapshotShortDescription,
    snapshotStoppedBy: fold.snapshotStoppedBy,
  };
}

/** A board row: the agent plus its derived lifecycle state. */
export interface LifecycleRow extends AgentLifecycleState {
  agent: AggregatedAgent;
  /** Millisecond timestamp the row sorts by in time-desc buckets. */
  sortTime: number;
}

export function toLifecycleRow(agent: AggregatedAgent, state: AgentLifecycleState): LifecycleRow {
  return {
    ...state,
    agent,
    // Sort by the same trustworthy activity instant the row displays, so a
    // time-desc bucket (dormant included) orders by real activity. Unknown
    // activity (null) sorts last.
    sortTime: rowActivityMs({ ...state, agent, sortTime: 0 }) ?? 0,
  };
}

/**
 * The instant a row's timestamp should read as "when it last did anything".
 *
 * Recorded buckets (Done / Ready / Dormant) read the real evidence — the
 * newest mission-control event (`lastEventAt`; a verdict card IS an event, so
 * verdict time is included) — because the directory `lastActivityAt` is NOT
 * trustworthy for history: the daemon stamps stored records with the
 * registration/restore time whenever an idle agent is loaded across a daemon
 * restart, so every recorded agent that did nothing since the last boot reads
 * the same shared value (live bug). Dormant rows additionally use the agent's
 * last user message as the reliable floor for pre-rollout agents that have no
 * events at all. When no trustworthy instant exists, the true one is unknown
 * — return null so the row renders no age rather than a fabricated one (a
 * wrong age is worse than none).
 *
 * Live buckets (Running / Needs-you) keep the live directory timestamp, which
 * ticks on every timeline row while an agent is running.
 */
export function rowActivityMs(row: LifecycleRow): number | null {
  if (row.bucket === "done" || row.bucket === "ready" || row.bucket === "dormant") {
    const candidates: number[] = [];
    if (row.lastEventAt !== null) {
      candidates.push(row.lastEventAt);
    }
    if (row.bucket === "dormant") {
      const lastUserMessageMs = row.agent.lastUserMessageAt?.getTime();
      if (lastUserMessageMs !== undefined) {
        candidates.push(lastUserMessageMs);
      }
    }
    return candidates.length > 0 ? Math.max(...candidates) : null;
  }
  return row.agent.lastActivityAt.getTime();
}

/**
 * Default-view visibility: Needs you / Running / Ready always show; Done shows
 * while inside the retention window; Dormant never shows. "All unarchived"
 * (showAll) reveals every unarchived agent regardless of age or bucket.
 */
export function lifecycleRowVisible(
  row: Pick<LifecycleRow, "bucket" | "withinWindow">,
  showAll: boolean,
): boolean {
  if (showAll) {
    return true;
  }
  if (row.bucket === "dormant") {
    return false;
  }
  if (row.bucket === "done") {
    return row.withinWindow;
  }
  return true;
}

function compareRunningRows(left: LifecycleRow, right: LifecycleRow): number {
  const leftKey = left.agent.name ?? left.agent.title ?? left.agent.id;
  const rightKey = right.agent.name ?? right.agent.title ?? right.agent.id;
  const nameCmp = leftKey.localeCompare(rightKey);
  if (nameCmp !== 0) {
    return nameCmp;
  }
  return `${left.agent.serverId}:${left.agent.id}`.localeCompare(
    `${right.agent.serverId}:${right.agent.id}`,
  );
}

function compareTimeDescRows(left: LifecycleRow, right: LifecycleRow): number {
  if (left.sortTime !== right.sortTime) {
    return right.sortTime - left.sortTime;
  }
  return compareRunningRows(left, right);
}

/**
 * Per-bucket row sort (spec: running by name asc; review/done/dormant by time
 * desc). Dormant sorts by time desc so the board surfaces the most recently
 * active agent first — a name-sorted dormant list buries recency (live bug:
 * the user's dormant list was strict alphabetical). needs_you joins the
 * time-desc convention: its rows are review attention like ready, and the
 * name sort made new attention indistinguishable from old. Running stays by
 * name asc — a stable list while agents work has value.
 */
export function sortLifecycleRows(bucket: LifecycleBucket, rows: LifecycleRow[]): LifecycleRow[] {
  if (bucket === "ready" || bucket === "done" || bucket === "dormant" || bucket === "needs_you") {
    return rows.sort(compareTimeDescRows);
  }
  return rows.sort(compareRunningRows);
}

export interface LifecycleBucketGroup {
  bucket: LifecycleBucket;
  rows: LifecycleRow[];
}

/**
 * Group rows into non-empty bucket sections in board order, applying the
 * visibility filter. Sorted per bucket per the spec.
 */
export function groupLifecycleRows(
  rows: readonly LifecycleRow[],
  showAll: boolean,
): LifecycleBucketGroup[] {
  const byBucket = new Map<LifecycleBucket, LifecycleRow[]>();
  for (const row of rows) {
    if (!lifecycleRowVisible(row, showAll)) {
      continue;
    }
    const group = byBucket.get(row.bucket);
    if (group) {
      group.push(row);
    } else {
      byBucket.set(row.bucket, [row]);
    }
  }
  const groups: LifecycleBucketGroup[] = [];
  for (const bucket of LIFECYCLE_BUCKET_ORDER) {
    const bucketRows = byBucket.get(bucket);
    if (!bucketRows || bucketRows.length === 0) {
      continue;
    }
    groups.push({ bucket, rows: sortLifecycleRows(bucket, bucketRows) });
  }
  return groups;
}

export interface LifecycleCounts {
  needsYou: number;
  working: number;
  ready: number;
  done: number;
}

export function countLifecycle(rows: readonly LifecycleRow[]): LifecycleCounts {
  const counts: LifecycleCounts = { needsYou: 0, working: 0, ready: 0, done: 0 };
  for (const row of rows) {
    if (row.bucket === "needs_you") {
      counts.needsYou += 1;
    } else if (row.bucket === "running") {
      counts.working += 1;
    } else if (row.bucket === "ready") {
      counts.ready += 1;
    } else if (row.bucket === "done") {
      counts.done += 1;
    }
  }
  return counts;
}
