import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type WorkspaceAgent = Pick<Agent, "parentAgentId" | "workspaceId">;

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent: Pick<Agent, "workspaceId"> | undefined,
): boolean {
  if (!agent.parentAgentId) {
    return true;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspaceId = normalizeWorkspaceOpaqueId(parentAgent?.workspaceId);
  // Parent record not on this host — a Mission Control worker dispatched by a
  // Commander running elsewhere. Nesting cannot be established, and assuming
  // it hid the agent from its own workspace entirely. An agent we cannot
  // prove is nested is a root agent.
  if (!parentWorkspaceId) {
    return true;
  }
  return Boolean(workspaceId && workspaceId !== parentWorkspaceId);
}
