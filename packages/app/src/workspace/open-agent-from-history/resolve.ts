export interface OpenAgentFromHistoryInput {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  archived: boolean;
}

export interface OpenAgentFromHistoryDeps {
  // Load the archived agent into the session store. Must resolve (never reject)
  // so navigation still happens on a best-effort basis if the fetch fails.
  hydrateArchivedAgent: (input: { serverId: string; agentId: string }) => Promise<void>;
  // Resume the provider runtime (unarchive). Must resolve (never reject) so a
  // refresh failure still opens the tab; the pane can show errors/retry.
  unarchiveAgent: (input: { serverId: string; agentId: string }) => Promise<void>;
  navigateToAgent: (input: {
    serverId: string;
    agentId: string;
    workspaceId?: string | null;
    pin?: boolean;
  }) => void;
}

/**
 * Open an agent selected from the History list.
 *
 * Active agents live in the host's active agent directory, so navigating
 * straight to their workspace tab works. Archived agents are absent from that
 * directory: the workspace tab reconcile would treat the freshly opened tab as
 * unknown + inactive and prune it, dropping focus onto whatever active agent
 * still lives in the same workspace (the "opens the wrong agent" bug). To open
 * an archived agent we hydrate its record (so reconcile counts it as "known"),
 * unarchive/resume immediately (so timeline init runs and history is visible —
 * no second Unarchive click), and pin the tab until the active directory
 * catches up.
 */
export async function resolveOpenAgentFromHistory(
  input: OpenAgentFromHistoryInput,
  deps: OpenAgentFromHistoryDeps,
): Promise<void> {
  if (!input.archived) {
    deps.navigateToAgent({
      serverId: input.serverId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    return;
  }

  await deps.hydrateArchivedAgent({ serverId: input.serverId, agentId: input.agentId });
  await deps.unarchiveAgent({ serverId: input.serverId, agentId: input.agentId });
  deps.navigateToAgent({
    serverId: input.serverId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    pin: true,
  });
}
