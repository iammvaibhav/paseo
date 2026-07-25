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
    navigateToAgent: (route) => {
      navigateToAgent(route);
    },
  });
}
