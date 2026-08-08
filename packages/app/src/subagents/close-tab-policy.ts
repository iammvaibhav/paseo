import type { Agent } from "@/stores/session-store";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "labels"> | null | undefined,
): CloseAgentTabPolicy {
  // Subagents report through their parent; system-owned agents (Commander,
  // verifiers, machinery) are never archivable — closing their tab only
  // closes the tab.
  if (agent?.parentAgentId || isSystemOwnedAgentLabels(agent?.labels)) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
