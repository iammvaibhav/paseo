import { AgentSearchTier, agentIdentitySearchTier } from "@getpaseo/protocol/agent-search";

/** What the sidebar needs to order search matches from every host as one list. */
export interface SidebarSearchRanking {
  words: readonly string[];
  /**
   * `serverId:agentId` of each transcript-only match → its position among its
   * host's transcript-only matches, best first. Hosts' bm25 scores are not
   * comparable, so the first transcript hit of each host ranks alike.
   */
  transcriptPositions: ReadonlyMap<string, number>;
}

interface SidebarSearchRank {
  tier: AgentSearchTier;
  position: number;
}

/**
 * Exact and identity tiers come from the agent's own name, title, and id, so a
 * row ranks the same before and after its host answers. A match the client
 * cannot explain came from the host: its transcript when the host said so,
 * otherwise its description, launch prompt, or last report.
 */
function rankSidebarSearchMatch(
  ranking: SidebarSearchRanking,
  key: string,
  agent: { id: string; name?: string | null; title?: string | null },
): SidebarSearchRank {
  const identityTier = agentIdentitySearchTier(ranking.words, agent);
  if (identityTier !== null) return { tier: identityTier, position: 0 };
  const position = ranking.transcriptPositions.get(key);
  if (position !== undefined) return { tier: AgentSearchTier.Transcript, position };
  return { tier: AgentSearchTier.Metadata, position: 0 };
}

/**
 * Orders search matches best first: exact query in the title, every word in
 * name/title/id, other metadata, transcript-only; newest first within a tier.
 */
export function sortBySidebarSearchRank<T>(
  ranking: SidebarSearchRanking,
  items: readonly T[],
  describe: (item: T) => {
    key: string;
    agent: { id: string; name?: string | null; title?: string | null };
    activityMs: number;
  },
): T[] {
  return items
    .map((item) => {
      const { key, agent, activityMs } = describe(item);
      return { item, activityMs, rank: rankSidebarSearchMatch(ranking, key, agent) };
    })
    .sort(
      (left, right) =>
        left.rank.tier - right.rank.tier ||
        left.rank.position - right.rank.position ||
        right.activityMs - left.activityMs,
    )
    .map(({ item }) => item);
}
