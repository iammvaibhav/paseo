import type { Logger } from "pino";
import type {
  AgentLifecycleStatus,
  AgentManager,
  AgentManagerEvent,
  ManagedAgent,
} from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { hasMissionControlLabels } from "./naming.js";
import type { MissionControlDigestSink } from "./digest.js";
import {
  MissionControlStore,
  type MissionControlAppendInput,
  type MissionControlFetchOptions,
} from "./store.js";
import {
  MissionControlSummarizer,
  summarizerEventSeverity,
  type MissionControlIdentityUpdate,
  type MissionControlSummarizerConfig,
} from "./summarizer.js";
import { MissionControlAutopilot, type MissionControlAutopilotConfig } from "./autopilot.js";

const DEFAULT_RETENTION_DAYS = 30;
const STALL_SWEEP_INTERVAL_MS = 30_000;
const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESTART_GRACE_MS = 60_000;
const STALL_NO_IN_FLIGHT_TOOL_MS = 5 * 60_000;
const STALL_IN_FLIGHT_TOOL_MS = 20 * 60_000;
const TIMELINE_BUFFER_CAP = 2000;
const MISSION_CONTROL_LABEL_PREFIX = "paseo.mission-control";
const SELF_REPORT_RATE_LIMIT_MS = 60_000;

interface StallTracking {
  lastStreamAt: number;
  tailItem: AgentStreamEvent | null;
}

export interface MissionControlServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  serverId: string;
  hostName: string;
  broadcast: (message: SessionOutboundMessage) => void;
  digest?: MissionControlDigestSink;
}

export interface MissionControlServiceConfig {
  retentionDays: number;
  summarizer: MissionControlSummarizerConfig;
  autopilot: MissionControlAutopilotConfig;
}

export interface SelfReportMilestoneInput {
  kind: "finding" | "milestone" | "blocked" | "diverged";
  headline: string;
  detail?: string;
  proof?: MissionControlEvent["proof"];
}

export type SelfReportResult =
  | { ok: true; event: MissionControlEvent }
  | { ok: false; reason: "excluded" | "rate_limited"; message: string };

export class MissionControlService {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly summarizer: MissionControlSummarizer;
  private readonly autopilot: MissionControlAutopilot;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly serverId: string;
  private readonly hostName: string;
  private readonly broadcast: (message: SessionOutboundMessage) => void;
  private readonly digest: MissionControlDigestSink | null;

  private readonly timelineRows = new Map<string, AgentTimelineRow[]>();
  private readonly lifecycleByAgent = new Map<string, AgentLifecycleStatus>();
  private readonly attentionKeyByAgent = new Map<string, string>();
  private readonly blockedByAgent = new Set<string>();
  private readonly stalledByAgent = new Set<string>();
  private readonly stallTracking = new Map<string, StallTracking>();
  private readonly excludedAgentIds = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly bootedAtMs: number;

  constructor(options: MissionControlServiceOptions) {
    this.logger = options.logger.child({ module: "mission-control" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.daemonConfigStore = options.daemonConfigStore;
    this.serverId = options.serverId;
    this.hostName = options.hostName;
    this.broadcast = options.broadcast;
    this.digest = options.digest ?? null;
    this.bootedAtMs = Date.now();
    this.store = new MissionControlStore({ paseoHome: options.paseoHome, logger: this.logger });
    this.summarizer = new MissionControlSummarizer({
      logger: this.logger,
      store: this.store,
      getTimeline: (agentId) => this.timelineRows.get(agentId) ?? [],
      publish: (input) => {
        void this.emitEvent(input);
      },
      getConfig: () => this.readConfig().summarizer,
      onIdentityUpdate: (params) => {
        void this.applySummarizerIdentityUpdate(params);
      },
    });
    this.autopilot = new MissionControlAutopilot({
      logger: this.logger,
      store: this.store,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      publish: (input) => {
        void this.emitEvent(input);
      },
      getConfig: () => this.readConfig().autopilot,
    });
  }

  async start(): Promise<void> {
    await this.store.initialize();
    await this.store.prune(this.readConfig().retentionDays);
    this.summarizer.start();
    this.autopilot.start();
    this.unsubscribe = this.agentManager.subscribe((event) => this.handleManagerEvent(event));
    this.sweepTimer = setInterval(() => this.sweepStalled(), STALL_SWEEP_INTERVAL_MS);
    this.pruneTimer = setInterval(() => {
      void this.store.prune(this.readConfig().retentionDays).catch((error) => {
        this.logger.warn({ err: error }, "Failed to prune mission control events");
      });
    }, DAILY_PRUNE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.summarizer.stop();
    this.autopilot.stop();
  }

  fetchEvents(options?: MissionControlFetchOptions): MissionControlEvent[] {
    return this.store.fetchEvents(options);
  }

  ackEvents(eventIds: string[]): void {
    this.store.ackEvents(eventIds);
  }

  /**
   * Self-reported milestone from the report_milestone MCP tool. Excluded
   * agents (mission-control labels) get a polite error; a within-window report
   * is only accepted when it coalesces into the agent's existing unacked event
   * of the same kind. Posted events also refresh the agent's identity
   * description, same as summarizer milestone/finding cards.
   */
  async reportSelfMilestone(
    agentId: string,
    input: SelfReportMilestoneInput,
  ): Promise<SelfReportResult> {
    const agent = this.agentManager.getAgent(agentId);
    if (agent && hasMissionControlLabels(agent.labels)) {
      return {
        ok: false,
        reason: "excluded",
        message:
          "Mission Control agents do not self-report; the agents they manage report their own milestones.",
      };
    }
    const observation = this.store.getObservation(agentId);
    const lastSelfReportTs = observation.lastSelfReportTs;
    const withinRateLimitWindow =
      lastSelfReportTs !== null &&
      Date.now() - Date.parse(lastSelfReportTs) < SELF_REPORT_RATE_LIMIT_MS;
    if (withinRateLimitWindow && !this.store.wouldCoalesce(agentId, input.kind)) {
      return {
        ok: false,
        reason: "rate_limited",
        message:
          "Rate limited: one self-report per minute per agent. Fold this update into your previous report or wait before reporting again.",
      };
    }
    const event = await this.emitEvent({
      agentId,
      kind: input.kind,
      source: "self",
      severity: summarizerEventSeverity(input.kind),
      headline: input.headline,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.proof ? { proof: input.proof } : {}),
    });
    this.store.updateObservation(agentId, { lastSelfReportTs: event.ts });
    if (input.kind === "milestone" || input.kind === "finding") {
      void this.applySummarizerIdentityUpdate({ agentId, description: input.headline });
    }
    return { ok: true, event };
  }

  private handleManagerEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_state") {
      this.handleAgentState(event.agent);
      return;
    }
    if (event.type === "agent_stream") {
      this.handleAgentStream(event.agentId, event.event, event.seq, event.timestamp);
    }
  }

  private handleAgentState(agent: ManagedAgent): void {
    if (this.isExcludedAgent(agent)) {
      this.excludedAgentIds.add(agent.id);
      return;
    }
    this.excludedAgentIds.delete(agent.id);
    const previousLifecycle = this.lifecycleByAgent.get(agent.id);
    this.lifecycleByAgent.set(agent.id, agent.lifecycle);

    if (agent.lifecycle === "running") {
      if (previousLifecycle !== "running") {
        this.stallTracking.set(agent.id, { lastStreamAt: Date.now(), tailItem: null });
        if (!this.inRestartGrace()) {
          void this.emitEvent({
            agentId: agent.id,
            kind: "started",
            source: "system",
            severity: "info",
            headline: "Started running",
          });
        }
      }
    } else if (previousLifecycle === "running") {
      this.stallTracking.delete(agent.id);
      this.stalledByAgent.delete(agent.id);
    }

    if (agent.attention.requiresAttention) {
      const reason = agent.attention.attentionReason;
      if (this.attentionKeyByAgent.get(agent.id) !== reason) {
        this.attentionKeyByAgent.set(agent.id, reason);
        if (reason === "finished") {
          void this.emitEvent({
            agentId: agent.id,
            kind: "finished",
            source: "system",
            severity: "info",
            headline: "Finished",
          });
          this.summarizer.notifyFinished(agent.id);
        } else if (reason === "error") {
          void this.emitEvent({
            agentId: agent.id,
            kind: "failed",
            source: "system",
            severity: "attention",
            headline: "Failed with an error",
          });
        }
      }
    } else {
      this.attentionKeyByAgent.set(agent.id, "none");
    }

    if (agent.pendingPermissions.size > 0) {
      if (!this.blockedByAgent.has(agent.id)) {
        this.blockedByAgent.add(agent.id);
        void this.emitEvent({
          agentId: agent.id,
          kind: "blocked",
          source: "system",
          severity: "blocker",
          headline: "Waiting for permission",
        });
      }
    } else {
      this.blockedByAgent.delete(agent.id);
    }
  }

  private handleAgentStream(
    agentId: string,
    event: AgentStreamEvent,
    seq?: number,
    timestamp?: string,
  ): void {
    if (this.excludedAgentIds.has(agentId) || this.isExcludedAgent(null, agentId)) {
      return;
    }
    const tracking = this.stallTracking.get(agentId);
    if (tracking) {
      tracking.lastStreamAt = Date.now();
      this.stalledByAgent.delete(agentId);
      if (event.type === "timeline") {
        tracking.tailItem = event;
      }
    }
    if (event.type === "timeline" && seq !== undefined) {
      const row: AgentTimelineRow = {
        seq,
        timestamp: timestamp ?? new Date().toISOString(),
        item: event.item,
      };
      const rows = this.timelineRows.get(agentId) ?? [];
      rows.push(row);
      this.timelineRows.set(agentId, rows.slice(-TIMELINE_BUFFER_CAP));
      this.summarizer.notifyTimelineRows(agentId, [row]);
      return;
    }
    if (event.type === "turn_failed" && this.attentionKeyByAgent.get(agentId) !== "error") {
      this.attentionKeyByAgent.set(agentId, "error");
      void this.emitEvent({
        agentId,
        kind: "failed",
        source: "system",
        severity: "attention",
        headline: "Failed with an error",
      });
      return;
    }
    if (event.type === "permission_requested" && !this.blockedByAgent.has(agentId)) {
      this.blockedByAgent.add(agentId);
      void this.emitEvent({
        agentId,
        kind: "blocked",
        source: "system",
        severity: "blocker",
        headline: "Waiting for permission",
      });
    }
  }

  private sweepStalled(): void {
    if (this.inRestartGrace()) {
      return;
    }
    const now = Date.now();
    for (const [agentId, tracking] of this.stallTracking) {
      if (this.stalledByAgent.has(agentId)) {
        continue;
      }
      const hasInFlightTool = this.hasInFlightToolCall(tracking);
      const threshold = hasInFlightTool ? STALL_IN_FLIGHT_TOOL_MS : STALL_NO_IN_FLIGHT_TOOL_MS;
      if (now - tracking.lastStreamAt >= threshold) {
        this.stalledByAgent.add(agentId);
        const minutes = Math.round(threshold / 60_000);
        void this.emitEvent({
          agentId,
          kind: "stalled",
          source: "system",
          severity: "attention",
          headline: `Stalled (no activity for ${minutes} min)`,
        });
      }
    }
  }

  private hasInFlightToolCall(tracking: StallTracking): boolean {
    const tail = tracking.tailItem;
    if (!tail || tail.type !== "timeline") {
      return false;
    }
    return tail.item.type === "tool_call" && tail.item.status === "running";
  }

  private isExcludedAgent(agent?: ManagedAgent | null, agentId?: string): boolean {
    const candidate = agent ?? (agentId ? this.agentManager.getAgent(agentId) : null);
    if (candidate) {
      return candidate.internal === true || hasExclusionLabels(candidate.labels);
    }
    return false;
  }

  private inRestartGrace(): boolean {
    return Date.now() - this.bootedAtMs < RESTART_GRACE_MS;
  }

  private async emitEvent(
    input: Omit<MissionControlAppendInput, "agentTitle">,
  ): Promise<MissionControlEvent> {
    const agentTitle = await this.resolveAgentTitle(input.agentId);
    const event = await this.store.append({ ...input, agentTitle });
    this.broadcast({
      type: "mission_control_event",
      event,
    });
    this.digest?.enqueue(event, { serverId: this.serverId, hostName: this.hostName });
    return event;
  }

  private async resolveAgentTitle(agentId: string): Promise<string> {
    // Mission Control gives every agent a fleet-wide name; prefer it over the
    // task-derived title so feed cards and digest entries read as identities.
    const live = this.agentManager.getAgent(agentId);
    if (live?.name) {
      return live.name;
    }
    const record = await this.agentStorage.get(agentId);
    return record?.name ?? record?.title ?? agentId;
  }

  private async applySummarizerIdentityUpdate(params: MissionControlIdentityUpdate): Promise<void> {
    try {
      await this.agentManager.updateAgentMetadata(params.agentId, {
        ...(params.description !== undefined ? { shortDescription: params.description } : {}),
        ...(params.title ? { title: params.title } : {}),
      });
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: params.agentId },
        "Failed to refresh agent identity from summarizer",
      );
    }
  }

  private readConfig(): MissionControlServiceConfig {
    const config = this.daemonConfigStore.get().missionControl;
    const summarizer = resolveSummarizerConfig(config?.summarizer);
    return {
      retentionDays: config?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      summarizer,
      autopilot: resolveAutopilotConfig(config?.autopilot, summarizer),
    };
  }
}

type RawMissionControlConfig = NonNullable<MutableDaemonConfig["missionControl"]>;

function resolveSummarizerConfig(
  raw: RawMissionControlConfig["summarizer"],
): MissionControlSummarizerConfig {
  const defaults: MissionControlSummarizerConfig = {
    enabled: true,
    backend: "gateway",
    baseUrl: process.env.LLM_GATEWAY_URL ?? null,
    apiKey: process.env.LLM_GATEWAY_KEY ?? null,
    model: "extract",
    minNewItems: 12,
    debounceSeconds: 30,
  };
  return {
    enabled: raw?.enabled ?? defaults.enabled,
    backend: raw?.backend ?? defaults.backend,
    baseUrl: raw?.baseUrl ?? defaults.baseUrl,
    apiKey: raw?.apiKey ?? defaults.apiKey,
    model: raw?.model ?? defaults.model,
    minNewItems: raw?.minNewItems ?? defaults.minNewItems,
    debounceSeconds: raw?.debounceSeconds ?? defaults.debounceSeconds,
  };
}

function resolveAutopilotConfig(
  raw: RawMissionControlConfig["autopilot"],
  summarizer: MissionControlSummarizerConfig,
): MissionControlAutopilotConfig {
  return {
    mode: raw?.mode ?? "off",
    model: raw?.model ?? null,
    scope: raw?.scope ?? "commander-spawned",
    maxNudgesPerAgent: raw?.maxNudgesPerAgent ?? 2,
    // The evaluator reuses the summarizer's judgment backend + gateway
    // connection settings; only the model is autopilot-specific.
    backend: summarizer.backend,
    baseUrl: summarizer.baseUrl,
    apiKey: summarizer.apiKey,
  };
}

function hasExclusionLabels(labels: Record<string, string>): boolean {
  if (Object.keys(labels).some((key) => key.startsWith(MISSION_CONTROL_LABEL_PREFIX))) {
    return true;
  }
  return PARENT_AGENT_ID_LABEL in labels;
}
