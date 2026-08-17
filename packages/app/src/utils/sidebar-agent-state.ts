import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import {
  deriveLifecycleBucket,
  type AgentAttentionReason,
  type LifecycleBucket,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarLifecycleBucket = LifecycleBucket;
export type SidebarAttentionReason = AgentAttentionReason;

/**
 * Sidebar visual vocabulary, shared with workspace-status rendering
 * (workspace rows and project badges key off the same strings).
 */
export type SidebarStateBucket = "needs_input" | "failed" | "running" | "attention" | "done";

export interface SidebarAgentBucketInput {
  /** Canonical daemon-owned bucket (spec 01); absent on older daemons. */
  bucket?: LifecycleBucket | null;
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  attentionReason?: AgentAttentionReason;
  stoppedBy?: "user" | "machinery" | "system" | null;
}

/** Canonical bucket to the shared sidebar/workspace visual vocabulary. */
const LIFECYCLE_TO_SIDEBAR: Record<LifecycleBucket, SidebarStateBucket> = {
  needs_you: "needs_input",
  running: "running",
  ready: "attention",
  done: "done",
  idle: "done",
};

/**
 * The canonical lifecycle bucket: the daemon-owned field when present, else
 * the spec-01 derivation over the payload fields (older daemons omit the
 * field). reviewState and the proposal index are server-side state the client
 * payload cannot see: a finished run with no recorded user stop reads as
 * ready for review, and everything else without recorded state is idle.
 */
export function deriveSidebarLifecycleBucket(input: SidebarAgentBucketInput): LifecycleBucket {
  if (input.bucket) {
    return input.bucket;
  }
  const userStopped = input.stoppedBy === "user";
  const reviewState = input.attentionReason === "finished" && !userStopped ? "ready" : "none";
  return deriveLifecycleBucket({
    pendingPermissionCount: input.pendingPermissionCount ?? 0,
    pendingProposalCount: 0,
    attentionReason: input.attentionReason ?? null,
    lastStatus: input.status,
    running: input.status === "running" || input.status === "initializing",
    reviewState,
    stopOrigin: input.stoppedBy ?? null,
  });
}

export function deriveSidebarStateBucket(input: SidebarAgentBucketInput): SidebarStateBucket {
  return LIFECYCLE_TO_SIDEBAR[deriveSidebarLifecycleBucket(input)];
}

// Most urgent first, for collapsing a project's workspaces into one badge. This is
// deliberately NOT the flat status-list order (STATUS_BUCKET_ORDER in
// hooks/sidebar-status-view-model.ts), which ranks "attention" above "running": on a
// collapsed project row we want an actively-working project to keep showing the loader,
// so "running" outranks "attention" here. Blocked (needs_input) and failed still win over
// both; done stays last.
const STATUS_BUCKET_PRIORITY: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
];

export function getSidebarStateBucketPriority(bucket: SidebarStateBucket): number {
  const rank = STATUS_BUCKET_PRIORITY.indexOf(bucket);
  return rank === -1 ? STATUS_BUCKET_PRIORITY.length - 1 : rank;
}

/**
 * Collapses many workspace status buckets into the single most urgent one, so a
 * collapsed project row can stand in for the child rows it hides.
 */
export function aggregateSidebarStateBuckets(
  buckets: Iterable<SidebarStateBucket>,
): SidebarStateBucket {
  let bestRank = STATUS_BUCKET_PRIORITY.length - 1;
  for (const bucket of buckets) {
    const rank = STATUS_BUCKET_PRIORITY.indexOf(bucket);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
    }
  }
  return STATUS_BUCKET_PRIORITY[bestRank] ?? "done";
}
