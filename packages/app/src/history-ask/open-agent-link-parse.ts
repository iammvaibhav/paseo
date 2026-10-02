import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

/**
 * Parse History Ask / deep-link citations into a host+agent target.
 * Accepts:
 * - `paseo://h/{serverId}/agent/{agentId}` (canonical)
 * - path-only `/h/{serverId}/agent/{agentId}`
 */
export function parseHistoryAskAgentOpenUrl(url: string): AgentDeepLinkTarget | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const asDeepLink = parseAgentDeepLink(trimmed);
  if (asDeepLink) {
    return asDeepLink;
  }

  if (trimmed.startsWith("/h/")) {
    return parseAgentDeepLink(`paseo:/${trimmed}`);
  }

  return null;
}
