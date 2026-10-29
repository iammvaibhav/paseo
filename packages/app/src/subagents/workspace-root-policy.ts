import { PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type WorkspaceAgent = Pick<Agent, "parentAgentId" | "workspaceId"> & {
  labels?: Agent["labels"];
};

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent: Pick<Agent, "workspaceId"> | undefined,
): boolean {
  if (!agent.parentAgentId) {
    return true;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspaceId = normalizeWorkspaceOpaqueId(parentAgent?.workspaceId);
  if (!parentWorkspaceId) {
    // A parent label that names its host names this one (a parent on another host clears
    // parentAgentId), so the parent arrives with this host's directory: stay nested until then.
    // A label without a host is how a Mission Control Commander on another host marks its
    // workers; nesting cannot be established, and assuming it hid the agent from its own
    // workspace, so such an agent is a root agent.
    return !agent.labels?.[PARENT_SERVER_ID_LABEL];
  }
  return Boolean(workspaceId && workspaceId !== parentWorkspaceId);
}
