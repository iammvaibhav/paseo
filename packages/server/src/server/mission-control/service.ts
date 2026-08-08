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
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { SessionOutboundMessage } from "../messages.js";
import type {
  MissionControlEvent,
  MissionControlLifecycleAction,
  MissionControlMode,
  MissionControlProposal,
  MissionControlReportStatusInput,
} from "@getpaseo/protocol/mission-control/types";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { hasMissionControlLabels } from "./naming.js";
import type { MissionControlDigestSink } from "./digest.js";
import {
  MissionControlStore,
  generateProposalId,
  type MissionControlAppendInput,
  type MissionControlFetchOptions,
  type MissionControlMessageTag,
  type MissionControlReviewStateRecord,
  type MissionControlVerdict,
} from "./store.js";
import { MissionControlApprovals, type MissionControlApprovalsOptions } from "./approvals.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";
import type { MissionControlPresenceSource } from "./presence.js";
import {
  CentralMissionControlConfigStore,
  type ResolvedMissionControlCentralConfig,
} from "./config.js";

const STALL_SWEEP_INTERVAL_MS = 30_000;
const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESTART_GRACE_MS = 60_000;
// Wait-aware: an open hub-wait/subagent-wait tool call extends the stall
// clock by the declared timeout plus this grace before nudging.
const STALL_WAIT_GRACE_MS = 120_000;
// Declared timeouts used when the open wait call does not carry one.
const HUB_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60_000;
// Watchdog: record still says running but the provider runtime is dead for
// this long before self-healing the record to error.
const WATCHDOG_DEAD_RUNTIME_MS = 2 * 60_000;
const TIMELINE_BUFFER_CAP = 2000;
const MISSION_CONTROL_LABEL_PREFIX = "paseo.mission-control";
const SELF_REPORT_RATE_LIMIT_MS = 60_000;

/**
 * Stall v2 threshold math. Wait-aware: an open known-wait tool call extends
 * the clock to the declared timeout + 120s (nudge) and keeps the configured
 * nudge→escalate gap on top (escalate = declared + 120 + (escalate - nudge)).
 * Exported so the wait-aware math is unit-testable without a service.
 */
export function computeStallThresholdsMs(params: {
  waitAwareTimeoutMs: number | null;
  nudgeSeconds: number;
  escalateSeconds: number;
}): { nudgeMs: number; escalateMs: number } {
  const { waitAwareTimeoutMs, nudgeSeconds, escalateSeconds } = params;
  const nudgeMs = nudgeSeconds * 1000;
  const escalateMs = escalateSeconds * 1000;
  if (waitAwareTimeoutMs === null) {
    return { nudgeMs, escalateMs };
  }
  const waitBaseMs = waitAwareTimeoutMs + STALL_WAIT_GRACE_MS;
  return { nudgeMs: waitBaseMs, escalateMs: waitBaseMs + (escalateMs - nudgeMs) };
}

interface StallTracking {
  lastStreamAt: number;
  tailItem: AgentStreamEvent | null;
  /** Fired once per silence episode (nudge proposal through the approval gate). */
  nudgedAt: number | null;
  /** Fired once per silence episode (stalled event + Needs-you card). */
  escalatedAt: number | null;
  /** First sweep time the provider runtime was observed dead; null while alive. */
  deadSince: number | null;
  /** Watchdog already self-healed this run; skip re-healing until lifecycle change. */
  healed: boolean;
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
  /** Presence contract for the approval gate (focused client / user-stop). */
  presence: MissionControlPresenceSource;
  /**
   * Ephemeral verifier dispatcher (VerifierSlice's MissionControlVerifierDispatcher).
   * Optional so the service boots without it; bootstrap wires it.
   */
  verifier?: { start(): void | Promise<void>; stop(): void | Promise<void> } | null;
}

export interface MissionControlServiceConfig {
  retentionDays: number;
  /** Stall v2 thresholds, seconds of silence mid-run. Central-config driven. */
  stall: { nudgeSeconds: number; escalateSeconds: number };
}

export type SelfReportResult =
  | { ok: true; event: MissionControlEvent }
  | { ok: false; reason: "excluded" | "rate_limited"; message: string };

export type ReviewStateListener = (
  agentId: string,
  record: MissionControlReviewStateRecord,
) => void;

export class MissionControlService {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly serverId: string;
  private readonly hostName: string;
  private readonly broadcast: (message: SessionOutboundMessage) => void;
  private readonly digest: MissionControlDigestSink | null;
  private readonly verifier: MissionControlServiceOptions["verifier"];
  private readonly centralConfig: CentralMissionControlConfigStore;
  private readonly presenceSource: MissionControlPresenceSource;
  readonly approvals: MissionControlApprovals;

  private readonly timelineRows = new Map<string, AgentTimelineRow[]>();
  private readonly lifecycleByAgent = new Map<string, AgentLifecycleStatus>();
  private readonly attentionKeyByAgent = new Map<string, string>();
  private readonly blockedByAgent = new Set<string>();
  private readonly stalledByAgent = new Set<string>();
  private readonly stallTracking = new Map<string, StallTracking>();
  private readonly excludedAgentIds = new Set<string>();
  private readonly reviewStateListeners = new Set<ReviewStateListener>();
  private readonly selfReportListeners = new Set<(event: MissionControlEvent) => void>();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly bootedAtMs: number;

  constructor(options: MissionControlServiceOptions) {
    this.logger = options.logger.child({ module: "mission-control" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.serverId = options.serverId;
    this.hostName = options.hostName;
    this.broadcast = options.broadcast;
    this.digest = options.digest ?? null;
    this.verifier = options.verifier ?? null;
    this.presenceSource = options.presence;
    this.bootedAtMs = Date.now();
    this.store = new MissionControlStore({ paseoHome: options.paseoHome, logger: this.logger });
    this.centralConfig = new CentralMissionControlConfigStore({
      paseoHome: options.paseoHome,
      logger: this.logger,
    });
    this.approvals = new MissionControlApprovals(this.buildApprovalsOptions());
  }

  private buildApprovalsOptions(): MissionControlApprovalsOptions {
    return {
      store: this.store,
      presence: this.presenceSource,
      logger: this.logger,
      getMode: () => this.centralConfig.get().mode,
      deliver: async (input) => {
        // Same delivery semantics as fleet_send_prompt: busy omp turns are
        // live-steered out-of-band (/steer, instant, non-cancelling); idle
        // agents run normally; busy providers without a steer path queue
        // until idle. Stall nudges always target mid-run agents, so a busy
        // target must never fail the delivery.
        await dispatchLocalPromptMode({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId: input.agentId,
          prompt: input.message,
          mode: input.deliveryMode,
          logger: this.logger,
        });
      },
      publishProposalEvent: async (proposal) => {
        const event = await this.emitProposalEvent(proposal);
        return { id: event.id };
      },
    };
  }

  async start(): Promise<void> {
    await this.centralConfig.initialize();
    await this.store.initialize();
    await this.store.prune(this.readConfig().retentionDays);
    this.unsubscribe = this.agentManager.subscribe((event) => this.handleManagerEvent(event));
    this.sweepTimer = setInterval(() => {
      this.sweepStalled();
      void this.runWatchdog().catch((error: unknown) => {
        this.logger.error(
          { err: error, component: "stall", watchdogHeal: true },
          "Watchdog sweep failed",
        );
      });
      void this.approvals.expireStale().catch((error: unknown) => {
        this.logger.warn(
          { err: error, component: "approvals" },
          "Failed to sweep expired proposals",
        );
      });
    }, STALL_SWEEP_INTERVAL_MS);
    this.pruneTimer = setInterval(() => {
      void this.store.prune(this.readConfig().retentionDays).catch((error) => {
        this.logger.warn({ err: error }, "Failed to prune mission control events");
      });
    }, DAILY_PRUNE_INTERVAL_MS);
    void this.verifier?.start();
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
    void this.verifier?.stop();
  }

  fetchEvents(options?: MissionControlFetchOptions): MissionControlEvent[] {
    return this.store.fetchEvents(options);
  }

  ackEvents(eventIds: string[]): void {
    this.store.ackEvents(eventIds);
  }

  // ==========================================================================
  // v3 review lifecycle
  // ==========================================================================

  getReviewState(agentId: string): MissionControlReviewStateRecord {
    return this.store.getReviewState(agentId);
  }

  getReviewStates(): ReadonlyMap<string, MissionControlReviewStateRecord> {
    return this.store.getReviewStates();
  }

  getReadyForReview(): string[] {
    return this.store.getReadyForReview();
  }

  /**
   * Public review-state write (verifier dispatcher + internal callers).
   * A done/cleared transition with a verdict emits the kind:"verdict" card;
   * source reflects verdict.by ("verifier" → "verifier", "user" → "system").
   */
  async setReviewState(
    agentId: string,
    state: "none" | "ready" | "done" | "cleared",
    options?: { verdict?: MissionControlVerdict },
  ): Promise<void> {
    await this.store.setReviewState(agentId, state, options);
    if (options?.verdict && (state === "done" || state === "cleared")) {
      await this.emitVerdictEvent({ agentId, verdict: options.verdict });
    }
    this.notifyReviewState(agentId);
  }

  /** Fire-and-forget feed card emission (verifier retry-exhaustion cards). */
  publishEvent(input: Omit<MissionControlAppendInput, "agentTitle">): void {
    void this.emitEvent(input);
  }

  subscribeReviewState(listener: ReviewStateListener): () => void {
    this.reviewStateListeners.add(listener);
    return () => {
      this.reviewStateListeners.delete(listener);
    };
  }

  /**
   * mission_control.lifecycle.set: mark done / clear / reopen. Done writes
   * reviewState=done + a user verdict and emits a verdict card; clear removes
   * from the Done display; reopen resets so the next run re-enters the
   * lifecycle.
   */
  async setLifecycle(input: {
    agentId: string;
    action: MissionControlLifecycleAction;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const agent = await this.agentStorage.get(input.agentId);
    if (!agent) {
      return { ok: false, error: `Agent ${input.agentId} not found` };
    }
    const now = new Date().toISOString();
    switch (input.action) {
      case "done": {
        const verdict: MissionControlVerdict = { by: "user", summary: "Marked done", at: now };
        await this.store.setReviewState(input.agentId, "done", { verdict });
        await this.emitVerdictEvent({ agentId: input.agentId, verdict });
        this.notifyReviewState(input.agentId);
        return { ok: true };
      }
      case "clear": {
        await this.store.setReviewState(input.agentId, "cleared");
        await this.emitVerdictEvent({
          agentId: input.agentId,
          verdict: { by: "user", summary: "Cleared", at: now },
        });
        this.notifyReviewState(input.agentId);
        return { ok: true };
      }
      case "reopen": {
        await this.store.setReviewState(input.agentId, "none");
        this.notifyReviewState(input.agentId);
        return { ok: true };
      }
    }
  }

  // ==========================================================================
  // v3 approval gate surface
  // ==========================================================================

  respondProposal(input: {
    proposalId: string;
    action: "approve" | "deny";
    editedMessage?: string;
    allowPair?: boolean;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.approvals.resolveProposal(input);
  }

  /**
   * Emit a commander-origin proposal card (kind "proposal", classification
   * normal) from the one-time naming backfill — the workspace rename
   * proposals card. Always lands pending: it never auto-sends, regardless of
   * ask/auto mode. Approving merely steers the target; applying renames is a
   * separate manual step driven by the workspace.title.set RPC.
   */
  async createBackfillProposalCard(input: {
    message: string;
    reason?: string;
    targetAgentId?: string | null;
  }): Promise<{ ok: true; proposalId: string } | { ok: false; error: string }> {
    const targetAgentId = input.targetAgentId ?? (await this.resolveCommanderAgentId());
    if (!targetAgentId) {
      return {
        ok: false,
        error: "No target agent for the proposal card (no Commander on this host)",
      };
    }
    const proposal: MissionControlProposal = {
      id: generateProposalId(),
      createdAt: new Date().toISOString(),
      origin: "commander",
      serverId: this.serverId,
      targetAgentId,
      message: input.message,
      deliveryMode: "steer",
      reason: input.reason?.trim() || "Mission Control",
      classification: "normal",
      status: "pending",
    };
    await this.store.putProposal(proposal);
    await this.emitProposalEvent(proposal);
    this.logger.info(
      {
        component: "approvals",
        proposalId: proposal.id,
        origin: "commander",
        targetAgentId,
        classification: "normal",
        status: "pending",
        backfill: true,
      },
      "mission_control.approvals.proposal_created",
    );
    return { ok: true, proposalId: proposal.id };
  }

  /** The Commander is the agent labeled paseo.mission-control=commander. */
  private async resolveCommanderAgentId(): Promise<string | null> {
    for (const record of await this.agentStorage.list()) {
      if (
        !record.archivedAt &&
        record.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE
      ) {
        return record.id;
      }
    }
    for (const agent of this.agentManager.listAgents()) {
      if (agent.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE) {
        return agent.id;
      }
    }
    return null;
  }

  getProposal(proposalId: string): MissionControlProposal | null {
    return this.approvals.getProposal(proposalId);
  }

  listProposals(): MissionControlProposal[] {
    return this.approvals.listProposals();
  }

  onProposalChange(listener: (proposal: MissionControlProposal) => void): () => void {
    return this.approvals.onProposalChange(listener);
  }

  // ==========================================================================
  // v3 central config + mode
  // ==========================================================================

  getCentralConfig(): ResolvedMissionControlCentralConfig {
    return this.centralConfig.get();
  }

  async patchCentralConfig(
    patch: MissionControlCentralConfigPatch,
  ): Promise<ResolvedMissionControlCentralConfig> {
    return this.centralConfig.patch(patch);
  }

  async setMode(mode: MissionControlMode): Promise<ResolvedMissionControlCentralConfig> {
    return this.centralConfig.setMode(mode);
  }

  // ==========================================================================
  // v3 user-message tagging (Commander records relatedAgentIds)
  // ==========================================================================

  recordMessageTags(input: Omit<MissionControlMessageTag, "ts"> & { ts?: string }): void {
    this.store.recordMessageTags(input);
  }

  allMessageTags(): MissionControlMessageTag[] {
    return this.store.allMessageTags();
  }

  // ==========================================================================
  // v3 stop origins + dormant derivation
  // ==========================================================================

  getStopOrigin(agentId: string): "user" | "machinery" | null {
    return this.store.getStopOrigin(agentId);
  }

  recordStopOrigin(agentId: string, origin: "user" | "machinery" | null): void {
    this.store.recordStopOrigin(agentId, origin);
  }

  isDormant(agentId: string): boolean {
    return this.store.isDormant(agentId);
  }

  dormantAgentIds(): string[] {
    return this.store.dormantAgentIds();
  }

  // ==========================================================================
  // Self-reporting (report_status tool)
  // ==========================================================================

  /**
   * Self-reported status from the report_status MCP tool (renamed from
   * report_milestone; the old tool name is deleted). Excluded agents get a
   * polite error; a within-window report is only accepted when it coalesces
   * into the agent's existing unacked event of the same kind.
   *
   * status mapping: working → kind from input.kind; completed → finished +
   * ready-for-review (post-rollout only); inconclusive → diverged (no ready);
   * blocked → blocked (blocker severity). title/description flow through the
   * identity path.
   */
  async reportSelfStatus(
    agentId: string,
    input: MissionControlReportStatusInput,
  ): Promise<SelfReportResult> {
    const agent = this.agentManager.getAgent(agentId);
    if (agent && hasMissionControlLabels(agent.labels)) {
      return {
        ok: false,
        reason: "excluded",
        message:
          "Mission Control agents do not self-report; the agents they manage report their own status.",
      };
    }
    const observation = this.store.getObservation(agentId);
    const lastSelfReportTs = observation.lastSelfReportTs;
    const withinRateLimitWindow =
      lastSelfReportTs !== null &&
      Date.now() - Date.parse(lastSelfReportTs) < SELF_REPORT_RATE_LIMIT_MS;
    const { kind, severity } = mapReportStatus(input);
    if (withinRateLimitWindow && !this.store.wouldCoalesce(agentId, kind)) {
      return {
        ok: false,
        reason: "rate_limited",
        message:
          "Rate limited: one self-report per minute per agent. Fold this update into your previous report or wait before reporting again.",
      };
    }
    const event = await this.emitEvent({
      agentId,
      kind,
      source: "self",
      severity,
      headline: input.headline,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.proofs && input.proofs.length > 0 ? { proof: input.proofs } : {}),
    });
    this.store.updateObservation(agentId, { lastSelfReportTs: event.ts });
    if (input.title !== undefined || input.description !== undefined) {
      await this.applyIdentityUpdate(agentId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    }
    if (input.status === "completed") {
      // Ready-for-review accrues only from rollout onward; pre-rollout agents
      // stay dormant even when a finish event predates the rollout marker.
      if (this.store.getRolloutTs() !== null) {
        await this.store.setReviewState(agentId, "ready");
        this.notifyReviewState(agentId);
      }
    }
    for (const listener of this.selfReportListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "mission_control.self_report_listener_failed");
      }
    }
    return { ok: true, event };
  }

  /**
   * Subscribe to self-reported status events (source "self") — the verifier's
   * worker-reply relay listens here to catch the worker's next report_status.
   */
  subscribeSelfReports(listener: (event: MissionControlEvent) => void): () => void {
    this.selfReportListeners.add(listener);
    return () => {
      this.selfReportListeners.delete(listener);
    };
  }

  // ==========================================================================
  // Internal plumbing
  // ==========================================================================

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
        this.stallTracking.set(agent.id, {
          lastStreamAt: Date.now(),
          tailItem: null,
          nudgedAt: null,
          escalatedAt: null,
          deadSince: null,
          healed: false,
        });
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
          // A finished run moves the agent to ready-for-review (rollout onward).
          void this.markReadyForReview(agent.id);
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

  private async markReadyForReview(agentId: string): Promise<void> {
    if (this.store.getRolloutTs() === null) {
      return;
    }
    await this.store.setReviewState(agentId, "ready");
    this.notifyReviewState(agentId);
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
      tracking.nudgedAt = null;
      tracking.escalatedAt = null;
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

  /**
   * Stall v2: silent >nudgeSeconds mid-run (no timeline rows) -> status-ask
   * steer through the approval gate, once per silence episode. Silent
   * >escalateSeconds -> stalled event + Needs-you card, once per episode.
   * Wait-aware: when the open tool call is a known wait (hub wait, subagent
   * wait), the clock extends to declared timeout + 120s (nudge) and
   * declared timeout + 300s (escalate), keeping the configured gap.
   */
  private sweepStalled(): void {
    if (this.inRestartGrace()) {
      return;
    }
    const now = Date.now();
    const { nudgeSeconds, escalateSeconds } = this.readConfig().stall;
    for (const [agentId, tracking] of this.stallTracking) {
      if (this.stalledByAgent.has(agentId)) {
        continue;
      }
      const waitAwareMs = this.openWaitTimeoutMs(tracking);
      const silenceMs = now - tracking.lastStreamAt;
      const { nudgeMs, escalateMs } = computeStallThresholdsMs({
        waitAwareTimeoutMs: waitAwareMs,
        nudgeSeconds,
        escalateSeconds,
      });
      if (tracking.nudgedAt === null && silenceMs >= nudgeMs) {
        this.fireStallNudge(agentId, tracking, nudgeSeconds);
      }
      if (tracking.escalatedAt === null && silenceMs >= escalateMs) {
        this.escalateStall(agentId, tracking, waitAwareMs !== null, escalateMs);
      }
    }
  }

  /** Status-ask steer through the approval gate; one per silence episode. */
  private fireStallNudge(agentId: string, tracking: StallTracking, nudgeSeconds: number): void {
    tracking.nudgedAt = Date.now();
    this.logger.warn(
      { component: "stall", agentId, silentSeconds: nudgeSeconds },
      "Stall nudge proposal created",
    );
    void this.approvals
      .createProposal({
        origin: "stall",
        serverId: this.serverId,
        targetAgentId: agentId,
        message: "You've been silent for a while. Post a one-line report_status, then continue.",
        deliveryMode: "steer",
        reason: `No timeline activity for >${nudgeSeconds}s mid-run`,
        classification: "normal",
      })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, component: "stall", agentId },
          "Failed to create stall nudge proposal",
        );
      });
  }

  /** Stalled event + Needs-you card; once per silence episode. */
  private escalateStall(
    agentId: string,
    tracking: StallTracking,
    waitAware: boolean,
    escalateMs: number,
  ): void {
    tracking.escalatedAt = Date.now();
    const minutes = Math.round(escalateMs / 60_000);
    void this.emitEvent({
      agentId,
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: `Stalled (no activity for ${minutes} min)`,
    });
    this.logger.warn(
      { component: "stall", agentId, waitAware, escalateMs },
      "Stall escalated; Needs-you card emitted",
    );
  }

  /**
   * Declared timeout of the open wait tool call, or null when the tail tool
   * call is not a known wait (hub wait / subagent wait). Falls back to the
   * per-kind default when the call carries no explicit timeout.
   */
  private openWaitTimeoutMs(tracking: StallTracking): number | null {
    const tail = tracking.tailItem;
    if (!tail || tail.type !== "timeline") {
      return null;
    }
    if (tail.item.type !== "tool_call" || tail.item.status !== "running") {
      return null;
    }
    const item = tail.item;
    const name = item.name.toLowerCase();
    const input =
      item.detail.type === "unknown" && isRecord(item.detail.input) ? item.detail.input : null;
    const declared = declaredWaitTimeoutMs(input);
    if (name === "hub") {
      const op = typeof input?.op === "string" ? input.op : "";
      if (op !== "wait") {
        return null;
      }
      return declared ?? HUB_WAIT_DEFAULT_TIMEOUT_MS;
    }
    if (name === "task" || item.detail.type === "sub_agent") {
      return declared ?? SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS;
    }
    return null;
  }

  /**
   * Reconciliation watchdog: a record stuck `running` whose provider runtime
   * is dead for >2min self-heals — record -> error, stalled event, loud log.
   * Root-causing the freeze itself is out of scope (tracked separately).
   */
  private async runWatchdog(): Promise<void> {
    if (this.inRestartGrace()) {
      return;
    }
    const now = Date.now();
    for (const [agentId, tracking] of this.stallTracking) {
      if (tracking.healed) {
        continue;
      }
      const live = this.agentManager.getAgent(agentId);
      const runtimeDead =
        live !== null && live.lifecycle !== "closed" && live.session?.isRuntimeAlive?.() === false;
      if (!runtimeDead) {
        tracking.deadSince = null;
        continue;
      }
      if (tracking.deadSince === null) {
        tracking.deadSince = now;
        continue;
      }
      if (now - tracking.deadSince < WATCHDOG_DEAD_RUNTIME_MS) {
        continue;
      }
      try {
        await this.selfHealDeadRuntime(agentId);
      } catch (error) {
        this.logger.error(
          { err: error, component: "stall", watchdogHeal: true, agentId },
          "Watchdog self-heal failed",
        );
        continue;
      }
      tracking.healed = true;
      tracking.nudgedAt = now;
      tracking.escalatedAt = now;
    }
  }

  private async selfHealDeadRuntime(agentId: string): Promise<void> {
    const record = await this.agentStorage.get(agentId);
    if (!record || record.lastStatus !== "running") {
      this.logger.warn(
        { component: "stall", watchdogHeal: true, agentId, lastStatus: record?.lastStatus ?? null },
        "Watchdog: no running record to self-heal",
      );
      return;
    }
    await this.agentStorage.upsert({
      ...record,
      lastStatus: "error",
      updatedAt: new Date().toISOString(),
    });
    this.store.recordStopOrigin(agentId, "machinery");
    await this.emitEvent({
      agentId,
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: "Provider runtime died; run record self-healed to error",
    });
    this.logger.error(
      {
        component: "stall",
        watchdogHeal: true,
        agentId,
        recordStatus: record.lastStatus,
      },
      "Watchdog self-healed dead provider runtime (record -> error, stalled event emitted)",
    );
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
    options?: { skipDigest?: boolean },
  ): Promise<MissionControlEvent> {
    const agentTitle = await this.resolveAgentTitle(input.agentId);
    const event = await this.store.append({ ...input, agentTitle });
    this.broadcast({
      type: "mission_control_event",
      event,
    });
    if (!options?.skipDigest) {
      this.digest?.enqueue(event, { serverId: this.serverId, hostName: this.hostName });
    }
    return event;
  }

  /** Proposal cards ride the feed as kind:"proposal" events. */
  private async emitProposalEvent(proposal: MissionControlProposal): Promise<MissionControlEvent> {
    const pending = proposal.status === "pending";
    return this.emitEvent(
      {
        agentId: proposal.targetAgentId,
        kind: "proposal",
        source: proposal.origin === "verifier" ? "verifier" : "system",
        severity: pending ? "blocker" : "info",
        headline: pending
          ? `Proposal (${proposal.origin}): ${proposal.reason}`
          : `Proposal ${proposal.status}`,
        detail: proposal.message,
        proposal,
      },
      { skipDigest: true },
    );
  }

  /** Verdict cards ride the feed as kind:"verdict" events. */
  private async emitVerdictEvent(input: {
    agentId: string;
    verdict: MissionControlVerdict;
  }): Promise<MissionControlEvent> {
    const summary = input.verdict.summary;
    let headline: string;
    if (summary === "Marked done") {
      headline = "Marked done";
    } else if (summary === "Cleared") {
      headline = "Cleared";
    } else {
      headline = `Done — ${summary}`;
    }
    return this.emitEvent(
      {
        agentId: input.agentId,
        kind: "verdict",
        source: input.verdict.by === "verifier" ? "verifier" : "system",
        severity: "info",
        headline,
        detail: input.verdict.summary,
      },
      { skipDigest: true },
    );
  }

  private notifyReviewState(agentId: string): void {
    const record = this.store.getReviewState(agentId);
    for (const listener of this.reviewStateListeners) {
      try {
        listener(agentId, record);
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "mission_control.review_state_listener_failed");
      }
    }
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

  private async applyIdentityUpdate(
    agentId: string,
    params: { title?: string; description?: string },
  ): Promise<void> {
    try {
      await this.agentManager.updateAgentMetadata(agentId, {
        ...(params.description !== undefined ? { shortDescription: params.description } : {}),
        ...(params.title ? { title: params.title } : {}),
      });
    } catch (error) {
      this.logger.warn(
        { err: error, agentId },
        "Failed to refresh agent identity from report_status",
      );
    }
  }

  private readConfig(): MissionControlServiceConfig {
    const central = this.centralConfig.get();
    return {
      // v3: retention + stall thresholds are central-config driven.
      retentionDays: central.retentionDays,
      stall: {
        nudgeSeconds: central.nudgeSeconds,
        escalateSeconds: central.escalateSeconds,
      },
    };
  }
}

type MissionControlCentralConfigPatch = Parameters<CentralMissionControlConfigStore["patch"]>[0];

function mapReportStatus(input: MissionControlReportStatusInput): {
  kind: MissionControlAppendInput["kind"];
  severity: MissionControlAppendInput["severity"];
} {
  switch (input.status) {
    case "blocked":
      return { kind: "blocked", severity: "blocker" };
    case "completed":
      return { kind: "finished", severity: "info" };
    case "inconclusive":
      return { kind: "diverged", severity: "attention" };
    case "working":
      switch (input.kind) {
        case "finding":
        case "fix":
        case "decision":
          return { kind: "finding", severity: "info" };
        case "progress":
        case "milestone":
        case undefined:
          return { kind: "milestone", severity: "info" };
      }
  }
}

function hasExclusionLabels(labels: Record<string, string>): boolean {
  if (Object.keys(labels).some((key) => key.startsWith(MISSION_CONTROL_LABEL_PREFIX))) {
    return true;
  }
  return PARENT_AGENT_ID_LABEL in labels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicit timeout on a wait tool call (timeoutMs wins over timeout). */
function declaredWaitTimeoutMs(input: Record<string, unknown> | null): number | null {
  if (typeof input?.timeoutMs === "number" && input.timeoutMs > 0) {
    return input.timeoutMs;
  }
  if (typeof input?.timeout === "number" && input.timeout > 0) {
    return input.timeout;
  }
  return null;
}
