import type {
  AgentSearchMatch,
  AgentSnapshotPayload,
  ProjectPlacementPayload,
} from "@getpaseo/protocol/messages";
import {
  compareMatchScores,
  fuzzyPolicyForToken,
  type MatchRange,
  type MatchScore,
  matchRanges,
  scoreMatch,
  tokenizeQuery,
} from "@getpaseo/protocol/search/text-match";

/**
 * History search ranks session names first, then transcript hits from the
 * FTS index. A title match still beats a body match; a body-only hit is how
 * "search across everything" finds a PR URL that never made it into the title.
 *
 * Field order is the tie-break order among names. Workspace and agent titles
 * are what people actually recall; a project name matches every session in the
 * repo, so it ranks last and only decides ties.
 */

export interface AgentHistorySearchCandidate {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
}

/** In tie-break order; the index into this list is a field's rank. */
const SEARCH_FIELDS = ["workspace", "title", "branch", "project"] as const;

type SearchField = (typeof SEARCH_FIELDS)[number];

function searchableFields(candidate: AgentHistorySearchCandidate): string[] {
  const { agent, project } = candidate;
  return [
    project.workspaceName ?? "",
    agent.title ?? "",
    project.checkout.currentBranch ?? "",
    project.projectName,
  ];
}

interface FieldMatch {
  score: MatchScore;
  fieldRank: number;
  token: string;
}

function bestFieldMatch(token: string, fields: string[]): FieldMatch | null {
  const fuzzy = fuzzyPolicyForToken(token);
  let best: FieldMatch | null = null;
  for (let fieldRank = 0; fieldRank < fields.length; fieldRank += 1) {
    const field = fields[fieldRank];
    if (!field) continue;
    const score = scoreMatch(token, field, { fuzzy });
    if (!score) continue;
    if (!best || compareMatchScores(score, best.score) < 0) {
      best = { score, fieldRank, token };
    }
  }
  return best;
}

/** Overlapping spans from different tokens would double-mark the same glyphs. */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.start + last.length) {
      last.length = Math.max(last.length, range.start + range.length - last.start);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/**
 * One number so the wire can carry relevance and several hosts' pages can be
 * merged by it. Tier dominates, then which field matched, then how deep into
 * that field the match sat.
 */
function toSearchScore(matches: readonly FieldMatch[]): number {
  let total = 0;
  for (const match of matches) {
    total += match.score.tier * 1_000 + match.fieldRank * 100 + Math.min(match.score.offset, 99);
  }
  return total;
}

/**
 * Every token has to match something, so adding a word always narrows. Tokens
 * may land on different fields — "stripe main" finds the Stripe workspace on
 * the main branch.
 */
export function scoreAgentHistoryCandidate(
  query: string,
  candidate: AgentHistorySearchCandidate,
): number | null {
  const matches = matchAgentHistoryCandidate(query, candidate);
  return matches ? toSearchScore(matches) : null;
}

function matchAgentHistoryCandidate(
  query: string,
  candidate: AgentHistorySearchCandidate,
): FieldMatch[] | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;

  const fields = searchableFields(candidate);
  const matches: FieldMatch[] = [];
  for (const token of tokens) {
    const match = bestFieldMatch(token, fields);
    if (!match) return null;
    matches.push(match);
  }
  return matches;
}

/**
 * Where the query landed in each field, for the rows that will actually be
 * rendered. The ranker already knows this; sending it means the client never
 * has to re-derive a second opinion that could disagree with the ranking it is
 * explaining.
 */
export function describeAgentHistoryMatches(
  query: string,
  candidate: AgentHistorySearchCandidate,
): AgentSearchMatch[] {
  const matches = matchAgentHistoryCandidate(query, candidate);
  if (!matches) return [];

  const fields = searchableFields(candidate);
  const rangesByField = new Map<SearchField, MatchRange[]>();
  for (const match of matches) {
    const field = SEARCH_FIELDS[match.fieldRank];
    const ranges = matchRanges(match.token, fields[match.fieldRank], match.score);
    rangesByField.set(field, [...(rangesByField.get(field) ?? []), ...ranges]);
  }

  return [...rangesByField.entries()].map(([field, ranges]) => ({
    field,
    ranges: mergeRanges(ranges),
  }));
}

export interface RankedAgentHistoryCandidate<T extends AgentHistorySearchCandidate> {
  candidate: T;
  searchScore: number;
}

/**
 * Ranks the whole candidate set rather than a page of it. The daemon holds
 * every persisted agent in memory already, so search is complete by
 * construction and the client never has to warn that it only looked at what it
 * had loaded.
 *
 * A searched response is one page: the best `limit` matches, and a flag saying
 * more matched. There is no search cursor. Offsets into a ranking that is
 * recomputed per request duplicate and skip rows as history mutates underneath
 * them, and a keyset cursor would buy the ability to walk past result 200 of a
 * relevance order — which is browsing, not searching. Narrowing the query is
 * the answer, and the global top K is exactly recoverable from each host's own
 * top K, which is what lets several hosts merge without a federated pager.
 */
export function rankAgentHistoryCandidates<T extends AgentHistorySearchCandidate>(
  query: string,
  candidates: readonly T[],
  compareTies: (left: T, right: T) => number,
): RankedAgentHistoryCandidate<T>[] {
  const ranked: RankedAgentHistoryCandidate<T>[] = [];
  for (const candidate of candidates) {
    const searchScore = scoreAgentHistoryCandidate(query, candidate);
    if (searchScore === null) continue;
    ranked.push({ candidate, searchScore });
  }
  ranked.sort((left, right) => {
    if (left.searchScore !== right.searchScore) return left.searchScore - right.searchScore;
    return compareTies(left.candidate, right.candidate);
  });
  return ranked;
}

/** Pushes transcript-only hits behind typical metadata scores (each < 10k). */
export const TRANSCRIPT_SCORE_OFFSET = 10_000;

export interface TranscriptHistoryHit {
  agentId: string;
  rank: number;
  snippet: string;
}

export interface RankedAgentHistoryCandidateWithSnippet<
  T extends AgentHistorySearchCandidate,
> extends RankedAgentHistoryCandidate<T> {
  searchSnippet?: string;
}

/**
 * Union of the name ranker and FTS hits. Metadata score wins when both match;
 * the snippet still rides along so the row can show why the body also hit.
 * Transcript-only rows sort after names, then by bm25 (more negative is better).
 * Hits whose agent is not in `candidates` are ignored — History already chose
 * the set, including archived sessions.
 */
export function rankAgentHistoryWithTranscripts<T extends AgentHistorySearchCandidate>(
  query: string,
  candidates: readonly T[],
  transcriptHits: readonly TranscriptHistoryHit[],
  compareTies: (left: T, right: T) => number,
): RankedAgentHistoryCandidateWithSnippet<T>[] {
  const metadataRanked = rankAgentHistoryCandidates(query, candidates, compareTies);
  const candidateById = new Map(candidates.map((candidate) => [candidate.agent.id, candidate]));
  const snippetById = new Map<string, TranscriptHistoryHit>();
  for (const hit of transcriptHits) {
    if (!candidateById.has(hit.agentId) || snippetById.has(hit.agentId)) continue;
    snippetById.set(hit.agentId, hit);
  }

  const ranked: RankedAgentHistoryCandidateWithSnippet<T>[] = [];
  const seen = new Set<string>();
  for (const row of metadataRanked) {
    const id = row.candidate.agent.id;
    seen.add(id);
    const hit = snippetById.get(id);
    ranked.push({
      candidate: row.candidate,
      searchScore: row.searchScore,
      ...(hit?.snippet ? { searchSnippet: hit.snippet } : {}),
    });
  }

  const transcriptOnly: RankedAgentHistoryCandidateWithSnippet<T>[] = [];
  for (const hit of snippetById.values()) {
    if (seen.has(hit.agentId)) continue;
    const candidate = candidateById.get(hit.agentId);
    if (!candidate) continue;
    transcriptOnly.push({
      candidate,
      searchScore: TRANSCRIPT_SCORE_OFFSET + hit.rank,
      ...(hit.snippet ? { searchSnippet: hit.snippet } : {}),
    });
  }
  transcriptOnly.sort((left, right) => {
    if (left.searchScore !== right.searchScore) return left.searchScore - right.searchScore;
    return compareTies(left.candidate, right.candidate);
  });

  return [...ranked, ...transcriptOnly];
}
