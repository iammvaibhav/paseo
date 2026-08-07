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
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { MissionControlDigestSink } from "./digest.js";
import {
  MissionControlStore,
  type MissionControlAppendInput,
  type MissionControlFetchOptions,
} from "./store.js";
import { MissionControlSummarizer, type MissionControlSummarizerConfig } from "./summarizer.js";

const DEFAULT_RETENTION_DAYS = 30;
const STALL_SWEEP_INTERVAL_MS = 30_000;
const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESTART_GRACE_MS = 60_000;
const STALL_NO_IN_FLIGHT_TOOL_MS = 5 * 60_000;
const STALL_IN_FLIGHT_TOOL_MS = 20 * 60_000;
const TIMELINE_BUFFER_CAP = 2000;
const MISSION_CONTROL_LABEL_PREFIX = "paseo.mission-control";

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
}

export class MissionControlService {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly summarizer: MissionControlSummarizer;
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
    });
  }

  async start(): Promise<void> {
    await this.store.initialize();
    await this.store.prune(this.readConfig().retentionDays);
    this.summarizer.start();
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
  }

  fetchEvents(options?: MissionControlFetchOptions): MissionControlEvent[] {
    return this.store.fetchEvents(options);
  }

  ackEvents(eventIds: string[]): void {
    this.store.ackEvents(eventIds);
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

  private async emitEvent(input: Omit<MissionControlAppendInput, "agentTitle">): Promise<void> {
    const agentTitle = await this.resolveAgentTitle(input.agentId);
    const event = await this.store.append({ ...input, agentTitle });
    this.broadcast({
      type: "mission_control_event",
      event,
    });
    this.digest?.enqueue(event, { serverId: this.serverId, hostName: this.hostName });
  }

  private async resolveAgentTitle(agentId: string): Promise<string> {
    const record = await this.agentStorage.get(agentId);
    return record?.title ?? agentId;
  }

  private readConfig(): MissionControlServiceConfig {
    const config = this.daemonConfigStore.get().missionControl;
    const defaults: MissionControlSummarizerConfig = {
      enabled: true,
      baseUrl: process.env.LLM_GATEWAY_URL ?? null,
      apiKey: process.env.LLM_GATEWAY_KEY ?? null,
      model: "extract",
      minNewItems: 12,
      debounceSeconds: 30,
    };
    const summarizer = config?.summarizer;
    return {
      retentionDays: config?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      summarizer: {
        enabled: summarizer?.enabled ?? defaults.enabled,
        baseUrl: summarizer?.baseUrl ?? defaults.baseUrl,
        apiKey: summarizer?.apiKey ?? defaults.apiKey,
        model: summarizer?.model ?? defaults.model,
        minNewItems: summarizer?.minNewItems ?? defaults.minNewItems,
        debounceSeconds: summarizer?.debounceSeconds ?? defaults.debounceSeconds,
      },
    };
  }
}

function hasExclusionLabels(labels: Record<string, string>): boolean {
  if (Object.keys(labels).some((key) => key.startsWith(MISSION_CONTROL_LABEL_PREFIX))) {
    return true;
  }
  return PARENT_AGENT_ID_LABEL in labels;
}
