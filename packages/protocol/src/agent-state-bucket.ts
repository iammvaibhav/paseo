import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

// ============================================================================
// Canonical Mission Control lifecycle bucket (spec 01). One derivation for
// every consumer: roster, fleet_list_agents rows, agent snapshot payloads,
// and the world snapshot. Computed server-side from STORED state (agent
// record + review-state.json + proposal index), never from a truncated client
// event fold.
// ============================================================================

export type LifecycleBucket = "needs_you" | "running" | "ready" | "done" | "idle";

export interface LifecycleBucketInput {
  /** Outstanding permission requests on the live agent. */
  pendingPermissionCount: number;
  /** Pending proposals only; expired/failed are excluded. */
  pendingProposalCount: number;
  /**
   * Live attention reason. "finished" is READ-ONLY compat for records latched
   * before the finish latch was removed (finish now notifies directly and
   * never latches attention): it is accepted on read and never drives
   * needs_you.
   * COMPAT(finished-attention): latch removed in v0.3, remove after 2026-12-01.
   */
  attentionReason: "error" | "permission" | "finished" | null;
  /** Agent lifecycle status ("error" drives needs_you). */
  lastStatus: string | null;
  /** Lifecycle running/initializing. */
  running: boolean;
  reviewState: "none" | "ready" | "done" | "cleared";
  stopOrigin: "user" | "machinery" | "system" | null;
}

/**
 * Precedence (first match wins; a user stop excludes rule 1 so a stopped
 * agent never reads "needs you" — the user's stop is the terminal story):
 * 1. needs_you — pendingPermissionCount>0 | attentionReason=="permission"
 *    | lastStatus=="error" | attentionReason=="error" | pendingProposalCount>0
 * 2. running — running
 * 3. done — stopOrigin=="user" && reviewState ∈ {"none","cleared"}
 * 4. done — reviewState=="done"
 * 5. ready — reviewState=="ready"
 * 6. idle
 */
export function deriveLifecycleBucket(input: LifecycleBucketInput): LifecycleBucket {
  const userStopped = input.stopOrigin === "user";
  if (!userStopped) {
    if (input.pendingPermissionCount > 0 || input.attentionReason === "permission") {
      return "needs_you";
    }
    if (input.lastStatus === "error" || input.attentionReason === "error") {
      return "needs_you";
    }
    if (input.pendingProposalCount > 0) {
      return "needs_you";
    }
  }
  if (input.running) {
    return "running";
  }
  if (userStopped && (input.reviewState === "none" || input.reviewState === "cleared")) {
    return "done";
  }
  if (input.reviewState === "done") {
    return "done";
  }
  if (input.reviewState === "ready") {
    return "ready";
  }
  return "idle";
}

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return "failed";
  }
  if (input.status === "running") {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceStateBucket): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return 1;
  }
  if (input.status === "running") {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
