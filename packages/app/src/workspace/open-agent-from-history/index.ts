import { hostSupportsFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { storeFetchedAgentDetail } from "@/utils/hydrate-fetched-agent";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { resolveOpenAgentFromHistory, type OpenAgentFromHistoryInput } from "./resolve";

export type { OpenAgentFromHistoryInput } from "./resolve";

export function openAgentFromHistory(input: OpenAgentFromHistoryInput): Promise<void> {
  return resolveOpenAgentFromHistory(input, {
    hydrateArchivedAgent: async ({ serverId, agentId }) => {
      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) {
        return;
      }
      try {
        const result = await client.fetchAgent({ agentId });
        if (result) {
          storeFetchedAgentDetail({ serverId, result });
        }
      } catch {
        // Best effort — navigate regardless so the user still lands on the agent.
      }
    },
    unarchiveAgent: async ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const client = session?.client ?? null;
      if (!client) {
        return;
      }
      try {
        // The archived workspace and project come back first, so the agent opens
        // in a live workspace with a working composer. When they cannot, the host
        // keeps the agent archived and the workspace route explains why.
        if (hostSupportsFeature(session?.serverInfo, "agentUnarchive")) {
          await client.unarchiveAgentWithWorkspace(agentId);
        }
        // Same path as the archived callout's Unarchive button: native unarchive
        // + resume so ensureAgentIsInitialized and timeline catch-up can run.
        await client.refreshAgent(agentId);
      } catch {
        // Best effort — still navigate; pane can show archived/error UI.
      }
    },
    navigateToAgent: (route) => {
      navigateToAgent(route);
    },
  });
}
