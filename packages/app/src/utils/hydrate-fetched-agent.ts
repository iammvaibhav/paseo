import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";

export type FetchAgentResult = Awaited<ReturnType<DaemonClient["fetchAgent"]>>;

function shouldStoreFetchedAgentInActiveDirectory(agent: Agent): boolean {
  return !agent.archivedAt && Boolean(agent.projectPlacement);
}

/**
 * Hydrate a freshly fetched agent snapshot into the session store.
 *
 * Active, project-placed agents go into the live agent directory. Archived (or
 * placement-less) agents go into `agentDetails` so panes and the workspace tab
 * reconcile can treat them as "known" and render them read-only — without
 * polluting the active agent lists. The `applyLegacyDaemonWorkspaceOwnership`
 * pass here also normalizes the agent's `workspaceId`, which is what lets
 * `deriveWorkspaceAgentVisibility` attribute the agent to the right workspace.
 */
export function storeFetchedAgentDetail(input: {
  serverId: string;
  result: NonNullable<FetchAgentResult>;
}): Agent {
  const normalized = normalizeAgentSnapshot(input.result.agent, input.serverId);
  const hydrated: Agent = applyLegacyDaemonWorkspaceOwnership({
    serverId: input.serverId,
    agent: {
      ...normalized,
      projectPlacement: input.result.project,
    },
  });
  const store = useSessionStore.getState();

  if (shouldStoreFetchedAgentInActiveDirectory(hydrated)) {
    store.setAgents(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  } else {
    store.setAgentDetails(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  }

  store.setPendingPermissions(input.serverId, (previous) => {
    const next = new Map(previous);
    for (const [key, pending] of next.entries()) {
      if (pending.agentId === hydrated.id) {
        next.delete(key);
      }
    }
    for (const request of hydrated.pendingPermissions) {
      const key = derivePendingPermissionKey(hydrated.id, request);
      next.set(key, { key, agentId: hydrated.id, request });
    }
    return next;
  });

  return hydrated;
}
