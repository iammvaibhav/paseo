import type { Logger } from "pino";
import { z } from "zod";
import { curateAgentActivity } from "../agent/activity-curator.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import {
  normalizeHeadline,
  type MissionControlAppendInput,
  type MissionControlStore,
} from "./store.js";

const GATEWAY_TIMEOUT_MS = 120_000;
const GATEWAY_MAX_TOKENS = 900;
const GATEWAY_RETRIES = 1;
const DELTA_CHAR_CAP = 6000;
const HEADLINE_MAX_CHARS = 120;
const DETERMINISTIC_DEDUPE_WINDOW_MS = 10_000;

const SummarizerResponseSchema = z.object({
  worth_posting: z.boolean(),
  kind: z.enum(["finding", "fix", "milestone", "blocked", "diverged", "progress"]),
  headline: z.string(),
  detail: z.string().optional(),
});

export type SummarizerResponse = z.infer<typeof SummarizerResponseSchema>;

export interface MissionControlSummarizerConfig {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  minNewItems: number;
  debounceSeconds: number;
}

export interface MissionControlSummarizerOptions {
  logger: Logger;
  store: MissionControlStore;
  getTimeline: (agentId: string) => readonly AgentTimelineRow[];
  publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  getConfig: () => MissionControlSummarizerConfig;
}

const SYSTEM_PROMPT = `You summarize agent work for a fleet mission-control feed. The user message provides the agent's intent (brief) and its recent activity (delta).

Return ONLY JSON with this exact shape:
{"worth_posting": true|false, "kind": "finding"|"fix"|"milestone"|"blocked"|"diverged"|"progress", "headline": "...", "detail": "..."}

Rules:
- worth_posting false when the activity is routine or already covered. Silence is the default.
- kind: milestone for a completed chunk of work or a fix; finding for a notable discovery; blocked when the agent is stuck waiting; diverged when the work drifted from the brief; progress for mundane updates.
- headline: plain language, at most 120 characters, no markdown.
- detail: optional, one or two sentences.
- Never include secrets, credentials, or raw file contents.`;

export class MissionControlSummarizer {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly getTimeline: (agentId: string) => readonly AgentTimelineRow[];
  private readonly publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  private readonly getConfig: () => MissionControlSummarizerConfig;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingRows = new Map<string, number>();
  private disabledLogged = false;

  constructor(options: MissionControlSummarizerOptions) {
    this.logger = options.logger.child({ module: "mission-control", component: "summarizer" });
    this.store = options.store;
    this.getTimeline = options.getTimeline;
    this.publish = options.publish;
    this.getConfig = options.getConfig;
  }

  start(): void {
    if (this.getConfig().baseUrl === null && !this.disabledLogged) {
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
    if (!config.enabled || config.baseUrl === null) {
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
    const userMessages = rows
      .filter(
        (row): row is AgentTimelineRow & { item: { type: "user_message"; text: string } } =>
          row.item.type === "user_message",
      )
      .map((row) => row.item.text);
    const brief = userMessages.join("\n");
    const delta = curateAgentActivity(newRows.map((row) => row.item)).slice(0, DELTA_CHAR_CAP);
    if (brief.length === 0 && delta.length === 0) {
      this.advanceCursor(agentId, rows, observation.lastTimelineSeq);
      return;
    }
    const response = await this.callGateway(brief, delta, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
    if (!response) {
      this.pendingRows.set(agentId, pending);
      return;
    }
    this.advanceCursor(agentId, rows, observation.lastTimelineSeq);
    if (!response.worth_posting || response.kind === "progress") {
      return;
    }
    const kind = mapSummarizerKind(response.kind);
    if (!kind) {
      return;
    }
    const headline = response.headline.trim().slice(0, HEADLINE_MAX_CHARS);
    if (headline.length === 0) {
      return;
    }
    if (this.store.normalizedHeadlines(agentId).has(normalizeHeadline(headline))) {
      this.logger.debug({ agentId, headline }, "Dropping duplicate summarizer headline");
      return;
    }
    const lastSystem = this.store.lastSystemEvent(agentId, kind);
    if (
      lastSystem &&
      Date.now() - new Date(lastSystem.ts).getTime() < DETERMINISTIC_DEDUPE_WINDOW_MS
    ) {
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
      severity: kind === "blocked" || kind === "diverged" ? "attention" : "info",
      headline,
      ...(response.detail ? { detail: response.detail } : {}),
    });
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
        const parsed = SummarizerResponseSchema.safeParse(JSON.parse(content));
        if (!parsed.success) {
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
