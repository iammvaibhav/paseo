import { z } from "zod";

/**
 * Sidebar agent search: plain full-text search over one host's agents (name,
 * title, id, reported status, launch prompt, last report, and the FTS5
 * transcript index). Served by every daemon over agent.search.*; the sidebar
 * search bar fans one request out to each host and narrows what the sidebar
 * shows. History Ask stays the deep search.
 */

export const AgentSearchRequestSchema = z.object({
  type: z.literal("agent.search.request"),
  requestId: z.string(),
  // Blank = the search bar opened: the host warms live launch prompts and
  // answers with no matches.
  query: z.string(),
  // Also rank archived agents. Absent = active agents only.
  includeArchived: z.boolean().optional(),
});
export type AgentSearchRequest = z.infer<typeof AgentSearchRequestSchema>;

export const AgentSearchMatchSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  // The agent's generated name; rows fall back to it when the title is empty.
  name: z.string().nullable().optional(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  archivedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  // COMPAT(agentSearchJev): the removed jev ranker's probability; daemons send
  // null since v0.11.0-beta.4. Remove after 2026-12-31.
  score: z.number().nullable(),
  // Every query word appears in the agent's name, title, id, description,
  // launch prompt, or last report. False = the match came from its transcript.
  lexical: z.boolean(),
});
export type AgentSearchMatch = z.infer<typeof AgentSearchMatchSchema>;

export const AgentSearchResponseSchema = z.object({
  type: z.literal("agent.search.response"),
  payload: z.object({
    requestId: z.string(),
    // Best first.
    matches: z.array(AgentSearchMatchSchema),
    // COMPAT(agentSearchJev): always false since v0.11.0-beta.4. Remove after 2026-12-31.
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
