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
 * an archived agent we first hydrate its record into the store (so reconcile
 * counts it as "known") and pin the tab (so reconcile keeps it), which lets the
 * pane mount as a read-only timeline with the Unarchive callout.
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
  deps.navigateToAgent({
    serverId: input.serverId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    pin: true,
  });
}
