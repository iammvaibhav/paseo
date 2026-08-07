import type { Logger } from "pino";
import { z } from "zod";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { execCommand } from "../../utils/spawn.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";
import { hasMissionControlLabels } from "./naming.js";
import { extractFencedJsonObject } from "./summarizer.js";
import type { MissionControlAppendInput, MissionControlStore } from "./store.js";

// The gateway "smart" tier can hang for minutes; keep each attempt bounded so
// a stuck tier degrades to the cheap "extract" retry instead of stalling the
// autopilot loop.
const GATEWAY_TIMEOUT_MS = 60_000;
const GATEWAY_MAX_TOKENS = 700;
const GATEWAY_RETRIES = 1;
const DELTA_CHAR_CAP = 6000;
const HEADLINE_MAX_CHARS = 120;
const REASON_MAX_CHARS = 200;
const NUDGE_MAX_CHARS = 1000;
const OMP_BACKEND_TIMEOUT_MS = 120_000;
const OMP_BACKEND_MAX_BUFFER = 1024 * 1024;
const DEFAULT_GATEWAY_EVALUATOR_MODEL = "smart";
const DEFAULT_OMP_EVALUATOR_MODEL = "@slow";

const AutopilotVerdictSchema = z.object({
  verdict: z.enum(["accept", "nudge", "escalate"]),
  reason: z.string(),
  nudge_instructions: z.string().optional(),
});

export type AutopilotVerdict = z.infer<typeof AutopilotVerdictSchema>;

export interface MissionControlAutopilotConfig {
  mode: "off" | "observe" | "act";
  /** Evaluator model; absent resolves per backend (gateway "smart", omp "@slow"). */
  model: string | null;
  scope: "commander-spawned" | "all";
  maxNudgesPerAgent: number;
  /** Judgment backend + gateway connection settings are shared with the summarizer. */
  backend: "gateway" | "omp";
  baseUrl: string | null;
  apiKey: string | null;
}

export interface MissionControlAutopilotOptions {
  logger: Logger;
  store: MissionControlStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  getConfig: () => MissionControlAutopilotConfig;
  /**
   * IO boundary for sending a nudge prompt. Defaults to sendPromptToAgent
   * (replaceRunning-safe on an idle worker, never unarchives); tests inject an
   * in-memory fake.
   */
  dispatchNudge?: (agentId: string, instructions: string) => Promise<void>;
}

interface EvaluatorInput {
  brief: string;
  delta: string;
  milestones: string;
}

const SYSTEM_PROMPT = `You verify a finished fleet worker's work and decide the single follow-up action. The user message provides the worker's brief (its user messages), its activity since the last verdict, and its self-reported milestones. You are a verifier (what did the agent do) and a commander (accept / nudge / escalate) — nothing else. You never investigate or run anything.

Return ONLY JSON with this exact shape:
{"verdict": "accept"|"nudge"|"escalate", "reason": "...", "nudge_instructions": "..."}

Rules:
- accept: the work matches the brief (or a reasonable interpretation). The worker is done.
- nudge: the work is close but incomplete; nudge_instructions gives precise, actionable follow-up the worker can execute in one more turn. Never expand scope beyond the original brief.
- escalate: the brief is unmet, the work is blocked on the user, or the worker diverged beyond one-turn repair.
- reason: plain language, at most 200 characters.
- nudge_instructions: ONLY for verdict "nudge"; at most 1000 characters; verbatim actionable instructions for the worker; never request permissions or credentials.
- Never include secrets, credentials, or raw file contents.`;

/**
 * Evaluate-and-act on worker completion: a cheap verifier/commander pass over
 * the worker's brief, activity delta, and self-reported milestones. `observe`
 * posts verdict cards only; `act` also sends bounded nudges; `off` is inert.
 */
export class MissionControlAutopilot {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly publish: (input: Omit<MissionControlAppendInput, "agentTitle">) => void;
  private readonly getConfig: () => MissionControlAutopilotConfig;
  private readonly dispatchNudge: (agentId: string, instructions: string) => Promise<void>;

  private readonly lastFinishedAtByAgent = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: MissionControlAutopilotOptions) {
    this.logger = options.logger.child({ module: "mission-control", component: "autopilot" });
    this.store = options.store;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.publish = options.publish;
    this.getConfig = options.getConfig;
    this.dispatchNudge =
      options.dispatchNudge ??
      ((agentId, instructions) =>
        sendPromptToAgent({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId,
          prompt: instructions,
          unarchive: false,
          logger: this.logger,
        }).then(() => undefined));
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    if (this.getConfig().mode === "off") {
      this.logger.info("Mission control autopilot disabled (mode off)");
    }
    // Always subscribed so a Settings mode flip to observe/act takes effect
    // without a daemon restart; every path below short-circuits while off.
    this.unsubscribe = this.agentManager.subscribe((event) => this.handleManagerEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleManagerEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_state") {
      this.handleAgentState(event.agent);
    }
  }

  /**
   * Finished-transition edge detection: the attention timestamp uniquely
   * identifies one finish, so a replayed agent_state for the same finish never
   * re-evaluates, while a worker that ran again (e.g. after a nudge) produces
   * a fresh timestamp on its next finish. Does not depend on observing the
   * intermediate running state.
   */
  private handleAgentState(agent: ManagedAgent): void {
    if (this.getConfig().mode === "off") {
      return;
    }
    if (agent.internal || hasMissionControlLabels(agent.labels)) {
      return;
    }
    if (!agent.attention.requiresAttention || agent.attention.attentionReason !== "finished") {
      return;
    }
    const finishedAt = agent.attention.attentionTimestamp.toISOString();
    if (this.lastFinishedAtByAgent.get(agent.id) === finishedAt) {
      return;
    }
    this.lastFinishedAtByAgent.set(agent.id, finishedAt);
    void this.evaluateFinish(agent.id, finishedAt);
  }

  private async evaluateFinish(agentId: string, finishedAt: string): Promise<void> {
    const config = this.getConfig();
    if (config.mode === "off") {
      return;
    }
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || !(await this.isInScope(agent))) {
      return;
    }
    const observation = this.store.getObservation(agentId);
    // Ledger guard: the same finished transition never evaluates twice, even
    // if agent_state replays it after a clear.
    if (observation.autopilot?.lastEvaluatedFinishedAt === finishedAt) {
      return;
    }
    const rows = await this.readStoredTimeline(agentId);
    if (rows.length === 0) {
      this.logger.debug({ agentId }, "Autopilot skipping evaluation: no timeline rows");
      return;
    }
    const sinceSeq = observation.autopilot?.lastEvaluatedSeq ?? -1;
    const maxSeq = rows.reduce((max, row) => Math.max(max, row.seq), sinceSeq);
    this.store.updateObservation(agentId, {
      autopilot: { lastEvaluatedFinishedAt: finishedAt, lastEvaluatedSeq: maxSeq },
    });

    const brief = collectUserBrief(rows);
    const delta = curateAgentActivity(
      rows.filter((row) => row.seq > sinceSeq).map((row) => row.item),
    ).slice(0, DELTA_CHAR_CAP);
    const milestones = this.selfReportedSummary(agentId);
    if (brief.length === 0 && delta.length === 0 && milestones.length === 0) {
      this.logger.debug({ agentId }, "Autopilot skipping evaluation: empty input");
      return;
    }

    const verdict = await this.runEvaluatorPass({ brief, delta, milestones }, config);
    if (!verdict) {
      this.logger.warn({ agentId }, "Autopilot evaluator pass failed; no verdict card posted");
      return;
    }
    await this.applyVerdict(agentId, verdict, config);
  }

  /** Scope + exclusion filter. Never evaluates mission-control/internal agents. */
  private async isInScope(agent: ManagedAgent): Promise<boolean> {
    const scope = this.getConfig().scope;
    if (scope === "all") {
      return true;
    }
    const parentAgentId = getParentAgentIdFromLabels(agent.labels);
    return parentAgentId !== null && (await this.isCommander(parentAgentId));
  }

  private async isCommander(agentId: string): Promise<boolean> {
    const live = this.agentManager.getAgent(agentId);
    const labels = live?.labels ?? (await this.agentStorage.get(agentId))?.labels;
    return labels?.[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE;
  }

  /** Durable rows when the agent is still loaded (the just-finished case). */
  private async readStoredTimeline(agentId: string): Promise<AgentTimelineRow[]> {
    try {
      return await this.agentManager.getTimelineRows(agentId);
    } catch (error) {
      this.logger.debug(
        { err: error, agentId },
        "Autopilot timeline read failed (agent closed before evaluation)",
      );
      return [];
    }
  }

  private selfReportedSummary(agentId: string): string {
    const events = this.store.fetchEvents({ includeSuperseded: true });
    const lines: string[] = [];
    for (const event of events) {
      if (event.agentId !== agentId || event.source !== "self") {
        continue;
      }
      const proof =
        event.proof && event.proof.length > 0
          ? ` [proof: ${event.proof
              .map((entry) => entry.url ?? entry.path ?? entry.label ?? entry.kind)
              .join(", ")}]`
          : "";
      lines.push(
        `- [${event.kind}] ${event.headline}${event.detail ? ` — ${event.detail}` : ""}${proof}`,
      );
    }
    return lines.length > 0 ? lines.join("\n") : "(none)";
  }

  private async runEvaluatorPass(
    input: EvaluatorInput,
    config: MissionControlAutopilotConfig,
  ): Promise<AutopilotVerdict | null> {
    const model =
      config.model ??
      (config.backend === "omp" ? DEFAULT_OMP_EVALUATOR_MODEL : DEFAULT_GATEWAY_EVALUATOR_MODEL);
    if (config.backend === "omp") {
      return this.callOmp(input, model);
    }
    if (config.baseUrl === null) {
      return null;
    }
    return this.callGateway(input, model, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
  }

  private async callOmp(input: EvaluatorInput, model: string): Promise<AutopilotVerdict | null> {
    const prompt = [SYSTEM_PROMPT, buildEvaluatorPrompt(input)].join("\n\n");
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
            model,
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
        const parsed = AutopilotVerdictSchema.safeParse(extractFencedJsonObject(stdout));
        if (!parsed.success) {
          throw new Error("Autopilot omp backend returned an unexpected JSON shape");
        }
        return parsed.data;
      } catch (error) {
        this.logger.warn(
          { err: error, attempt },
          "Mission control autopilot omp backend call failed",
        );
      }
    }
    return null;
  }

  private async callGateway(
    input: EvaluatorInput,
    model: string,
    gateway: { baseUrl: string; apiKey: string | null },
  ): Promise<AutopilotVerdict | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (gateway.apiKey) {
      headers.authorization = `Bearer ${gateway.apiKey}`;
    }
    for (let attempt = 0; attempt <= GATEWAY_RETRIES; attempt++) {
      // First attempt uses the configured (or backend-default) model; a
      // failure degrades to the cheap "extract" tier once, logged, so the
      // autopilot pass still lands a verdict when the smart tier hangs.
      const attemptModel = attempt > 0 ? "extract" : model;
      if (attempt > 0) {
        this.logger.warn(
          { fromModel: model, fallbackModel: attemptModel },
          "Autopilot gateway call failed; retrying once with the extract tier",
        );
      }
      const body = JSON.stringify({
        model: attemptModel,
        response_format: { type: "json_object" },
        max_tokens: GATEWAY_MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildEvaluatorPrompt(input) },
        ],
      });
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
        const parsed = AutopilotVerdictSchema.safeParse(extractFencedJsonObject(content));
        if (!parsed.success) {
          this.logger.warn(
            { body: content.slice(0, 400) },
            "Autopilot gateway returned an unexpected JSON shape",
          );
          throw new Error("Autopilot gateway returned an unexpected JSON shape");
        }
        return parsed.data;
      } catch (error) {
        this.logger.warn(
          { err: error, attempt, model: attemptModel },
          "Mission control autopilot gateway call failed",
        );
      }
    }
    return null;
  }

  private async applyVerdict(
    agentId: string,
    verdict: AutopilotVerdict,
    config: MissionControlAutopilotConfig,
  ): Promise<void> {
    const reason = verdict.reason.trim().slice(0, REASON_MAX_CHARS);
    if (verdict.verdict === "accept") {
      this.publish({
        agentId,
        kind: "milestone",
        source: "autopilot",
        severity: "info",
        headline: cardHeadline("Accepted", reason),
      });
      return;
    }
    if (verdict.verdict === "escalate") {
      this.publish({
        agentId,
        kind: "blocked",
        source: "autopilot",
        severity: "blocker",
        headline: cardHeadline("Escalated", reason),
      });
      return;
    }

    // nudge
    const observation = this.store.getObservation(agentId);
    const nudgeCount = observation.autopilot?.nudgeCount ?? 0;
    if (nudgeCount >= config.maxNudgesPerAgent) {
      this.publish({
        agentId,
        kind: "blocked",
        source: "autopilot",
        severity: "blocker",
        headline: cardHeadline("Escalated", reason),
        detail: `Nudge limit reached (${config.maxNudgesPerAgent}); escalated instead of nudging again.`,
      });
      return;
    }
    const instructions = (verdict.nudge_instructions ?? "").trim().slice(0, NUDGE_MAX_CHARS);
    if (config.mode === "act" && instructions.length > 0) {
      try {
        await this.dispatchNudge(agentId, instructions);
        this.store.updateObservation(agentId, { autopilot: { nudgeCount: nudgeCount + 1 } });
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "Autopilot nudge dispatch failed");
      }
    }
    this.publish({
      agentId,
      kind: "diverged",
      source: "autopilot",
      severity: "attention",
      headline: cardHeadline("Nudge", reason),
      ...(instructions ? { detail: instructions } : {}),
    });
  }
}

function collectUserBrief(rows: readonly AgentTimelineRow[]): string {
  return rows
    .filter(
      (row): row is AgentTimelineRow & { item: { type: "user_message"; text: string } } =>
        row.item.type === "user_message",
    )
    .map((row) => row.item.text)
    .join("\n");
}

function cardHeadline(label: "Accepted" | "Nudge" | "Escalated", reason: string): string {
  return reason ? `${label} — ${reason}`.slice(0, HEADLINE_MAX_CHARS) : label;
}

function buildEvaluatorPrompt(input: EvaluatorInput): string {
  return [
    "Brief (the worker's intent):",
    input.brief || "(none)",
    "",
    "Activity since the last verdict:",
    input.delta || "(none)",
    "",
    "Self-reported milestones:",
    input.milestones,
  ].join("\n");
}
