import type { Logger } from "pino";
import {
  agentSearchWords,
  matchesAgentSearchWords,
  type AgentSearchMatch,
} from "@getpaseo/protocol/agent-search";
import { isCommanderOrMachineryLabels } from "@getpaseo/protocol/mission-control/system-owned";
import { judgeChoices, type JudgeChoiceQuestion } from "../routing/llm-clients.js";
import { createVaultSecretResolver, type ResolveSecret } from "../secrets/vault-secret.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { MissionControlRunRecord } from "../mission-control/run-records.js";

// One jev question per agent. A card is ~450 bytes; ~400 KB in one request
// fails with max_tokens_exceeded, so larger sets split into parallel calls.
// Measured: 100 cards ≈ 0.45 s, 1,000 cards in 10 parallel calls ≈ 0.75 s.
const QUESTIONS_PER_CALL = 100;
const JEV_TIMEOUT_MS = 3_000;
const MATCH_THRESHOLD = 0.5;
const MAX_MATCHES = 60;
const CARD_FIELD_CHARS = 240;

export interface AgentSearchServiceDependencies {
  logger: Logger;
  listAgents: () => Promise<StoredAgentRecord[]>;
  /** Retained Mission Control run records, newest first. */
  getRunRecords: () => readonly MissionControlRunRecord[];
  /** The launch prompt of a live agent that has no run record yet. */
  readLiveBrief: (agentId: string) => Promise<string | null>;
  /** The TypeSafe key (or its `aside://` reference) from central config. */
  getTypesafeApiKeyRef: () => string | undefined;
  resolveSecret?: ResolveSecret;
  fetchImpl?: typeof fetch;
}

export interface AgentSearchInput {
  query: string;
  includeArchived?: boolean;
}

export interface AgentSearchResult {
  matches: AgentSearchMatch[];
  semantic: boolean;
  candidateCount: number;
  latencyMs: number;
}

interface Candidate {
  record: StoredAgentRecord;
  brief: string | null;
  lastReport: string | null;
  lexical: boolean;
}

/**
 * Shallow agent search: each agent becomes a short card (title, launch
 * prompt, reported description, last report headline) and jev judges every
 * card against the query independently, so several agents can match.
 */
export class AgentSearchService {
  private readonly deps: AgentSearchServiceDependencies;
  private readonly logger: Logger;
  private readonly resolveSecret: ResolveSecret;
  // A launch prompt never changes once written.
  private readonly liveBriefs = new Map<string, string>();

  constructor(deps: AgentSearchServiceDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ module: "agent-search" });
    this.resolveSecret = deps.resolveSecret ?? createVaultSecretResolver();
  }

  async search(input: AgentSearchInput, signal?: AbortSignal): Promise<AgentSearchResult> {
    const startedAt = performance.now();
    const words = agentSearchWords(input.query);
    if (words.length === 0) {
      // A blank query is the client opening its search bar: resolve the vault
      // key and read live launch prompts now so the first real query skips both.
      void Promise.all([
        this.resolveSecret(this.deps.getTypesafeApiKeyRef()),
        this.loadCandidates(input, words),
      ]).catch(() => undefined);
      return { matches: [], semantic: false, candidateCount: 0, latencyMs: 0 };
    }
    const candidates = await this.loadCandidates(input, words);
    const scores = await this.judge(input.query.trim(), candidates, signal);
    const matches: AgentSearchMatch[] = [];
    candidates.forEach((candidate, index) => {
      const score = scores?.[index] ?? null;
      if (!candidate.lexical && (score === null || score < MATCH_THRESHOLD)) return;
      const { record } = candidate;
      matches.push({
        agentId: record.id,
        title: record.title ?? null,
        workspaceId: record.workspaceId ?? null,
        cwd: record.cwd,
        archivedAt: record.archivedAt ?? null,
        lastActivityAt: record.lastActivityAt ?? record.updatedAt,
        score,
        lexical: candidate.lexical,
      });
    });
    // jev's probability ranks; a word match without jev sorts by recency.
    matches.sort(
      (left, right) =>
        (right.score ?? (right.lexical ? MATCH_THRESHOLD : 0)) -
          (left.score ?? (left.lexical ? MATCH_THRESHOLD : 0)) ||
        (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""),
    );
    return {
      matches: matches.slice(0, MAX_MATCHES),
      semantic: scores !== null,
      candidateCount: candidates.length,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }

  private async loadCandidates(
    input: AgentSearchInput,
    words: readonly string[],
  ): Promise<Candidate[]> {
    // Commander and machinery never show in the sidebar, so they are never candidates.
    const records = (await this.deps.listAgents()).filter(
      (record) =>
        !record.internal &&
        !isCommanderOrMachineryLabels(record.labels) &&
        (input.includeArchived || !record.archivedAt),
    );

    // Newest run first: the last record seen per agent is its first run,
    // whose brief is the launch prompt; the first seen holds the latest report.
    const briefs = new Map<string, string>();
    const lastReports = new Map<string, string>();
    for (const run of this.deps.getRunRecords()) {
      if (run.brief) briefs.set(run.agentId, run.brief);
      const headline = run.reports.at(-1)?.headline;
      if (headline && !lastReports.has(run.agentId)) lastReports.set(run.agentId, headline);
    }

    return Promise.all(
      records.map(async (record) => {
        const brief = briefs.get(record.id) ?? (await this.liveBrief(record));
        const lastReport = lastReports.get(record.id) ?? null;
        return {
          record,
          brief,
          lastReport,
          lexical: matchesAgentSearchWords(words, [
            record.title,
            record.name,
            record.shortDescription,
            brief,
          ]),
        };
      }),
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

  /** jev "yes" probability per candidate, or null when jev is unavailable. */
  private async judge(
    query: string,
    candidates: readonly Candidate[],
    signal: AbortSignal | undefined,
  ): Promise<number[] | null> {
    if (candidates.length === 0) return [];
    const apiKey = await this.resolveSecret(this.deps.getTypesafeApiKeyRef()).catch(
      () => undefined,
    );
    if (!apiKey) return null;

    const chunks: Candidate[][] = [];
    for (let start = 0; start < candidates.length; start += QUESTIONS_PER_CALL) {
      chunks.push(candidates.slice(start, start + QUESTIONS_PER_CALL));
    }
    const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
    try {
      const scored = await Promise.all(
        chunks.map(async (chunk) => {
          const questions: Record<string, JudgeChoiceQuestion> = {};
          chunk.forEach((candidate, index) => {
            questions[`a${index}`] = {
              type: "choice",
              // Measured against the looser "Is this the agent the user is searching
              // for?": vague cards ("hi", "<instructions>") stopped matching every query.
              instructions: `A user typed a search query to find one of their coding agents. Decide whether this agent's work is about what the query describes. Answer no when the card is too vague to tell or only shares generic words. ${describeCandidate(candidate)}`,
              criteria: {
                yes: "The agent's task or findings are clearly about the topic of the search query",
                no: "The agent worked on something else, or the card is too vague to connect it to the query",
              },
            };
          });
          const answers = await judgeChoices({
            apiKey,
            state: { search_query: query },
            questions,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            fetchImpl: this.deps.fetchImpl,
          });
          return chunk.map((_, index) => answers[`a${index}`]?.probabilities.yes ?? 0);
        }),
      );
      return scored.flat();
    } catch (error) {
      this.logger.warn({ err: error, candidates: candidates.length }, "agent search jev failed");
      return null;
    }
  }
}

function describeCandidate(candidate: Candidate): string {
  const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, CARD_FIELD_CHARS);
  const { record } = candidate;
  const parts = [`Agent title: ${clip(record.title ?? record.name ?? "Untitled")}`];
  if (candidate.brief) parts.push(`Launch prompt: ${clip(candidate.brief)}`);
  if (record.shortDescription) parts.push(`Reported status: ${clip(record.shortDescription)}`);
  if (candidate.lastReport) parts.push(`Last report: ${clip(candidate.lastReport)}`);
  return parts.join(" | ");
}
