import { useSessionStore } from "@/stores/session-store";

/**
 * Reads the latest user message for an agent from agentStreamHead/agentStreamTail in reverse order.
 * Returns the message text if found, or null if no user message exists.
 */
export function useLastUserMessage(serverId: string, agentId: string): string | null {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    const head = session?.agentStreamHead?.get(agentId);
    if (head && head.length > 0) {
      for (let index = head.length - 1; index >= 0; index--) {
        const item = head[index];
        if (
          item &&
          item.kind === "user_message" &&
          typeof item.text === "string" &&
          item.text.trim().length > 0
        ) {
          return item.text.trim();
        }
      }
    }
    const tail = session?.agentStreamTail?.get(agentId);
    if (tail && tail.length > 0) {
      for (let index = tail.length - 1; index >= 0; index--) {
        const item = tail[index];
        if (
          item &&
          item.kind === "user_message" &&
          typeof item.text === "string" &&
          item.text.trim().length > 0
        ) {
          return item.text.trim();
        }
      }
    }
    return null;
  });
}
