import { useSessionStore } from "@/stores/session-store";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { parseHistoryAskAgentOpenUrl } from "./open-agent-link-parse";

export { parseHistoryAskAgentOpenUrl } from "./open-agent-link-parse";

/**
 * Open an agent the same way History list rows do (hydrate / unarchive + navigate).
 * Returns true when the URL was an agent deep link (handled or in-flight).
 */
export function openHistoryAskAgentLink(url: string): boolean {
  const target = parseHistoryAskAgentOpenUrl(url);
  if (!target) {
    return false;
  }

  const session = useSessionStore.getState().sessions[target.serverId];
  const agent = session?.agents.get(target.agentId);
  // Known active agent → navigate. Unknown / archived → hydrate + unarchive path.
  const archived = agent ? Boolean(agent.archivedAt) : true;

  void openAgentFromHistory({
    serverId: target.serverId,
    agentId: target.agentId,
    workspaceId: agent?.workspaceId ?? null,
    archived,
  });
  return true;
}
