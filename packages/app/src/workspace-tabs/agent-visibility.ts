import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  foreignAgentIds: Set<string>;
}

// Bound for the non-root-agent diagnostic below: deriveWorkspaceAgentVisibility
// recomputes whenever session layout changes, and the same agent id would be
// re-evaluated every time. The signal that matters is the FIRST observation —
// it names the decision inputs (parent present or not) — so an id logs once
// and is then dropped from the Set for the life of the module. A Set member
// is at most one line per agent id, never per recomputation. Resets on app
// restart (module reload), which is acceptable: the diagnostic targets a
// session-visible anomaly, one line per offending agent per process.
const loggedNonRootAgentIds = new Set<string>();

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      foreignAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const foreignAgentIds = new Set<string>();
  for (const agent of sessionAgents?.values() ?? []) {
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId !== workspaceId) {
      if (ownerId) {
        foreignAgentIds.add(agent.id);
      }
      continue;
    }
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      const parentAgent = agent.parentAgentId
        ? (sessionAgents?.get(agent.parentAgentId) ?? agentDetails?.get(agent.parentAgentId))
        : undefined;
      if (isWorkspaceRootAgent(agent, parentAgent)) {
        autoOpenAgentIds.add(agent.id);
      } else {
        logNonRootWorkspaceAgentOnce(agent, workspaceId, parentAgent);
      }
    }
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (sessionAgents?.has(agent.id)) {
      continue;
    }
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId && ownerId !== workspaceId) {
      foreignAgentIds.add(agent.id);
    }
  }
  return { activeAgentIds, autoOpenAgentIds, foreignAgentIds };
}

/**
 * Diagnostics — at most once per agent id (see loggedNonRootAgentIds): a workspace agent that
 * will NOT auto-open as its own tab. parentFoundLocally:false is the cross-host-Commander case —
 * the parent record lives on another daemon and is absent from this host's store — which
 * mis-rendered the agent as missing from its own workspace. The Set bound keeps a session-store
 * recomputation from logging the same id on every pass.
 */
function logNonRootWorkspaceAgentOnce(
  agent: Agent,
  workspaceId: string,
  parentAgent: Agent | undefined,
): void {
  if (loggedNonRootAgentIds.has(agent.id)) return;
  loggedNonRootAgentIds.add(agent.id);
  console.warn("[AgentVisibility] workspace agent not a workspace root agent", {
    agentId: agent.id,
    workspaceId,
    parentAgentId: agent.parentAgentId,
    parentFoundLocally: parentAgent !== undefined,
  });
}

interface AgentMapsSnapshot {
  sessions: Record<
    string,
    { agents: Map<string, Agent>; agentDetails: Map<string, Agent> } | undefined
  >;
}

// Session-store selectors run on every store update, including every stream tick, which
// leaves the agent maps untouched. Reuse the previous result until either map changes, and
// keep it when a recompute yields the same sets so the hook's equality check stays O(1).
export function createWorkspaceAgentVisibilitySelector(input: {
  serverId: string;
  workspaceId: string | null | undefined;
}): (state: AgentMapsSnapshot) => WorkspaceAgentVisibility {
  let previousAgents: Map<string, Agent> | undefined;
  let previousAgentDetails: Map<string, Agent> | undefined;
  let previousVisibility: WorkspaceAgentVisibility | null = null;

  return (state) => {
    const session = state.sessions[input.serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    if (previousVisibility && agents === previousAgents && agentDetails === previousAgentDetails) {
      return previousVisibility;
    }

    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: agents,
      agentDetails,
      workspaceId: input.workspaceId,
    });
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    if (!previousVisibility || !workspaceAgentVisibilityEqual(previousVisibility, visibility)) {
      previousVisibility = visibility;
    }
    return previousVisibility;
  };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    foreignAgentIds: input.agentVisibility.foreignAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    a === b ||
    (setsEqual(a.activeAgentIds, b.activeAgentIds) &&
      setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
      setsEqual(a.foreignAgentIds, b.foreignAgentIds))
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}
