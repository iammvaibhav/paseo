import { z } from "zod";

/**
 * Shallow agent search: rank this host's agents against a query with one
 * jev pass over a short card per agent (title, launch prompt, reported
 * status). Served by every daemon over agent.search.*; the sidebar search
 * bar fans one request out to each host and narrows what the sidebar shows.
 * History Ask stays the deep search.
 */

export const AgentSearchRequestSchema = z.object({
  type: z.literal("agent.search.request"),
  requestId: z.string(),
  // Blank = the search bar opened: the host warms its TypeSafe key and
  // launch prompts and answers with no matches.
  query: z.string(),
  // Also rank archived agents. Absent = active agents only.
  includeArchived: z.boolean().optional(),
});
export type AgentSearchRequest = z.infer<typeof AgentSearchRequestSchema>;

export const AgentSearchMatchSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  archivedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  // jev probability that the agent matches the query; null when jev did not
  // run (no TypeSafe key, or the call failed).
  score: z.number().nullable(),
  // Every query word appears in the agent's title, name, description, or
  // launch prompt.
  lexical: z.boolean(),
});
export type AgentSearchMatch = z.infer<typeof AgentSearchMatchSchema>;

export const AgentSearchResponseSchema = z.object({
  type: z.literal("agent.search.response"),
  payload: z.object({
    requestId: z.string(),
    // Best first.
    matches: z.array(AgentSearchMatchSchema),
    // jev ranked the candidates. False = word matches only.
    semantic: z.boolean(),
    candidateCount: z.number(),
    latencyMs: z.number(),
    error: z.string().nullable(),
  }),
});
export type AgentSearchResponse = z.infer<typeof AgentSearchResponseSchema>;

/** Lowercased query words; empty when the query is blank. */
export function agentSearchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every word appears in at least one of the fields. Shared by daemon and sidebar. */
export function matchesAgentSearchWords(
  words: readonly string[],
  fields: readonly (string | null | undefined)[],
): boolean {
  if (words.length === 0) return false;
  const haystack = fields
    .filter((field): field is string => Boolean(field))
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
