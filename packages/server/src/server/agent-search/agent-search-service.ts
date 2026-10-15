import {
  agentSearchWords,
  matchesAgentSearchWords,
  type AgentSearchMatch,
} from "@getpaseo/protocol/agent-search";
import { isCommanderOrMachineryLabels } from "@getpaseo/protocol/mission-control/system-owned";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { MissionControlRunRecord } from "../mission-control/run-records.js";
import type { TranscriptHit } from "../search/service.js";

const MAX_MATCHES = 60;

export interface AgentSearchServiceDependencies {
  listAgents: () => Promise<StoredAgentRecord[]>;
  /** Retained Mission Control run records, newest first. */
  getRunRecords: () => readonly MissionControlRunRecord[];
  /** The launch prompt of a live agent that has no run record yet. */
  readLiveBrief: (agentId: string) => Promise<string | null>;
  /** FTS5 hits over indexed transcripts, best first; empty when the index is unavailable. */
  searchTranscripts: (query: string) => readonly TranscriptHit[];
}

export interface AgentSearchInput {
  query: string;
  includeArchived?: boolean;
}

export interface AgentSearchResult {
  matches: AgentSearchMatch[];
  /** COMPAT(agentSearchJev): always false; old clients read it as "word matches only". */
  semantic: false;
  candidateCount: number;
  latencyMs: number;
}

/** Lower sorts first: identity beats other metadata, which beats transcript-only hits. */
const MatchTier = { Identity: 0, Metadata: 1, Transcript: 2 } as const;

interface RankedMatch {
  record: StoredAgentRecord;
  tier: (typeof MatchTier)[keyof typeof MatchTier];
  /** bm25 for transcript-only hits (more negative is better); 0 otherwise. */
  rank: number;
}

/**
 * Plain full-text agent search for the sidebar: every query word as a
 * substring of the agent's name, title, id, reported description, launch
 * prompt, or last report headline, plus FTS5 hits over its transcript.
 * Closed agents are candidates; archived agents only when asked.
 */
export class AgentSearchService {
  private readonly deps: AgentSearchServiceDependencies;
  // A launch prompt never changes once written.
  private readonly liveBriefs = new Map<string, string>();

  constructor(deps: AgentSearchServiceDependencies) {
    this.deps = deps;
  }

  async search(input: AgentSearchInput): Promise<AgentSearchResult> {
    const startedAt = performance.now();
    const words = agentSearchWords(input.query);
    const records = await this.listCandidates(input);
    if (words.length === 0) {
      // A blank query is the client opening its search bar: read live launch
      // prompts now so the first real query skips them.
      void Promise.all(records.map((record) => this.liveBrief(record))).catch(() => undefined);
      return { matches: [], semantic: false, candidateCount: 0, latencyMs: 0 };
    }

    const briefs = new Map<string, string>();
    const lastReports = new Map<string, string>();
    // Newest run first: the last record seen per agent is its first run,
    // whose brief is the launch prompt; the first seen holds the latest report.
    for (const run of this.deps.getRunRecords()) {
      if (run.brief) briefs.set(run.agentId, run.brief);
      const headline = run.reports.at(-1)?.headline;
      if (headline && !lastReports.has(run.agentId)) lastReports.set(run.agentId, headline);
    }

    const transcriptRank = new Map<string, number>();
    for (const hit of this.deps.searchTranscripts(input.query.trim())) {
      if (!transcriptRank.has(hit.agentId)) transcriptRank.set(hit.agentId, hit.rank);
    }

    const ranked: RankedMatch[] = [];
    await Promise.all(
      records.map(async (record) => {
        if (matchesAgentSearchWords(words, [record.name, record.title, record.id])) {
          ranked.push({ record, tier: MatchTier.Identity, rank: 0 });
          return;
        }
        const brief = briefs.get(record.id) ?? (await this.liveBrief(record));
        const metadata = [record.shortDescription, brief, lastReports.get(record.id)];
        if (matchesAgentSearchWords(words, [record.name, record.title, record.id, ...metadata])) {
          ranked.push({ record, tier: MatchTier.Metadata, rank: 0 });
          return;
        }
        const rank = transcriptRank.get(record.id);
        if (rank !== undefined) ranked.push({ record, tier: MatchTier.Transcript, rank });
      }),
    );

    ranked.sort(
      (left, right) =>
        left.tier - right.tier ||
        left.rank - right.rank ||
        activityOf(right.record).localeCompare(activityOf(left.record)),
    );
    return {
      matches: ranked.slice(0, MAX_MATCHES).map(({ record, tier }) => ({
        agentId: record.id,
        title: record.title ?? null,
        name: record.name ?? null,
        workspaceId: record.workspaceId ?? null,
        cwd: record.cwd,
        archivedAt: record.archivedAt ?? null,
        lastActivityAt: activityOf(record),
        score: null,
        lexical: tier !== MatchTier.Transcript,
      })),
      semantic: false,
      candidateCount: records.length,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }

  private async listCandidates(input: AgentSearchInput): Promise<StoredAgentRecord[]> {
    // Commander and machinery never show in the sidebar, so they are never candidates.
    return (await this.deps.listAgents()).filter(
      (record) =>
        !record.internal &&
        !isCommanderOrMachineryLabels(record.labels) &&
        (input.includeArchived || !record.archivedAt),
    );
  }

  private async liveBrief(record: StoredAgentRecord): Promise<string | null> {
    if (record.archivedAt) return null;
    const cached = this.liveBriefs.get(record.id);
    if (cached) return cached;
    const brief = await this.deps.readLiveBrief(record.id).catch(() => null);
    if (brief) this.liveBriefs.set(record.id, brief);
    return brief;
  }
}

function activityOf(record: StoredAgentRecord): string {
  return record.lastActivityAt ?? record.updatedAt;
}
