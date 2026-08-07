import type { Agent } from "@/stores/session-store";
import { isCommanderAgent } from "@/mission-control/labels";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "labels"> | null | undefined,
): CloseAgentTabPolicy {
  // Subagents report through their parent; the Commander (label
  // `paseo.mission-control=*`) is never archivable — closing its tab only
  // closes the tab.
  if (agent?.parentAgentId || isCommanderAgent(agent?.labels)) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
