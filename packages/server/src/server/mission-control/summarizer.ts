import type { Logger } from "pino";
import { z } from "zod";
import { curateAgentActivity } from "../agent/activity-curator.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { execCommand } from "../../utils/spawn.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import {
  normalizeHeadline,
  type MissionControlAppendInput,
  type MissionControlObservation,
  type MissionControlStore,
} from "./store.js";

const GATEWAY_TIMEOUT_MS = 120_000;
const GATEWAY_MAX_TOKENS = 900;
const GATEWAY_RETRIES = 1;
const DELTA_CHAR_CAP = 6000;
const HEADLINE_MAX_CHARS = 120;
const DETERMINISTIC_DEDUPE_WINDOW_MS = 10_000;
const OMP_BACKEND_TIMEOUT_MS = 120_000;
const OMP_BACKEND_MAX_BUFFER = 1024 * 1024;

const SummarizerResponseSchema = z.object({
  worth_posting: z.boolean(),
  kind: z.enum(["finding", "fix", "milestone", "blocked", "diverged", "progress"]),
  headline: z.string(),
  detail: z.string().optional(),
  // Identity refresh: set retitle=true (with title) when the milestone marks a
  // significant change of task direction, so the stored title is re-derived.
  retitle: z.boolean().optional(),
  title: z.string().optional(),
});

export type SummarizerResponse = z.infer<typeof SummarizerResponseSchema>;

function collectUserBrief(rows: readonly AgentTimelineRow[]): string {
  return rows
    .filter(
      (row): row is AgentTimelineRow & { item: { type: "user_message"; text: string } } =>
        row.item.type === "user_message",
    )
    .map((row) => row.item.text)
    .join("\n");
}

function hasDuplicateHeadline(
  store: MissionControlStore,
  agentId: string,
  headline: string,
): boolean {
  return store.normalizedHeadlines(agentId).has(normalizeHeadline(headline));
}

/** True when a deterministic system event for this kind landed within the dedupe window. */
function isShadowedByFreshSystemEvent(
  store: MissionControlStore,
  agentId: string,
  kind: MissionControlEvent["kind"],
): boolean {
  const lastSystem = store.lastSystemEvent(agentId, kind);
  return (
    lastSystem !== null &&
    Date.now() - new Date(lastSystem.ts).getTime() < DETERMINISTIC_DEDUPE_WINDOW_MS
  );
}

/** Severity for judgment kinds (summarizer + self-reported): blocked/diverged demand attention. */
export function summarizerEventSeverity(kind: MissionControlEvent["kind"]): "attention" | "info" {
  return kind === "blocked" || kind === "diverged" ? "attention" : "info";
}

export interface MissionControlSummarizerConfig {
  enabled: boolean;
  backend: "gateway" | "omp";
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  minNewItems: number;
  debounceSeconds: number;
}

export interface MissionControlIdentityUpdate {
  agentId: string;
  description?: string;
  title?: string;
}

export type MissionControlIdentityUpdateHandler = (params: MissionControlIdentityUpdate) => void;

export interface MissionControlSummarizerOptions {
  logger: Logger;
  store: MissionControlStore;
  getTimeline: (agentId: string) => readonly AgentTimelineRow[];
  publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  getConfig: () => MissionControlSummarizerConfig;
  /**
   * Identity refresh: fired when a posted milestone/finding should update the
   * agent's living description (and optionally its title). Wired to
   * `agentManager.updateAgentMetadata` by the service.
   */
  onIdentityUpdate?: MissionControlIdentityUpdateHandler;
}

const SYSTEM_PROMPT = `You summarize agent work for a fleet mission-control feed. The user message provides the agent's intent (brief) and its recent activity (delta).

Return ONLY JSON with this exact shape:
{"worth_posting": true|false, "kind": "finding"|"fix"|"milestone"|"blocked"|"diverged"|"progress", "headline": "...", "detail": "...", "retitle": false, "title": "..."}

Rules:
- worth_posting false when the activity is routine or already covered. Silence is the default.
- kind: milestone for a completed chunk of work or a fix; finding for a notable discovery; blocked when the agent is stuck waiting; diverged when the work drifted from the brief; progress for mundane updates.
- headline: plain language, at most 120 characters, no markdown.
- detail: optional, one or two sentences.
- retitle: true ONLY when the work's direction changed significantly from the original task (e.g. the brief's goal was replaced). When true, title is a short task label (max 60 chars) matching the new direction. Otherwise leave retitle false and title empty.
- Never include secrets, credentials, or raw file contents.`;

export class MissionControlSummarizer {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly getTimeline: (agentId: string) => readonly AgentTimelineRow[];
  private readonly publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  private readonly getConfig: () => MissionControlSummarizerConfig;
  private readonly onIdentityUpdate: MissionControlIdentityUpdateHandler;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingRows = new Map<string, number>();
  private disabledLogged = false;

  constructor(options: MissionControlSummarizerOptions) {
    this.logger = options.logger.child({ module: "mission-control", component: "summarizer" });
    this.store = options.store;
    this.getTimeline = options.getTimeline;
    this.publish = options.publish;
    this.getConfig = options.getConfig;
    this.onIdentityUpdate = options.onIdentityUpdate ?? (() => {});
  }

  start(): void {
    const config = this.getConfig();
    if (config.backend === "gateway" && config.baseUrl === null && !this.disabledLogged) {
      this.disabledLogged = true;
      this.logger.warn(
        "Mission control summarizer disabled: no gateway baseUrl in config or LLM_GATEWAY_URL",
      );
    }
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  notifyTimelineRows(agentId: string, rows: readonly AgentTimelineRow[]): void {
    const observation = this.store.getObservation(agentId);
    const newRowCount = rows.filter((row) => row.seq > observation.lastTimelineSeq).length;
    if (newRowCount === 0) {
      return;
    }
    const config = this.getConfig();
    const pending = (this.pendingRows.get(agentId) ?? 0) + newRowCount;
    this.pendingRows.set(agentId, pending);
    if (pending >= config.minNewItems) {
      this.schedulePass(agentId, config.debounceSeconds, false);
    }
  }

  notifyFinished(agentId: string): void {
    this.schedulePass(agentId, 0, true);
  }

  private schedulePass(agentId: string, debounceSeconds: number, force: boolean): void {
    const existing = this.debounceTimers.get(agentId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(agentId);
      void this.runPass(agentId, force);
    }, debounceSeconds * 1000);
    this.debounceTimers.set(agentId, timer);
  }

  private async runPass(agentId: string, force: boolean): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }
    const observation = this.store.getObservation(agentId);
    const rows = this.getTimeline(agentId);
    const newRows = rows.filter((row) => row.seq > observation.lastTimelineSeq);
    const pending = this.pendingRows.get(agentId) ?? newRows.length;
    this.pendingRows.delete(agentId);
    if (!force && pending < config.minNewItems) {
      return;
    }
    if (!force && this.selfReportedSinceLastPass(observation)) {
      // Demotion: the agent self-reported after the last summarizer pass, so
      // its recent milestones are already on the feed. Skip the judgment pass
      // but consume the rows and re-arm the pass cursor, so the summarizer
      // still runs once the agent goes silent (self-reporting is primary; the
      // summarizer is the backstop for silent agents).
      this.advanceCursor(agentId, rows, observation.lastTimelineSeq);
      return;
    }
    const brief = collectUserBrief(rows);
    const delta = curateAgentActivity(newRows.map((row) => row.item)).slice(0, DELTA_CHAR_CAP);
    if (brief.length === 0 && delta.length === 0) {
      this.advanceCursor(agentId, rows, observation.lastTimelineSeq);
      return;
    }
    const response = await this.runSummarizerPass(brief, delta, config);
    if (!response) {
      this.pendingRows.set(agentId, pending);
      return;
    }
    this.advanceCursor(agentId, rows, observation.lastTimelineSeq);
    if (!response.worth_posting || response.kind === "progress") {
      return;
    }
    this.publishResponse(agentId, response);
  }

  /** Post a single summarizer card for one pass, enforcing dedup and identity refresh. */
  private publishResponse(agentId: string, response: SummarizerResponse): void {
    const kind = mapSummarizerKind(response.kind);
    if (!kind) {
      return;
    }
    const headline = response.headline.trim().slice(0, HEADLINE_MAX_CHARS);
    if (headline.length === 0) {
      return;
    }
    if (hasDuplicateHeadline(this.store, agentId, headline)) {
      this.logger.debug({ agentId, headline }, "Dropping duplicate summarizer headline");
      return;
    }
    if (isShadowedByFreshSystemEvent(this.store, agentId, kind)) {
      this.logger.debug(
        { agentId, kind },
        "Dropping summarizer card shadowing a fresh deterministic event",
      );
      return;
    }
    // One summarizer event per agent per pass: a single parsed response yields at most one event.
    this.publish({
      agentId,
      kind,
      source: "summarizer",
      severity: summarizerEventSeverity(kind),
      headline,
      ...(response.detail ? { detail: response.detail } : {}),
    });
    // Identity refresh: a posted milestone/finding headline becomes the
    // agent's living description; re-title only when the summarizer flagged a
    // significant change of direction.
    if (kind === "milestone" || kind === "finding") {
      this.onIdentityUpdate({
        agentId,
        description: headline,
        ...(response.retitle === true && response.title ? { title: response.title.trim() } : {}),
      });
    }
  }

  private advanceCursor(
    agentId: string,
    rows: readonly AgentTimelineRow[],
    lastTimelineSeq: number,
  ): void {
    const maxSeq = rows.reduce((max, row) => Math.max(max, row.seq), lastTimelineSeq);
    this.store.updateObservation(agentId, {
      lastTimelineSeq: maxSeq,
      lastSummarizerTs: new Date().toISOString(),
    });
  }

  /** True when the agent self-reported after the last summarizer pass cursor. */
  private selfReportedSinceLastPass(observation: MissionControlObservation): boolean {
    if (observation.lastSelfReportTs === null) {
      return false;
    }
    return (
      observation.lastSummarizerTs === null ||
      observation.lastSelfReportTs > observation.lastSummarizerTs
    );
  }

  private async runSummarizerPass(
    brief: string,
    delta: string,
    config: MissionControlSummarizerConfig,
  ): Promise<SummarizerResponse | null> {
    if (config.backend === "omp") {
      return this.callOmp(brief, delta);
    }
    if (config.baseUrl === null) {
      return null;
    }
    return this.callGateway(brief, delta, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  /**
   * Judgment via a local omp invocation instead of the LLM gateway: no fleet
   * secrets leave the host (blrofc3 compliance). `-p` prints the reply to
   * stdout; the summarizer prompt demands one JSON object.
   */
  private async callOmp(brief: string, delta: string): Promise<SummarizerResponse | null> {
    const prompt = [SYSTEM_PROMPT, buildGatewayPrompt(brief, delta)].join("\n\n");
    for (let attempt = 0; attempt <= GATEWAY_RETRIES; attempt++) {
      try {
        const { stdout } = await execCommand(
          "omp",
          [
            "-p",
            "--no-tools",
            "--no-session",
            "--no-skills",
            "--no-rules",
            "--model",
            "@smol",
            prompt,
          ],
          {
            timeout: OMP_BACKEND_TIMEOUT_MS,
            maxBuffer: OMP_BACKEND_MAX_BUFFER,
            // `omp -p` reads a piped stdin until EOF; leaving stdin open makes
            // it block forever and burn the whole timeout.
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const parsed = SummarizerResponseSchema.safeParse(extractFencedJsonObject(stdout));
        if (!parsed.success) {
          throw new Error("omp backend returned an unexpected JSON shape");
        }
        return parsed.data;
      } catch (error) {
        this.logger.warn(
          { err: error, attempt },
          "Mission control summarizer omp backend call failed",
        );
      }
    }
    return null;
  }

  private async callGateway(
    brief: string,
    delta: string,
    gateway: { baseUrl: string; apiKey: string | null; model: string },
  ): Promise<SummarizerResponse | null> {
    const body = JSON.stringify({
      model: gateway.model,
      response_format: { type: "json_object" },
      max_tokens: GATEWAY_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildGatewayPrompt(brief, delta) },
      ],
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (gateway.apiKey) {
      headers.authorization = `Bearer ${gateway.apiKey}`;
    }
    for (let attempt = 0; attempt <= GATEWAY_RETRIES; attempt++) {
      try {
        const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`Gateway responded with ${response.status}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("Gateway returned empty content");
        }
        const parsed = SummarizerResponseSchema.safeParse(extractFencedJsonObject(content));
        if (!parsed.success) {
          // Shape failure: log the truncated raw body (it may contain the
          // reason, e.g. an error object) and do NOT advance the pass cursor —
          // the caller restores pending rows so the pass retriggers.
          this.logger.warn(
            { body: content.slice(0, 400) },
            "Gateway returned an unexpected JSON shape",
          );
          throw new Error("Gateway returned an unexpected JSON shape");
        }
        return parsed.data;
      } catch (error) {
        this.logger.warn({ err: error, attempt }, "Mission control summarizer gateway call failed");
      }
    }
    return null;
  }
}

function buildGatewayPrompt(brief: string, delta: string): string {
  return ["Brief (the agent's intent):", brief || "(none)", "", "Recent activity:", delta].join(
    "\n",
  );
}

function mapSummarizerKind(kind: SummarizerResponse["kind"]): MissionControlEvent["kind"] | null {
  switch (kind) {
    case "fix":
    case "milestone":
      return "milestone";
    case "finding":
      return "finding";
    case "blocked":
      return "blocked";
    case "diverged":
      return "diverged";
    case "progress":
      return null;
  }
}

/**
 * Pull the first JSON object out of stdout: the model is asked for JSON only,
 * but `-p` output may carry prose, markdown fences, or trailing chatter.
 * Shared by the summarizer and autopilot evaluator backends.
 */
export function extractFencedJsonObject(stdout: string): unknown {
  const text = stdout.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
