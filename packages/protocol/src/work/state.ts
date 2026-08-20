import type { LifecycleBucket } from "../agent-state-bucket.js";

/** The only states a human writes directly, and the only ones stored. */
export type WorkItemLane = "backlog" | "todo";

/** Board columns. A grouping over lanes + LifecycleBucket. NOT a state machine. */
export type WorkColumnId = "backlog" | "todo" | "in_progress" | "in_review" | "needs_me" | "done";

export const WORK_COLUMN_IDS = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "needs_me",
  "done",
] as const satisfies readonly WorkColumnId[];

export const BUCKET_TO_COLUMN = {
  running: "in_progress",
  idle: "in_progress",
  needs_you: "needs_me",
  ready: "in_review",
  done: "done",
} as const satisfies Record<LifecycleBucket, WorkColumnId>;

export function deriveWorkColumn(
  item: { lane: WorkItemLane; closed: { state: "done" | "cancelled" } | null },
  agentBucket: LifecycleBucket | null,
): WorkColumnId | "cancelled" {
  if (item.closed) return item.closed.state;
  if (agentBucket) return BUCKET_TO_COLUMN[agentBucket];
  return item.lane;
}

export function isWorkColumnDroppable(column: WorkColumnId): boolean {
  return column !== "needs_me";
}

export type WorkMoveIntent =
  | { kind: "set_lane"; lane: WorkItemLane }
  | { kind: "dispatch_now" }
  | { kind: "set_review_state"; reviewState: "ready" | "done" }
  | { kind: "detach_agent" }
  | { kind: "reject"; reason: string };

export function resolveWorkMoveIntent(input: {
  item: {
    lane: WorkItemLane;
    closed: { state: "done" | "cancelled" } | null;
    agentId: string | null;
  };
  targetColumn: WorkColumnId;
  agentBucket: LifecycleBucket | null;
}): WorkMoveIntent {
  const { item, targetColumn, agentBucket } = input;

  if (targetColumn === "needs_me") {
    return { kind: "reject", reason: "needs_me is not a drop target" };
  }

  if (targetColumn === "backlog") {
    if (!item.agentId) return { kind: "set_lane", lane: "backlog" };
    if (agentBucket === "idle" || agentBucket === "done") return { kind: "detach_agent" };
    return { kind: "reject", reason: "backlog drop requires no agent or idle/done bucket" };
  }

  if (targetColumn === "todo") {
    if (item.agentId) return { kind: "reject", reason: "todo drop requires no linked agent" };
    return { kind: "set_lane", lane: "todo" };
  }

  if (targetColumn === "in_progress") {
    if (item.lane !== "todo")
      return { kind: "reject", reason: "in_progress dispatch requires lane todo" };
    return { kind: "dispatch_now" };
  }

  if (targetColumn === "in_review") {
    if (!item.agentId) return { kind: "reject", reason: "in_review requires a linked agent" };
    return { kind: "set_review_state", reviewState: "ready" };
  }

  if (targetColumn === "done") {
    return { kind: "set_review_state", reviewState: "done" };
  }

  return { kind: "reject", reason: "unknown column" };
}

export function computeSortOrder(input: {
  prevSortOrder: number | null;
  nextSortOrder: number | null;
}): number {
  const { prevSortOrder, nextSortOrder } = input;
  if (prevSortOrder === null) return nextSortOrder === null ? 65535 : nextSortOrder - 65535;
  if (nextSortOrder === null) return prevSortOrder + 65535;
  return (prevSortOrder + nextSortOrder) / 2;
}

export function needsSortOrderRebalance(gap: number): boolean {
  return gap < 1;
}
