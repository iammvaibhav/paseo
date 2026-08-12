import { useCallback, useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { isHistoryAskAgent } from "@/history-ask";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  useSidebarWorkspaceAgentsStore,
  type SidebarAgentsSort,
} from "@/stores/sidebar-workspace-agents-store";

export interface SidebarAgentEntry {
  agentId: string;
  /** User-facing title (null when the agent never got one). */
  title: string | null;
  /** Assigned agent name (identity chip); older daemons omit it. */
  name: string | null;
  model: string | null;
  statusBucket: SidebarStateBucket;
  requiresAttention: boolean;
  createdAt: Date;
  lastActivityAt: Date;
}

const EMPTY_SIDEBAR_AGENTS: readonly SidebarAgentEntry[] = [];

/**
 * The root agents living in a workspace, as sidebar rows. Mirrors the workspace tab strip:
 * root agents only (subagents nest inside their parent), History Ask machinery excluded,
 * archived agents dropped.
 */
export function buildSidebarWorkspaceAgents(
  agents: ReadonlyMap<string, Agent> | undefined,
  workspaceId: string,
): SidebarAgentEntry[] {
  if (!agents || agents.size === 0) {
    return [];
  }
  const entries: SidebarAgentEntry[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt) {
      continue;
    }
    if (agent.workspaceId !== workspaceId) {
      continue;
    }
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (!isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }
    if (isHistoryAskAgent(agent.labels)) {
      continue;
    }
    entries.push({
      agentId: agent.id,
      title: agent.title ?? null,
      name: agent.name ?? null,
      model: agent.model ?? null,
      statusBucket: deriveSidebarStateBucket({
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
      }),
      requiresAttention: Boolean(agent.requiresAttention),
      createdAt: agent.createdAt,
      lastActivityAt: agent.lastActivityAt,
    });
  }
  return entries;
}

/** Newest first. Tie-break by id so the order is deterministic when timestamps collide. */
export function sortSidebarWorkspaceAgents(
  agents: readonly SidebarAgentEntry[],
  sort: SidebarAgentsSort,
): readonly SidebarAgentEntry[] {
  if (agents.length <= 1) {
    return agents;
  }
  const key = sort === "created" ? "createdAt" : "lastActivityAt";
  const sorted = [...agents];
  sorted.sort((left, right) => {
    const delta = right[key].getTime() - left[key].getTime();
    if (delta !== 0) {
      return delta;
    }
    return left.agentId.localeCompare(right.agentId);
  });
  return sorted;
}

export function useSidebarWorkspaceAgents(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
}): {
  sortedAgents: readonly SidebarAgentEntry[];
  hasAgents: boolean;
  expanded: boolean;
  toggleExpanded: () => void;
  agentsSort: SidebarAgentsSort;
  setAgentsSort: (sort: SidebarAgentsSort) => void;
} {
  const { serverId, workspaceId, workspaceKey } = input;
  // Subscribing to the agents Map reference (not a derivation) keeps a row out of the
  // session store's churn: it only re-renders when its server's agent set actually
  // changes, and the per-workspace derivation is memoized on that reference.
  const agents = useStoreWithEqualityFn(
    useSessionStore,
    (state) => state.sessions[serverId]?.agents,
    Object.is,
  );
  const workspaceAgents = useMemo(
    () => buildSidebarWorkspaceAgents(agents, workspaceId),
    [agents, workspaceId],
  );
  const agentsSort = useSidebarWorkspaceAgentsStore((s) => s.agentsSort);
  const sortedAgents = useMemo(
    () => sortSidebarWorkspaceAgents(workspaceAgents, agentsSort),
    [workspaceAgents, agentsSort],
  );
  const expanded = useSidebarWorkspaceAgentsStore((s) => s.expandedWorkspaceKeys.has(workspaceKey));
  const toggleWorkspaceExpanded = useSidebarWorkspaceAgentsStore((s) => s.toggleWorkspaceExpanded);
  const toggleExpanded = useCallback(
    () => toggleWorkspaceExpanded(workspaceKey),
    [toggleWorkspaceExpanded, workspaceKey],
  );
  const setAgentsSort = useSidebarWorkspaceAgentsStore((s) => s.setAgentsSort);

  return {
    sortedAgents: workspaceAgents.length > 0 ? sortedAgents : EMPTY_SIDEBAR_AGENTS,
    hasAgents: workspaceAgents.length > 0,
    expanded,
    toggleExpanded,
    agentsSort,
    setAgentsSort,
  };
}
