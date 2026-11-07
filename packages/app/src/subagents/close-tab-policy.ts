import type { Agent } from "@/stores/session-store";
import {
  isCommanderLabels,
  isSystemOwnedAgentLabels,
} from "@getpaseo/protocol/mission-control/system-owned";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "labels" | "workspaceId"> | null | undefined,
  parentAgent?: Pick<Agent, "labels" | "workspaceId"> | null | undefined,
): CloseAgentTabPolicy {
  // System-owned agents (Commander, verifiers, machinery) are never
  // archivable — closing their tab only closes the tab.
  if (isSystemOwnedAgentLabels(agent?.labels)) {
    return { kind: "layout-only" };
  }
  if (!agent) {
    return { kind: "archive-on-close" };
  }
  // Command parentage is not nesting. A worker whose parent record is the
  // Commander was dispatched (fleet_create_agent), not spawned as a
  // subagent — its close archives like a root agent. This holds whether the
  // Commander runs on this host (parent record resolves, and its labels say
  // so) or on another host (parent record never resolves — the same
  // unresolvable-parent test the sidebar uses for workspace visibility).
  if (agent.parentAgentId && parentAgent && isCommanderLabels(parentAgent.labels)) {
    return { kind: "archive-on-close" };
  }
  return isWorkspaceRootAgent(agent, parentAgent ?? undefined)
    ? { kind: "archive-on-close" }
    : { kind: "layout-only" };
}
