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
import {
  MissionControlApprovals,
  ProposalDeliveryAborted,
  type MissionControlApprovalsOptions,
} from "./approvals.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";
import type { MissionControlPresenceSource } from "./presence.js";
import {
  CentralMissionControlConfigStore,
  type ResolvedMissionControlCentralConfig,
} from "./config.js";
import type { AgentNamingService } from "./naming.js";

const STALL_SWEEP_INTERVAL_MS = 30_000;
const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESTART_GRACE_MS = 60_000;
// Watchdog: record still says running but the provider runtime is dead for
// this long before self-healing the record to error.
const WATCHDOG_DEAD_RUNTIME_MS = 2 * 60_000;
const TIMELINE_BUFFER_CAP = 2000;
const MISSION_CONTROL_LABEL_PREFIX = "paseo.mission-control";
const SELF_REPORT_RATE_LIMIT_MS = 60_000;
/** Exponential-backoff ceiling for nudge intervals: 30 minutes. */
const NUDGE_BACKOFF_CAP_MS = 30 * 60 * 1000;

/**
 * Effective nudge interval for a trigger after `priorNudges` nudges of that
 * trigger in the same run: base interval doubles per nudge (120 -> 240 ->
 * 480 ...), capped at 30 minutes. Reset by a user prompt or run end.
 * Exported so the backoff math is unit-testable without a service.
 */
export function nudgeBackoffMs(baseSeconds: number, priorNudges: number): number {
  const baseMs = baseSeconds * 1000;
  if (priorNudges <= 0) {
    return Math.min(baseMs, NUDGE_BACKOFF_CAP_MS);
  }
  return Math.min(baseMs * 2 ** priorNudges, NUDGE_BACKOFF_CAP_MS);
}

interface StallTracking {
  /** Last timeline activity (any stream event). Escalation's "no response at
   *  all" check uses this — a timeline row after the nudge counts as a
   *  response. */
  lastStreamAt: number;
  /** Last report_status landing; run start counts as the origin. The nudge
   *  timer keys to this ONLY — timeline rows do not reset it. */
  lastStatusAt: number;
  /** When the current lapse's FIRST status-ask steer was sent (either
   *  trigger). The escalation window ("no response for escalateSeconds after
   *  ANY nudge") anchors here — re-nudges within the lapse do not restart it.
   *  Cleared when a report_status lands or the run ends. */
  nudgedAt: number | null;
  /** When the MOST RECENT status-ask steer was sent (either trigger). The
   *  consecutive-nudge spacing anchor: a trigger re-fires only once its
   *  effective (backed-off) interval has elapsed since this. */
  lastNudgeAt: number | null;
  /** Trigger that sent the last nudge. While a lapse is pending (nudgedAt
   *  set) ONLY this trigger may re-nudge — consecutive unanswered nudges of
   *  the same trigger widen; the other trigger waits for a fresh lapse. */
  lastNudgeTrigger: "silence" | "status" | null;
  /** Silence-trigger nudges sent this run (backoff counter). Widens the
   *  silence interval on consecutive UNANSWERED lapses; a landed report_status
   *  (compliance), a user prompt, or run end resets it to the base. */
  silenceNudges: number;
  /** Cadence-trigger nudges sent this run (backoff counter). Same discipline
   *  as silenceNudges: widen only on consecutive unanswered lapses. */
  statusNudges: number;
  /** When the recovery interrupt was proposed (ms epoch); null until then.
   *  One recovery per lapse; cleared with the nudge guard on report_status. */
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
   * The daemon-wide central config store (constructed once in bootstrap and
   * shared with naming, resetCommander, and commander-boot). Injected so a
   * patch made here is immediately visible to every consumer — there must be
   * exactly ONE instance. Optional so the service stays constructible in
   * tests without one; when absent the service falls back to its own store.
   */
  centralConfig?: CentralMissionControlConfigStore | null;
  /**
   * Ephemeral verifier dispatcher (VerifierSlice's MissionControlVerifierDispatcher).
   * Optional so the service boots without it; bootstrap wires it.
   */
  verifier?: { start(): void | Promise<void>; stop(): void | Promise<void> } | null;
  /**
   * Archive the current Commander and spawn a fresh one with a new context
   * pack (mission_control.commander.reset). Wired by bootstrap with the full
   * commander-boot machinery; absent → the reset RPC reports an error.
   */
  resetCommander?: () => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  /**
   * Daemon naming service, for the instant theme re-map (spec App "Names":
   * a namingTheme patch re-maps all auto-assigned names immediately and
   * broadcasts agent_update). Optional so the service stays constructible in
   * tests without it; bootstrap wires it.
   */
  naming?: AgentNamingService | null;
}

export interface MissionControlServiceConfig {
  retentionDays: number;
  /** Stall v2 thresholds, seconds mid-run. Central-config driven. */
  stall: {
    silenceNudgeSeconds: number;
    statusNudgeSeconds: number;
    escalateSeconds: number;
  };
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
  private readonly naming: AgentNamingService | null;
  private readonly resetCommanderFn: MissionControlServiceOptions["resetCommander"];
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
  /** First observation of a dead-runtime running record (periodic scan). */
  private readonly recordDeadSince = new Map<string, number>();
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
    this.naming = options.naming ?? null;
    this.resetCommanderFn = options.resetCommander;
    this.bootedAtMs = Date.now();
    this.store = new MissionControlStore({ paseoHome: options.paseoHome, logger: this.logger });
    this.centralConfig =
      options.centralConfig ??
      new CentralMissionControlConfigStore({
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
        // User always outranks: never dispatch machinery to an agent whose
        // last run was user-stopped — the steer would restart a run the user
        // explicitly stopped. Checked here, immediately before dispatch, so a
        // stop landing after proposal creation still wins.
        if (this.store.getStopOrigin(input.agentId) === "user") {
          throw new ProposalDeliveryAborted(input.agentId, "user_stopped");
        }
        // Same delivery semantics as fleet_send_prompt: busy omp turns are
        // live-steered out-of-band (/steer, instant, non-cancelling); idle
        // agents run normally; busy providers without a steer path queue
        // until idle. Stall nudges always target mid-run agents, so a busy
        // target must never fail the delivery.
        //
        // Ack retraction must fire on EVERY machinery dispatch path: when the
        // target is the Commander, arm the shared ack-drop tracker so a pure
        // "ok" reply from the delivered turn is retracted like a digest reply.
        // The tracker's arm is one-shot (cleared on the first turn_started)
        // and expires if the dispatch starts no turn (out-of-band steer), so
        // a user-prompted turn is never classified.
        const ackDrop = this.digest?.ackDrop ?? null;
        const commanderTarget = ackDrop !== null && (await this.isCommanderAgentId(input.agentId));
        if (commanderTarget) {
          ackDrop?.arm();
        }
        try {
          await dispatchLocalPromptMode({
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            agentId: input.agentId,
            prompt: input.message,
            mode: input.deliveryMode,
            logger: this.logger,
          });
        } catch (error) {
          if (commanderTarget) {
            ackDrop?.disarm();
          }
          throw error;
        }
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
    // Boot adoption of surviving runs (spec "Stall detection v2 + watchdog" →
    // "Boot adoption of surviving runs"): records still `running` whose
    // provider runtime is ALIVE are adopted into stall tracking immediately —
    // a run that predates this daemon process never produced a
    // lifecycle→running transition to arm on. Dead-runtime records just arm
    // the reconcile 2-min heal window. The sweep re-runs this every 30s
    // (idempotent), so the first post-restart-grace sweep backstops it.
    void this.reconcileRunningRecords(Date.now()).catch((error: unknown) => {
      this.logger.error(
        { err: error, component: "stall", bootAdoption: true },
        "Boot adoption scan failed",
      );
    });
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

  /** True when the given agent id is the Commander (live or stored). */
  private async isCommanderAgentId(agentId: string): Promise<boolean> {
    const live = this.agentManager.getAgent(agentId);
    if (live?.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE) {
      return true;
    }
    const record = await this.agentStorage.get(agentId);
    return record?.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE;
  }

  /**
   * mission_control.commander.reset: archive the current Commander (the old
   * conversation stays in History) and spawn a fresh one with a new context
   * pack, reusing the drift-recreate machinery (commander-boot).
   */
  async resetCommander(): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
    if (!this.resetCommanderFn) {
      return { ok: false, error: "Commander reset is not available on this host" };
    }
    return this.resetCommanderFn();
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
    const previousTheme = this.centralConfig.get().namingTheme;
    const resolved = await this.centralConfig.patch(patch);
    // Instant theme re-map (spec App "Names"): a namingTheme patch re-maps
    // all auto-assigned agent names to the new pool and broadcasts
    // agent_update for every renamed agent. Re-map failures must never fail
    // the config patch itself — the theme is already persisted.
    if (patch.namingTheme !== undefined && resolved.namingTheme !== previousTheme && this.naming) {
      try {
        await this.naming.remapAllNames();
      } catch (error) {
        this.logger.error({ err: error }, "mission_control.naming.remap_failed");
      }
    }
    return resolved;
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

  getStopOrigin(agentId: string): "user" | "machinery" | "system" | null {
    return this.store.getStopOrigin(agentId);
  }

  recordStopOrigin(agentId: string, origin: "user" | "machinery" | "system" | null): void {
    this.store.recordStopOrigin(agentId, origin);
    // A user stop outranks machinery: pending proposals for this agent are
    // dead — approving them later would restart a run the user stopped.
    if (origin === "user") {
      void this.approvals.expirePendingForAgent(agentId);
    }
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
    const { kind, severity, reportKind } = mapReportStatus(input);
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
      // Keep the original report_status kind on the card so the app can icon
      // progress vs milestone vs finding vs fix vs decision distinctly even
      // though the feed collapses them onto the milestone/finding card kinds.
      ...(reportKind !== undefined ? { reportKind } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.proofs && input.proofs.length > 0 ? { proof: input.proofs } : {}),
    });
    // A landed report_status resets BOTH nudge timers (silence + cadence) and
    // clears the outstanding-nudge guard + escalation lapse. Timeline
    // activity deliberately only resets the silence timer.
    const tracking = this.stallTracking.get(agentId);
    if (tracking) {
      tracking.lastStatusAt = Date.now();
      tracking.lastStreamAt = Date.now();
      tracking.nudgedAt = null;
      tracking.lastNudgeAt = null;
      tracking.lastNudgeTrigger = null;
      tracking.escalatedAt = null;
      // Compliance breaks the consecutive-unanswered streak: backoff widens
      // only on unanswered nudges, so a report_status returns both triggers
      // to their configured base intervals.
      tracking.silenceNudges = 0;
      tracking.statusNudges = 0;
    }
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
        // A new run invalidates the previous run's stop origin: the origin
        // describes who stopped the agent's LAST run ("user" would otherwise
        // stick to an agent that later ran and finished on its own).
        this.store.recordStopOrigin(agent.id, null);
        this.stallTracking.set(agent.id, {
          lastStreamAt: Date.now(),
          lastStatusAt: Date.now(),
          nudgedAt: null,
          lastNudgeAt: null,
          lastNudgeTrigger: null,
          silenceNudges: 0,
          statusNudges: 0,
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
      // Any timeline activity resets the silence-trigger clock (and counts as
      // a response to a nudge for escalation) but does NOT reset the
      // cadence-trigger clock or the outstanding-nudge guard: only a
      // report_status landing does that. A user prompt resets the nudge
      // backoff counters.
      tracking.lastStreamAt = Date.now();
      if (event.type === "timeline" && event.item.type === "user_message") {
        tracking.silenceNudges = 0;
        tracking.statusNudges = 0;
      }
      this.stalledByAgent.delete(agentId);
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
   * Stall v2 (two nudge triggers + recovery):
   * - Eligibility: running agents only (stallTracking is deleted when a run
   *   leaves "running"); user-stopped agents are never nudged or recovered.
   * - Silence trigger: NO timeline output at all for silenceNudgeSeconds.
   * - Cadence trigger: no report_status for statusNudgeSeconds even with
   *   timeline flowing. Whichever fires first sends the SAME status-ask
   *   steer (forceSend, no approval in either mode), recorded auto-sent,
   *   verbose-only card. report_status resets both timers AND both backoff
   *   counters; timeline resets only the silence timer.
   * - Consecutive-lapse backoff: a trigger re-fires on the next lapse spaced
   *   by its effective interval — unanswered nudges widen it (2x, 4x …,
   *   capped at 30min) so a genuinely-silent run is nagged ever less often;
   *   a landed report_status (compliance) returns both triggers to their
   *   configured base interval. At most one nudge per sweep.
   * - Escalation = recovery: if, >escalateSeconds after ANY nudge, the agent
   *   produced NO response at all (no report_status AND no new timeline
   *   rows), propose an interrupt that starts a fresh run. Approval-gated
   *   normally (ask: Needs-you card; auto: sends; presence/user-stop force
   *   ask). A stalled event is emitted either way.
   */
  private sweepStalled(): void {
    if (this.inRestartGrace()) {
      return;
    }
    const now = Date.now();
    const { silenceNudgeSeconds, statusNudgeSeconds, escalateSeconds } = this.readConfig().stall;
    const escalateMs = escalateSeconds * 1000;
    for (const [agentId, tracking] of this.stallTracking) {
      if (this.stalledByAgent.has(agentId)) {
        continue;
      }
      // Healed runs are dead (record -> error); never nudged or escalated.
      if (tracking.healed) {
        continue;
      }
      // User-stopped runs are Done; never ask or recover them.
      if (this.store.getStopOrigin(agentId) === "user") {
        continue;
      }
      // One nudge per sweep. While a lapse is pending (nudgedAt set) only the
      // trigger that started it may re-nudge — consecutive UNANSWERED nudges
      // of the same trigger widen its effective interval (2x, 4x … capped at
      // 30min), so a genuinely-silent run is nudged ever less often; a landed
      // report_status clears the anchors and resets the counters, so a
      // compliant agent is nudged again at the configured base interval.
      this.maybeFireNudge(agentId, tracking, now, silenceNudgeSeconds, statusNudgeSeconds);
      const respondedAfterNudge =
        tracking.nudgedAt !== null &&
        (tracking.lastStatusAt > tracking.nudgedAt || tracking.lastStreamAt > tracking.nudgedAt);
      if (
        tracking.nudgedAt !== null &&
        tracking.escalatedAt === null &&
        !respondedAfterNudge &&
        now - tracking.nudgedAt >= escalateMs
      ) {
        this.escalateStall(agentId, tracking, escalateSeconds);
      }
    }
  }

  /**
   * Decide and fire at most one nudge for a tracked agent (or none). Called
   * once per sweep per agent. While a lapse is pending only the trigger that
   * started it may re-nudge; a re-nudge fires only once its effective
   * (backed-off) interval has elapsed since the last nudge — consecutive
   * unanswered lapses widen (2x, 4x …, capped at 30min); compliance (a
   * report_status clears the anchors + counters) returns to the base interval.
   */
  private maybeFireNudge(
    agentId: string,
    tracking: StallTracking,
    now: number,
    silenceNudgeSeconds: number,
    statusNudgeSeconds: number,
  ): void {
    const silenceDue =
      now - tracking.lastStreamAt >= nudgeBackoffMs(silenceNudgeSeconds, tracking.silenceNudges);
    const statusDue =
      now - tracking.lastStatusAt >= nudgeBackoffMs(statusNudgeSeconds, tracking.statusNudges);
    const lapseOwner = tracking.nudgedAt === null ? null : tracking.lastNudgeTrigger;
    const silenceEligible = lapseOwner === null || lapseOwner === "silence";
    const statusEligible = lapseOwner === null || lapseOwner === "status";
    if ((silenceDue && silenceEligible) || (statusDue && statusEligible)) {
      const lastNudgeAge =
        tracking.lastNudgeAt === null ? Number.POSITIVE_INFINITY : now - tracking.lastNudgeAt;
      if (
        silenceDue &&
        silenceEligible &&
        lastNudgeAge >= nudgeBackoffMs(silenceNudgeSeconds, tracking.silenceNudges)
      ) {
        this.fireStallNudge(agentId, tracking, silenceNudgeSeconds, "silence");
      } else if (
        statusDue &&
        statusEligible &&
        lastNudgeAge >= nudgeBackoffMs(statusNudgeSeconds, tracking.statusNudges)
      ) {
        this.fireStallNudge(agentId, tracking, statusNudgeSeconds, "status");
      }
    }
  }

  /** Status-ask steer, sent directly; recorded as an auto-sent proposal. */
  private fireStallNudge(
    agentId: string,
    tracking: StallTracking,
    nudgeSeconds: number,
    trigger: "silence" | "status",
  ): void {
    tracking.lastNudgeAt = Date.now();
    tracking.lastNudgeTrigger = trigger;
    if (tracking.nudgedAt === null) {
      // Escalation anchor: the FIRST nudge of the lapse. Re-nudges within the
      // lapse (consecutive unanswered, widened spacing) do not restart the
      // escalation window.
      tracking.nudgedAt = Date.now();
    }
    if (trigger === "silence") {
      tracking.silenceNudges += 1;
    } else {
      tracking.statusNudges += 1;
    }
    const reason =
      trigger === "silence"
        ? `No timeline output for >${nudgeSeconds}s mid-run`
        : `No report_status for >${nudgeSeconds}s mid-run`;
    this.logger.warn(
      {
        component: "stall",
        agentId,
        trigger,
        triggerSeconds: nudgeSeconds,
        nudgeCount: trigger === "silence" ? tracking.silenceNudges : tracking.statusNudges,
      },
      "Stall nudge sent (status-ask steer)",
    );
    void this.approvals
      .createProposal({
        origin: "stall",
        serverId: this.serverId,
        targetAgentId: agentId,
        message:
          "You've been quiet for a while. Post a one-line report_status summarizing where you are, then continue.",
        deliveryMode: "steer",
        reason,
        classification: "normal",
        forceSend: true,
        // Nudges are machinery, not user-facing: the status-ask steer card
        // renders in verbose mode only (spec "Stall detection v2 + watchdog"
        // → "Nudges are machinery"). The audit trail (auto-sent proposal +
        // log) is kept; the app hides the card in the normal feed.
        verboseOnly: true,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, component: "stall", agentId },
          "Failed to create stall nudge proposal",
        );
      });
  }

  /**
   * Recovery: the nudged agent gave no response at all for escalateSeconds.
   * An interrupt starts a fresh run (also recovering a dead provider
   * process); the stalled event is emitted regardless of gate outcome.
   */
  private escalateStall(agentId: string, tracking: StallTracking, escalateSeconds: number): void {
    tracking.escalatedAt = Date.now();
    const minutes = Math.round(escalateSeconds / 60);
    void this.emitEvent({
      agentId,
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: `Stalled (no response for ${minutes} min)`,
    });
    this.fireRecoveryProposal(
      agentId,
      `No response for >${escalateSeconds}s after the status-ask nudge`,
    );
    this.logger.warn(
      { component: "stall", agentId, escalateSeconds },
      "Stall escalated; recovery proposal created",
    );
  }

  /**
   * Interrupt-and-send recovery proposal through the approval gate: Ask mode
   * sits as a card; Auto mode sends; presence/user-stop force ask. One per
   * call — callers guarantee per-heal/per-lapse once semantics.
   */
  private fireRecoveryProposal(agentId: string, reason: string): void {
    void this.approvals
      .createProposal({
        origin: "stall",
        serverId: this.serverId,
        targetAgentId: agentId,
        message: "Continue whatever you were working on and post a one-line report_status.",
        deliveryMode: "interrupt",
        reason,
        classification: "normal",
      })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, component: "stall", agentId },
          "Failed to create stall recovery proposal",
        );
      });
  }

  /**
   * Reconciliation watchdog: a record stuck `running` whose provider runtime
   * is dead for >2min self-heals — record -> error, origin "system", stalled
   * event, recovery proposal, loud log. Two layers: live tracked agents whose
   * runtime reports dead (or whose live agent vanished), plus a periodic
   * record scan that backstops orphans whose live agent is gone/closed with
   * no agent_state transition — the running-daemon analogue of boot
   * reconciliation (a killed provider process must never leave a record stuck
   * "running").
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
      // Runtime-dead: the manager no longer has the agent (a killed provider
      // can drop it without an agent_state transition) or the session itself
      // reports the runtime gone.
      const runtimeDead =
        live === null ||
        (live.lifecycle !== "closed" && live.session?.isRuntimeAlive?.() === false);
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
    await this.reconcileRunningRecords(now);
  }

  /**
   * Boot pass over stored records still `running`:
   * - Runtime ALIVE → boot adoption of a surviving run (spec "Boot adoption
   *   of surviving runs"): the run predates this daemon process, so no
   *   lifecycle→running transition armed the stall tracker; adopt it into
   *   tracking seeded from the record's lastActivityAt so both nudge triggers
   *   are armed. A live runtime is neither healed nor ignored.
   * - Runtime DEAD → abrupt kill (daemon restart while the record was
   *   mid-run): arm the 2-min heal window, then self-heal to `error`.
   * Idempotent — tracked records skip, healed records flip to `error` and
   * never match again.
   */
  private async reconcileRunningRecords(now: number): Promise<void> {
    const records = await this.agentStorage.list();
    let adopted = 0;
    for (const record of records) {
      if (record.lastStatus !== "running") {
        this.recordDeadSince.delete(record.id);
        continue;
      }
      // Live tracked agents are owned by the tracked loop above.
      if (this.stallTracking.has(record.id) || this.isExcludedAgent(null, record.id)) {
        this.recordDeadSince.delete(record.id);
        continue;
      }
      const live = this.agentManager.getAgent(record.id);
      const hasLiveRuntime =
        live !== null && live.lifecycle !== "closed" && live.session?.isRuntimeAlive?.() !== false;
      if (hasLiveRuntime) {
        this.recordDeadSince.delete(record.id);
        this.adoptSurvivingRun(record);
        adopted += 1;
        continue;
      }
      if (this.recordDeadSince.get(record.id) === undefined) {
        this.recordDeadSince.set(record.id, now);
        continue;
      }
      if (now - (this.recordDeadSince.get(record.id) ?? now) < WATCHDOG_DEAD_RUNTIME_MS) {
        continue;
      }
      try {
        await this.selfHealDeadRuntime(record.id);
      } catch (error) {
        this.logger.error(
          {
            err: error,
            component: "stall",
            watchdogHeal: true,
            reconcile: true,
            agentId: record.id,
          },
          "Running-record reconciliation self-heal failed",
        );
        continue;
      }
      this.recordDeadSince.delete(record.id);
      this.logger.warn(
        { component: "stall", watchdogHeal: true, reconcile: true, agentId: record.id },
        "Running-record reconciliation healed an interrupted run (record -> error, origin system)",
      );
    }
    if (adopted > 0) {
      this.logger.info(
        { component: "stall", count: adopted },
        "Boot adoption: adopted surviving running runs into stall tracking",
      );
    }
  }

  /**
   * Adopt one surviving pre-restart run into stall tracking. The stall
   * tracker only arms on a lifecycle→running transition, so a run that
   * predates the daemon process is invisible to it forever (no nudge, no
   * escalation). Seeding both nudge timers from the record's lastActivityAt
   * arms the silence and cadence triggers from the run's real last activity.
   * No card is emitted — the run predates this daemon, and the tracker is
   * bookkeeping for sweep decisions only.
   */
  private adoptSurvivingRun(record: { id: string; lastActivityAt?: string | null }): void {
    const parsed = record.lastActivityAt ? Date.parse(record.lastActivityAt) : NaN;
    const seededAt = Number.isFinite(parsed) ? parsed : Date.now();
    this.stallTracking.set(record.id, {
      lastStreamAt: seededAt,
      lastStatusAt: seededAt,
      nudgedAt: null,
      lastNudgeAt: null,
      lastNudgeTrigger: null,
      silenceNudges: 0,
      statusNudges: 0,
      escalatedAt: null,
      deadSince: null,
      healed: false,
    });
    this.logger.info(
      {
        component: "stall",
        agentId: record.id,
        lastActivityAt: record.lastActivityAt ?? null,
        seededAt: new Date(seededAt).toISOString(),
      },
      "Boot adoption: adopted a surviving running run into stall tracking",
    );
  }

  /**
   * Self-heal one dead-runtime run: record -> error, stop origin "system"
   * (abrupt kill — distinct from user-stopped and from a run that failed on
   * its own error), stalled event, recovery proposal (interrupt-and-send).
   */
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
    this.store.recordStopOrigin(agentId, "system");
    await this.emitEvent({
      agentId,
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: "Provider runtime died; run record self-healed to error",
    });
    this.fireRecoveryProposal(agentId, "Provider runtime died; run interrupted");
    this.logger.error(
      {
        component: "stall",
        watchdogHeal: true,
        agentId,
        recordStatus: record.lastStatus,
      },
      "Watchdog self-healed dead provider runtime (record -> error, origin system, recovery proposed)",
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
        // Machinery-only cards (stall status-ask nudges) render in verbose
        // mode only; everything else is a normal-mode card. Absent → normal.
        ...(proposal.verboseOnly ? { verboseOnly: true } : {}),
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
        silenceNudgeSeconds: central.silenceNudgeSeconds,
        statusNudgeSeconds: central.statusNudgeSeconds,
        escalateSeconds: central.escalateSeconds,
      },
    };
  }
}

type MissionControlCentralConfigPatch = Parameters<CentralMissionControlConfigStore["patch"]>[0];

function mapReportStatus(input: MissionControlReportStatusInput): {
  kind: MissionControlAppendInput["kind"];
  severity: MissionControlAppendInput["severity"];
  reportKind?: MissionControlReportStatusInput["kind"];
} {
  switch (input.status) {
    case "blocked":
      return { kind: "blocked", severity: "blocker", reportKind: input.kind };
    case "completed":
      return { kind: "finished", severity: "info", reportKind: input.kind };
    case "inconclusive":
      return { kind: "diverged", severity: "attention", reportKind: input.kind };
    case "working":
      switch (input.kind) {
        case "finding":
        case "fix":
        case "decision":
          return { kind: "finding", severity: "info", reportKind: input.kind };
        case "progress":
        case "milestone":
        case undefined:
          return { kind: "milestone", severity: "info", reportKind: input.kind };
      }
  }
}

function hasExclusionLabels(labels: Record<string, string>): boolean {
  if (Object.keys(labels).some((key) => key.startsWith(MISSION_CONTROL_LABEL_PREFIX))) {
    return true;
  }
  return PARENT_AGENT_ID_LABEL in labels;
}
