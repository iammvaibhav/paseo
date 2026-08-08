import type { Logger } from "pino";
import type {
  AgentLifecycleStatus,
  AgentManager,
  AgentManagerEvent,
  ManagedAgent,
} from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
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
import {
  COMMANDER_ADOPTED_AT_LABEL,
  MISSION_CONTROL_LABEL_KEY,
  MISSION_CONTROL_LABEL_VALUE,
} from "./commander-contract.js";
import type { MissionControlPresenceSource } from "./presence.js";
import {
  CentralMissionControlConfigStore,
  type ResolvedMissionControlCentralConfig,
} from "./config.js";
import type { AgentNamingService } from "./naming.js";
import { TurnLifecycleLog } from "./turn-lifecycle-log.js";

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
 * Honest-steer-delivery verification window: after an out-of-band steer
 * (`tryRunOutOfBand` reported handled), the agent must produce timeline
 * activity within this window or the proposal is marked undelivered and the
 * recovery interrupt is proposed. Measured nudge→response latency: healthy
 * agents 5–90s (median 76s over n=2); the wedged agent's own pathological
 * tail starts at 173s. 90s separates a working loop from a wedged one without
 * ever flagging a healthy one.
 */
const STEER_DELIVERY_VERIFY_MS = 90_000;
/**
 * Commander watchdog: the Commander is excluded from stall nudges/escalation
 * by design, so a Commander looping on a failing tool looks frozen forever.
 * After this many consecutive failed calls of the SAME tool in one turn, with
 * validation/not-configured class errors, a single Needs-you card is emitted.
 * Card only — the Commander is never nudged or interrupted.
 */
const COMMANDER_TOOL_LOOP_THRESHOLD = 3;

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

/** Best-effort text of a tool-call failure, for the Commander watchdog. */
function toolCallErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * The provider-rejection classes the Commander watchdog watches for: spawn
 * schema-validation failures ("provider must be provider/model, for example
 * codex/gpt-5.4") and "Provider X is not configured" runtime rejections. These
 * are the errors a looping Commander produces when it cannot find an
 * invocable provider string.
 */
function isProviderRejectionError(message: string): boolean {
  return (
    /not configured/i.test(message) ||
    /provider must be provider\/model/i.test(message) ||
    /provider must be <provider>\/<model>/i.test(message)
  );
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
  /** When this run started (lifecycle → running, or boot adoption seed). */
  runStartedAt: number;
  /** When the current turn started (turn_started stream event); null pre-first-turn. */
  lastTurnStartedAt: number | null;
  /** Dormant-turn detector: the recovery interrupt was already proposed for
   *  this run (once per run — a wedged loop must not re-card every sweep).
   *  Cleared with the nudge guard on report_status (a landed self-report
   *  proves the loop advanced) and reset on a new run. */
  dormantRecoveredAt: number | null;
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
   * approveVerifierSpawn continues a spawn-kind verifier proposal once the
   * user approves it (or auto mode sends it).
   */
  verifier?: {
    start(): void | Promise<void>;
    stop(): void | Promise<void>;
    approveVerifierSpawn?: (
      proposal: MissionControlProposal,
    ) => Promise<{ ok: true; agentId?: string } | { ok: false; error: string }>;
    deliverReplyToVerifier?: (proposal: MissionControlProposal) => Promise<void>;
  } | null;
  /**
   * Execute a commander-origin spawn-kind proposal (create_agent /
   * fleet_create_agent called by the Commander): reconstruct the create from
   * the proposal's spawnPlan and spawn. Wired by bootstrap where the create
   * command + fleet client resolution live; absent → spawn proposals resolve
   * with an error (never bounce back to pending).
   */
  spawnFromProposal?: (
    proposal: MissionControlProposal,
  ) => Promise<{ ok: true; agentId?: string } | { ok: false; error: string }>;
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
    /** Dormant-turn detector: no output AND no tool in flight for this long
     *  → the turn is treated as wedged and recovered via the interrupt path. */
    dormantTurnSeconds: number;
  };
}

/**
 * The agent's identity AFTER a report_status landed, echoed in the tool result
 * ONLY when it drifted from what the agent just sent (changed externally: a
 * backfill, the user, another surface, or a silently failed identity write).
 * Absent sides mean "the agent's own values are current — nothing to correct";
 * present sides carry the stored value (null when the record holds none).
 */
export interface SelfReportIdentity {
  title: string | null;
  description: string | null;
}

export type SelfReportResult =
  | { ok: true; event: MissionControlEvent; identity: Partial<SelfReportIdentity> }
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
  private readonly spawnFromProposal: MissionControlServiceOptions["spawnFromProposal"];
  readonly approvals: MissionControlApprovals;

  private readonly timelineRows = new Map<string, AgentTimelineRow[]>();
  /**
   * When the agent's CURRENT (most recent) run started (ms epoch). Unlike
   * stallTracking.runStartedAt this survives run end, so the finished-
   * attention handler can bound "at least one report_status in this run"
   * when deciding ready-for-review under evaluationScope "all". Seeded at
   * the lifecycle→running transition and at boot adoption.
   */
  private readonly runStartedAtByAgent = new Map<string, number>();
  private readonly lifecycleByAgent = new Map<string, AgentLifecycleStatus>();
  private readonly attentionKeyByAgent = new Map<string, string>();
  private readonly blockedByAgent = new Set<string>();
  private readonly stalledByAgent = new Set<string>();
  private readonly stallTracking = new Map<string, StallTracking>();
  private readonly excludedAgentIds = new Set<string>();
  /** Commander tool-loop watchdog state, keyed by agentId (see COMMANDER_TOOL_LOOP_THRESHOLD). */
  private readonly commanderToolLoops = new Map<
    string,
    { toolName: string; consecutive: number; lastError: string; cardSent: boolean }
  >();
  private readonly reviewStateListeners = new Set<ReviewStateListener>();
  private readonly selfReportListeners = new Set<(event: MissionControlEvent) => void>();
  /** First observation of a dead-runtime running record (periodic scan). */
  private readonly recordDeadSince = new Map<string, number>();
  /**
   * In-flight tool calls per agent (callIds of tool_call timeline items with
   * status "running" not yet closed by completed/failed/canceled). This is
   * the server-side mirror of omp's tool_execution_start/end rows: a
   * NON-EMPTY set means the agent is inside a declared tool call (e.g. a
   * 30-minute `hub wait`) and is WORKING, never dormant. The dormant-turn
   * detector only fires when this set is EMPTY — "no unmatched in-flight tool
   * call" is the distinguishing signal.
   */
  private readonly inFlightToolsByAgent = new Map<string, Set<string>>();
  /** When each in-flight tool call started (agentId → callId → ms epoch), for ages. */
  private readonly toolStartedAtByAgent = new Map<string, Map<string, number>>();
  /**
   * Last non-machinery stream event per agent (any agent, tracked or not).
   * Independent of stallTracking so steer-delivery verification and the
   * dormant detector read honest activity even across a run boundary.
   */
  private readonly lastActivityAtByAgent = new Map<string, number>();
  /**
   * Honest-steer-delivery verification: out-of-band steers whose handled
   * dispatch must be confirmed by real agent activity within the window.
   * Keyed by agentId; one pending verification per agent (newer replaces).
   * The 90s clock ONLY starts when no tool call is in flight — a steer
   * queued behind a legitimately long non-interruptible tool (a 5-minute
   * build) is correctly pending, never evidence of stranding (see
   * deferredSteerVerifications).
   */
  private readonly steerVerifications = new Map<
    string,
    { proposalId: string; armedAt: number; deadline: number }
  >();
  /**
   * Steers that arrived while a tool call was in flight: the verification
   * clock is suspended until the in-flight tool set empties (trackTurnLifecycle
   * promotes the entry into steerVerifications at tool termination). Without
   * this, a steer queued behind a long tool would false-positive "undelivered"
   * and the recovery interrupt would destroy the healthy in-flight tool call.
   */
  private readonly deferredSteerVerifications = new Map<
    string,
    { proposalId: string; armedAt: number }
  >();
  /**
   * Time of the agent's last report_status call. Preserved across run
   * replacements and restarts (only reportSelfStatus updates it).
   */
  private readonly lastStatusAtByAgent = new Map<string, number>();
  /** Active running subagent ids per parent agent. */
  private readonly runningSubagentsByAgent = new Map<string, Set<string>>();
  /** Agents whose finished attention arrived while subagents were still running. */
  private readonly deferredFinishByAgent = new Set<string>();
  /** Retained turn-step lifecycle record (bounded rotation, see class doc). */
  private readonly lifecycleLog: TurnLifecycleLog;
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
    this.spawnFromProposal = options.spawnFromProposal;
    this.bootedAtMs = Date.now();
    this.store = new MissionControlStore({ paseoHome: options.paseoHome, logger: this.logger });
    this.lifecycleLog = new TurnLifecycleLog({
      paseoHome: options.paseoHome,
      logger: this.logger,
    });
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
        // Worker→verifier reply relay: a verifier-origin proposal targeting
        // the verifier itself must be run by the dispatcher (runVerifierTurn)
        // so its turn-end tracking stays armed — the generic dispatch below
        // cannot attach the dispatcher's completion handler.
        if (
          input.proposal &&
          input.proposal.origin === "verifier" &&
          input.proposal.verifierAgentId &&
          input.proposal.verifierAgentId === input.agentId &&
          this.verifier?.deliverReplyToVerifier
        ) {
          await this.verifier.deliverReplyToVerifier(input.proposal);
          return;
        }
        // User always outranks: never dispatch machinery to an agent whose
        // last run was user-stopped — the steer would restart a run the user
        // explicitly stopped. Checked here, immediately before dispatch, so a
        // stop landing after proposal creation still wins.
        if (this.store.getStopOrigin(input.agentId) === "user") {
          throw new ProposalDeliveryAborted(input.agentId, "user_stopped");
        }
        // Same delivery semantics as fleet_send_prompt: busy omp turns are
        // live-steered out-of-band (/steer, instant, non-cancelling); idle
        // agents run normally. A busy provider WITHOUT a native steer path is
        // interrupted (replaceRunning) — a steer's value is timely delivery,
        // and queue-until-idle can sit for tens of minutes. "queue" mode
        // waits for idle instead. Stall nudges always target mid-run agents,
        // so a busy target must never fail the delivery.
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
            classification: input.classification,
            // Proposal delivery (escalation recovery, verifier contact,
            // commander steer) superseding a busy run is machinery-originated:
            // the superseded run keeps the failure treatment.
            replaceOrigin: "machinery",
            recordStopOrigin: (agentId, origin) => this.store.recordStopOrigin(agentId, origin),
            logger: this.logger,
            // Honest steer delivery: a handled out-of-band steer must be
            // confirmed by real agent activity within the verification window.
            // tryRunOutOfBand returning true means the prompt was handed to
            // the provider runtime — but the wedged-omp incident showed that
            // can be a lie: the steer vanished into a parked loop while Paseo
            // recorded "sent". Arm the verification so a silent agent flips
            // the proposal to undelivered and escalates instead.
            onOutOfBandSteer: () => {
              this.armSteerDeliveryVerification(input.agentId, input.proposal);
            },
          });
          // Commander adoption: a delivered commander-origin send marks the
          // target as Commander-owned (verifier scope "commander" audits it).
          // Fires only after the dispatch actually succeeded — a denied,
          // aborted (user-stopped), or failed delivery never adopts. Stall
          // nudges and verifier contacts (origins "stall"/"verifier") are
          // machinery, not Commander take-overs; spawn-kind proposals never
          // reach the deliver hook. Idempotent: first adoption wins.
          if (input.proposal?.origin === "commander") {
            await this.recordCommanderAdoption(input.agentId);
          }
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
      // Single spawn execution path for spawn-kind proposals (approve or auto
      // mode): verifier spawns continue in the dispatcher; Commander spawns
      // reconstruct from the proposal's spawnPlan (bootstrap-wired).
      spawn: async (proposal) => {
        if (proposal.origin === "verifier") {
          if (!this.verifier?.approveVerifierSpawn) {
            return { ok: false, error: "Verifier dispatcher is not available" };
          }
          return this.verifier.approveVerifierSpawn(proposal);
        }
        if (!this.spawnFromProposal) {
          return { ok: false, error: "Spawn executor is not available" };
        }
        return this.spawnFromProposal(proposal);
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
   * Commander adoption: a delivered commander-origin send (fleet_send_prompt)
   * marks the target as Commander-owned so verifier scope "commander" audits
   * it. The marker is the ISO timestamp of the FIRST adoption — the moment
   * the Commander took over — and repeated sends never rewrite it (first
   * adoption wins, idempotent). Mission-control machinery (Commander,
   * verifier) is never adopted; an agent that is not live cannot be adopted.
   * Returns the effective adoption timestamp, or null when nothing was
   * recorded.
   */
  async recordCommanderAdoption(agentId: string): Promise<string | null> {
    const live = this.agentManager.getAgent(agentId);
    if (!live) {
      this.logger.debug({ agentId }, "mission_control.commander_adopt_skipped_not_live");
      return null;
    }
    if (hasMissionControlLabels(live.labels)) {
      this.logger.debug(
        { agentId, labels: live.labels },
        "mission_control.commander_adopt_skipped_machinery",
      );
      return null;
    }
    const existing = live.labels[COMMANDER_ADOPTED_AT_LABEL];
    if (typeof existing === "string" && existing.trim().length > 0) {
      return existing;
    }
    const adoptedAt = new Date().toISOString();
    try {
      await this.agentManager.setLabels(agentId, { [COMMANDER_ADOPTED_AT_LABEL]: adoptedAt });
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "mission_control.commander_adopt_failed");
      return null;
    }
    this.logger.info({ agentId, adoptedAt }, "mission_control.commander_adopted");
    return adoptedAt;
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
      // A landed self-report proves the turn loop advanced: the dormant-turn
      // recovery latch clears (a fresh dormancy gets a fresh recovery).
      tracking.dormantRecoveredAt = null;
      // Compliance breaks the consecutive-unanswered streak: backoff widens
      // only on unanswered nudges, so a report_status returns both triggers
      // to their configured base intervals.
      tracking.silenceNudges = 0;
      tracking.statusNudges = 0;
    }
    this.lastStatusAtByAgent.set(agentId, Date.now());
    this.store.updateObservation(agentId, { lastSelfReportTs: event.ts });
    if (input.title !== undefined || input.description !== undefined) {
      await this.applyIdentityUpdate(agentId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    }
    // Echo the agent's identity in the tool result ONLY when it drifted from
    // what the agent just sent — someone else changed it (backfill, the user,
    // another surface) or the write silently failed. The echo exists to
    // correct external drift, not to restate what the agent just told us.
    const identity = await this.readSelfReportIdentity(agentId, input);
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
    return { ok: true, event, identity };
  }

  /**
   * The agent's stored identity, echoed ONLY on sides that drifted from what
   * the agent just sent. The echo exists to correct external drift (a
   * backfill, the user, another surface) or a silently failed identity write —
   * not to restate values the agent just set itself. Sides the agent did not
   * send are never echoed (the agent made no claim about them). A stored side
   * that is null while the agent sent a value is drift too (the write did not
   * stick) and echoes as null.
   */
  private async readSelfReportIdentity(
    agentId: string,
    input: MissionControlReportStatusInput,
  ): Promise<Partial<SelfReportIdentity>> {
    let record: Pick<StoredAgentRecord, "title" | "shortDescription"> | null = null;
    try {
      record = await this.agentStorage.get(agentId);
    } catch {
      record = null;
    }
    const drift: Partial<SelfReportIdentity> = {};
    if (input.title !== undefined && (record?.title?.trim() ?? null) !== input.title.trim()) {
      drift.title = record?.title ?? null;
    }
    if (
      input.description !== undefined &&
      (record?.shortDescription?.trim() ?? null) !== input.description.trim()
    ) {
      drift.description = record?.shortDescription ?? null;
    }
    return drift;
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
      return;
    }
    if (event.type === "provider_subagent") {
      this.handleProviderSubagentEvent(event);
    }
  }

  private handleAgentState(agent: ManagedAgent): void {
    if (agent.lifecycle !== "running") {
      // A run boundary (idle, closed, archived) invalidates any in-turn
      // Commander tool-loop streak.
      this.commanderToolLoops.delete(agent.id);
    }
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
        // A new run means any in-flight tool state from the previous run is
        // stale (a wedged/interrupted run may never have closed its tools).
        this.inFlightToolsByAgent.delete(agent.id);
        this.toolStartedAtByAgent.delete(agent.id);
        this.steerVerifications.delete(agent.id);
        this.deferredSteerVerifications.delete(agent.id);
        const runStartedAt = Date.now();
        // Bounds "this run" for the ready-for-review predicate (scope "all"):
        // kept past run end because stallTracking is torn down at the run
        // boundary BEFORE the finished-attention handler consults it.
        this.runStartedAtByAgent.set(agent.id, runStartedAt);
        const lastStatusAt = this.lastStatusAtByAgent.get(agent.id) ?? runStartedAt;
        this.lastStatusAtByAgent.set(agent.id, lastStatusAt);
        this.stallTracking.set(agent.id, {
          lastStreamAt: runStartedAt,
          lastStatusAt,
          nudgedAt: null,
          lastNudgeAt: null,
          lastNudgeTrigger: null,
          silenceNudges: 0,
          statusNudges: 0,
          escalatedAt: null,
          deadSince: null,
          healed: false,
          runStartedAt,
          lastTurnStartedAt: null,
          dormantRecoveredAt: null,
        });
        this.logger.info(
          { component: "turn-lifecycle", agentId: agent.id, provider: agent.provider },
          "agent.run.started",
        );
        this.lifecycleLog.write({
          event: "run_started",
          agentId: agent.id,
          provider: agent.provider,
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
      // A replace in progress carries who superseded the in-flight run
      // (AgentRunOptions.replaceOrigin). Record MACHINERY supersedes (so the
      // superseded run keeps the failure treatment). A USER replace records
      // NOTHING: sending new work is NOT stopping the agent — the origin must
      // stay null so the board never shows "Stopped by you" and the superseded
      // run renders silently (the new run's own started card is the story).
      if (agent.pendingReplacementOrigin === "machinery") {
        this.store.recordStopOrigin(agent.id, "machinery");
      }
    } else if (previousLifecycle === "running") {
      this.stallTracking.delete(agent.id);
      this.stalledByAgent.delete(agent.id);
      // Run ended: per-run detector state is stale — tools can no longer be
      // "in flight", and a pending steer verification is moot (the run
      // boundary itself is activity).
      this.inFlightToolsByAgent.delete(agent.id);
      this.toolStartedAtByAgent.delete(agent.id);
      this.steerVerifications.delete(agent.id);
      this.deferredSteerVerifications.delete(agent.id);
      if (agent.lifecycle === "error" && agent.session?.isRuntimeAlive?.() === false) {
        this.runningSubagentsByAgent.delete(agent.id);
        this.deferredFinishByAgent.delete(agent.id);
      }
      this.logger.info(
        { component: "turn-lifecycle", agentId: agent.id, lifecycle: agent.lifecycle },
        "agent.run.ended",
      );
      this.lifecycleLog.write({
        event: "run_ended",
        agentId: agent.id,
        lifecycle: agent.lifecycle,
      });
    }

    if (agent.attention.requiresAttention) {
      const reason = agent.attention.attentionReason;
      if (this.attentionKeyByAgent.get(agent.id) !== reason) {
        this.attentionKeyByAgent.set(agent.id, reason);
        if (reason === "finished") {
          if (this.hasRunningSubagents(agent.id)) {
            this.deferredFinishByAgent.add(agent.id);
            this.logger.info(
              { component: "subagent-gate", agentId: agent.id },
              "agent.finished.deferred_for_subagents",
            );
          } else {
            void this.emitEvent({
              agentId: agent.id,
              kind: "finished",
              source: "system",
              severity: "info",
              headline: "Finished",
            });
            void this.markReadyForReview(agent.id);
          }
        } else if (reason === "error") {
          this.emitRunTerminalErrorCard(agent.id, agent.lastError, agent);
        }
      }
    } else {
      this.attentionKeyByAgent.set(agent.id, "none");
      this.deferredFinishByAgent.delete(agent.id);
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

  /**
   * A finished run moves the agent to ready-for-review (rollout onward).
   * Under evaluationScope "all" a bare run end is NOT an audit trigger: a
   * hand-started conversational session that simply finished a turn has no
   * launch brief and no self-reported status — nothing for a verifier to
   * audit, and verifying it would interrupt healthy work for a guaranteed
   * "insufficient". Only a run with a launch brief AND at least one
   * report_status this run (a dispatched worker that reported progress)
   * earns ready-for-review here; a `status: "completed"` report is the
   * explicit, scope-independent path (reportSelfStatus). Under "commander"
   * scope the verifier's own scope filter decides, so every finished run
   * stays marked ready exactly as before.
   */
  private async markReadyForReview(agentId: string): Promise<void> {
    if (this.store.getRolloutTs() === null) {
      return;
    }
    if (this.centralConfig.get().evaluationScope === "all" && !this.hasAuditableRun(agentId)) {
      return;
    }
    await this.store.setReviewState(agentId, "ready");
    this.notifyReviewState(agentId);
  }

  /**
   * Scope-"all" auditable-run predicate (see markReadyForReview): the agent
   * was DISPATCHED — its timeline holds a launch brief (a non-empty
   * user_message row) — AND it reported status at least once in the current
   * run (a self-sourced mission-control event at/after the run start).
   * Reuses the per-agent timeline buffer and the store's self-report feed
   * (the verifier's own context pack reads the same records), so no new
   * persistence is introduced. A conversational session never satisfies it:
   * without report_status history a finished turn produces no audit.
   */
  private hasAuditableRun(agentId: string): boolean {
    const rows = this.timelineRows.get(agentId) ?? [];
    const hasLaunchBrief = rows.some(
      (row) => row.item.type === "user_message" && row.item.text.trim().length > 0,
    );
    if (!hasLaunchBrief) {
      return false;
    }
    // The run start is always known here: the finished attention arrives via
    // handleAgentState, which recorded the run's lifecycle→running transition
    // (or a boot-adoption seed) before any report could land. Missing means
    // we never observed this run start, so nothing can be proven "this run".
    const runStartedAt = this.runStartedAtByAgent.get(agentId);
    if (runStartedAt === undefined) {
      return false;
    }
    return this.fetchEvents({ includeSuperseded: true }).some(
      (event) =>
        event.agentId === agentId &&
        event.source === "self" &&
        Date.parse(event.ts) >= runStartedAt,
    );
  }

  private handleAgentStream(
    agentId: string,
    event: AgentStreamEvent,
    seq?: number,
    timestamp?: string,
  ): void {
    const now = Date.now();
    if (this.excludedAgentIds.has(agentId) || this.isExcludedAgent(null, agentId)) {
      // Excluded agents (MC-labeled: Commander, verifiers) never reach the
      // stall machinery — so the Commander tool-loop watchdog runs here.
      this.trackCommanderToolLoop(agentId, event);
      // Commander stream events still satisfy a pending steer verification
      // (a steer to the Commander must be verified like any other): record
      // real activity so an out-of-band steer to an excluded agent is never
      // falsely marked undelivered. A tool's own terminal row is NOT steer
      // activity (the tool predates the steer).
      if (!isMachineryRow(event) && !isToolTerminalRow(event)) {
        this.lastActivityAtByAgent.set(agentId, now);
        this.steerVerifications.delete(agentId);
      }
      return;
    }
    const tracking = this.stallTracking.get(agentId);
    // Turn-step bookkeeping: in-flight tool calls (the dormant detector's
    // "working" signal) and the retained lifecycle record.
    this.trackTurnLifecycle(agentId, event, now, tracking);
    const machineryRow = isMachineryRow(event);
    if (!machineryRow && !isToolTerminalRow(event)) {
      // Any real stream event is activity: it satisfies the dormant
      // detector's "no timeline output" signal and any pending steer
      // delivery verification. A tool's own terminal row is deliberately
      // excluded from the steer-verification activity signal: the tool was
      // already in flight when the steer arrived, so its conclusion is not
      // the steer's effect (and counting it would let a steer queued behind
      // a long tool pass as "verified" without ever being processed).
      this.lastActivityAtByAgent.set(agentId, now);
      this.steerVerifications.delete(agentId);
    }
    if (tracking) {
      if (!machineryRow) {
        // Machinery-originated rows (the status-ask nudge's own timeline
        // placeholder) are the tracker's prompts, never agent activity: they
        // must not reset the silence clock, count as a response to a nudge
        // for escalation, or reset the backoff counters. Any other timeline
        // activity resets the silence-trigger clock (and counts as a
        // response to a nudge for escalation) but does NOT reset the
        // cadence-trigger clock or the outstanding-nudge guard: only a
        // report_status landing does that. A user prompt resets the nudge
        // backoff counters.
        tracking.lastStreamAt = now;
        if (event.type === "timeline" && event.item.type === "user_message") {
          tracking.silenceNudges = 0;
          tracking.statusNudges = 0;
        }
        this.stalledByAgent.delete(agentId);
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
      // Same origin gate as handleAgentState's error branch: a turn failed
      // because a USER prompt superseded it renders as an interruption,
      // everything else as the failure card.
      this.emitRunTerminalErrorCard(agentId, event.error);
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
   * Turn-step lifecycle bookkeeping for the managed (non-excluded)
   * population: in-flight tool-call sets (the dormant detector's "working"
   * signal — a non-empty set means the agent is inside a declared tool call
   * and is NEVER flagged) plus the retained lifecycle record and greppable
   * pino lines under component "turn-lifecycle" (module "mission-control").
   *
   * Ages: runAgeMs = time since the run started; turnAgeMs = time since the
   * current turn started; toolDurationMs = the tool call's own duration.
   */
  private trackTurnLifecycle(
    agentId: string,
    event: AgentStreamEvent,
    now: number,
    tracking: StallTracking | undefined,
  ): void {
    const runAgeMs = tracking ? now - tracking.runStartedAt : null;
    if (event.type === "turn_started") {
      if (tracking) {
        tracking.lastTurnStartedAt = now;
      }
      this.logger.info(
        { component: "turn-lifecycle", agentId, turnId: event.turnId, runAgeMs },
        "agent.turn.started",
      );
      this.lifecycleLog.write({
        event: "turn_started",
        agentId,
        turnId: event.turnId,
        runAgeMs,
      });
      return;
    }
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      const turnAgeMs = tracking?.lastTurnStartedAt ? now - tracking.lastTurnStartedAt : null;
      // A turn boundary closes any tool rows the runtime never closed (e.g.
      // an interrupt mid-tool call): the in-flight set is per-turn.
      this.inFlightToolsByAgent.delete(agentId);
      this.toolStartedAtByAgent.delete(agentId);
      this.promoteDeferredSteerVerification(agentId, now);
      this.logger.info(
        { component: "turn-lifecycle", agentId, type: event.type, turnAgeMs, runAgeMs },
        "agent.turn.ended",
      );
      this.lifecycleLog.write({
        event: "turn_ended",
        agentId,
        type: event.type,
        turnAgeMs,
        runAgeMs,
      });
      return;
    }
    if (event.type !== "timeline" || event.item.type !== "tool_call") {
      return;
    }
    this.trackToolCallLifecycle(agentId, event.item, now, runAgeMs);
  }

  /**
   * In-flight tool-call bookkeeping for one tool_call timeline item. A
   * "running" row opens the call (added to the in-flight set — the dormant
   * detector's "working" signal); a completed/failed/canceled row closes it
   * and, when the set empties, starts the clock for any steer delivery
   * verification that was deferred behind this tool (the omp strand happens
   * AFTER the interruptible tool was aborted — nothing in flight, no further
   * rows — which is exactly the state the freshly armed verification watches
   * for).
   */
  private trackToolCallLifecycle(
    agentId: string,
    item: Extract<AgentStreamEvent, { type: "timeline" }>["item"] & { type: "tool_call" },
    now: number,
    runAgeMs: number | null,
  ): void {
    if (item.status === "running") {
      let tools = this.inFlightToolsByAgent.get(agentId);
      if (!tools) {
        tools = new Set();
        this.inFlightToolsByAgent.set(agentId, tools);
      }
      tools.add(item.callId);
      let starts = this.toolStartedAtByAgent.get(agentId);
      if (!starts) {
        starts = new Map();
        this.toolStartedAtByAgent.set(agentId, starts);
      }
      starts.set(item.callId, now);
      this.logger.debug(
        { component: "turn-lifecycle", agentId, callId: item.callId, tool: item.name, runAgeMs },
        "agent.tool.started",
      );
      this.lifecycleLog.write({
        event: "tool_started",
        agentId,
        callId: item.callId,
        tool: item.name,
        runAgeMs,
      });
      return;
    }
    // completed | failed | canceled — closes the unmatched running row.
    this.inFlightToolsByAgent.get(agentId)?.delete(item.callId);
    const startedAt = this.toolStartedAtByAgent.get(agentId)?.get(item.callId) ?? null;
    if (startedAt !== null) {
      this.toolStartedAtByAgent.get(agentId)?.delete(item.callId);
    }
    if ((this.inFlightToolsByAgent.get(agentId)?.size ?? 0) === 0) {
      this.promoteDeferredSteerVerification(agentId, now);
    }
    this.logger.debug(
      {
        component: "turn-lifecycle",
        agentId,
        callId: item.callId,
        tool: item.name,
        status: item.status,
        toolDurationMs: startedAt !== null ? now - startedAt : null,
        runAgeMs,
      },
      "agent.tool.result",
    );
    this.lifecycleLog.write({
      event: "tool_result",
      agentId,
      callId: item.callId,
      tool: item.name,
      status: item.status,
      toolDurationMs: startedAt !== null ? now - startedAt : null,
      runAgeMs,
    });
  }

  /**
   * Commander watchdog (narrow coverage for the otherwise-excluded class):
   * track consecutive failed calls of the SAME tool within one turn whose
   * errors are provider validation/not-configured rejections. At
   * COMMANDER_TOOL_LOOP_THRESHOLD, emit exactly ONE Needs-you card naming the
   * tool and the last error, so a looping Commander surfaces instead of
   * appearing frozen. Card only — the Commander is never nudged or
   * interrupted, and worker stall behavior is untouched (only MC-labeled
   * agents reach this path).
   */
  private trackCommanderToolLoop(agentId: string, event: AgentStreamEvent): void {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || !hasMissionControlLabels(agent.labels)) {
      return;
    }
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      // The streak is per-turn: a turn boundary clears it so a fresh turn can
      // surface again if it loops.
      this.commanderToolLoops.delete(agentId);
      return;
    }
    if (event.type !== "timeline" || event.item.type !== "tool_call") {
      return;
    }
    const item = event.item;
    if (item.status === "completed") {
      // A successful call of the tracked tool breaks the consecutive streak.
      const tracker = this.commanderToolLoops.get(agentId);
      if (tracker && tracker.toolName === item.name) {
        this.commanderToolLoops.delete(agentId);
      }
      return;
    }
    if (item.status !== "failed") {
      return;
    }
    const message = toolCallErrorMessage(item.error);
    if (!isProviderRejectionError(message)) {
      return;
    }
    const previous = this.commanderToolLoops.get(agentId);
    const consecutive = previous && previous.toolName === item.name ? previous.consecutive + 1 : 1;
    const tracker = {
      toolName: item.name,
      consecutive,
      lastError: message,
      // One card per turn: keep the sent flag across streak increments so a
      // turn that keeps failing past the threshold does not re-card.
      cardSent: previous?.toolName === item.name ? previous.cardSent : false,
    };
    this.commanderToolLoops.set(agentId, tracker);
    if (tracker.consecutive >= COMMANDER_TOOL_LOOP_THRESHOLD && !tracker.cardSent) {
      tracker.cardSent = true;
      this.logger.warn(
        { component: "commander-watchdog", agentId, tool: item.name, consecutive, error: message },
        "Commander looping on a failing tool; Needs-you card emitted",
      );
      void this.emitEvent({
        agentId,
        kind: "blocked",
        source: "system",
        severity: "blocker",
        headline: `Commander needs you: "${item.name}" keeps failing`,
        detail: `${item.name} failed ${consecutive} times in a row this turn — last error: ${message.slice(0, 200)}`,
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
    const { silenceNudgeSeconds, statusNudgeSeconds, escalateSeconds, dormantTurnSeconds } =
      this.readConfig().stall;
    const escalateMs = escalateSeconds * 1000;
    const dormantMs = dormantTurnSeconds * 1000;
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
      // One recovery proposal per lapse, shared across mechanisms: the stall
      // escalation and the dormant-turn detector each fire only while the
      // OTHER has not already recovered this lapse (escalatedAt /
      // dormantRecoveredAt — both cleared on a landed report_status and on
      // run end). A wedged loop must never stack recovery cards.
      if (
        tracking.nudgedAt !== null &&
        tracking.escalatedAt === null &&
        tracking.dormantRecoveredAt === null &&
        !respondedAfterNudge &&
        now - tracking.nudgedAt >= escalateMs
      ) {
        this.escalateStall(agentId, tracking, escalateSeconds);
      }
      // Dormant-turn detector (the hard stop): a running agent with NO
      // timeline output for > dormantTurnSeconds AND no tool call in flight
      // has a wedged turn — omp's loop failed to advance (live incident:
      // agent 3a71c7bb sat 26 minutes with an unprocessed user message and
      // NOTHING in flight — no request, no tool — because the loop never
      // stepped after skipping a wait-tool). A DECLARED tool call (an
      // unmatched running tool_call row, e.g. a 30-minute `hub wait`) is
      // WORKING and never flagged: the distinguishing signal is "no
      // unmatched in-flight tool call" (inFlightToolsByAgent empty). A
      // pending permission is in-flight too (the agent is blocked on the
      // user, not wedged).
      if (
        tracking.escalatedAt === null &&
        tracking.dormantRecoveredAt === null &&
        (this.inFlightToolsByAgent.get(agentId)?.size ?? 0) === 0 &&
        !this.blockedByAgent.has(agentId) &&
        now - tracking.lastStreamAt >= dormantMs
      ) {
        this.fireDormantRecovery(agentId, tracking, dormantTurnSeconds);
      }
    }
    // Honest steer delivery: confirm out-of-band steers produced real agent
    // activity within the verification window.
    this.sweepSteerVerifications(now);
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
        // The steer records a machinery-classified row on the agent's own
        // timeline (auditable; rendered as a muted one-line placeholder in
        // verbose mode, never the raw nudge text).
        timelineClassification: "machinery",
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
   * Dormant-turn recovery (the hard stop): a running agent with no timeline
   * output for >dormantTurnSeconds AND no tool call in flight has a wedged
   * turn — omp's loop failed to advance (live incident: agent 3a71c7bb sat
   * 26 minutes with an unprocessed user message and nothing in flight; the
   * turn did not self-heal even when the thing it waited for completed).
   * Force-cancel the wedged turn and start a fresh run via the proven
   * replace-cancel escalation (interrupt delivery). Approval-gated exactly
   * like the stall escalation; the stalled event fires regardless so the
   * feed shows the harness bug instead of a silent paper-over. Logs loudly —
   * this is a last-resort net, not the first line of defense.
   */
  private fireDormantRecovery(
    agentId: string,
    tracking: StallTracking,
    dormantSeconds: number,
  ): void {
    tracking.dormantRecoveredAt = Date.now();
    const minutes = Math.round(dormantSeconds / 60);
    void this.emitEvent({
      agentId,
      kind: "stalled",
      source: "system",
      severity: "attention",
      headline: `Dormant turn (no output, no tool in flight for ${minutes} min)`,
      detail:
        `No timeline output and no tool call in flight for >${dormantSeconds}s mid-run — ` +
        "the turn loop may be wedged; recovery proposed.",
    });
    this.fireRecoveryProposal(
      agentId,
      `No output and no tool in flight for >${dormantSeconds}s — the turn loop appears wedged`,
    );
    this.logger.error(
      {
        component: "dormant-turn",
        agentId,
        dormantSeconds,
        lastStreamAt: new Date(tracking.lastStreamAt).toISOString(),
        runAgeMs: Date.now() - tracking.runStartedAt,
      },
      "Dormant turn detected (no output, no tool in flight); recovery interrupt proposed",
    );
    this.lifecycleLog.write({
      event: "dormant_turn_detected",
      agentId,
      dormantSeconds,
      lastStreamAt: new Date(tracking.lastStreamAt).toISOString(),
      runAgeMs: Date.now() - tracking.runStartedAt,
    });
  }

  /**
   * Honest steer delivery: after a machinery steer reports handled
   * (tryRunOutOfBand accepted it), the agent must actually produce timeline
   * activity within the verification window — the wedged-omp incident showed
   * "handled" can be a lie (three nudges recorded "sent" while the loop was
   * parked and the prompts vanished). One pending verification per agent; a
   * newer steer replaces an older one (its proposal is superseded either
   * way). handleAgentStream clears it on any real activity.
   *
   * Tool-in-flight gating (critical — the whole distinction): the 90s clock
   * starts NOW only when no tool call is in flight. If a tool IS in flight,
   * the steer is queued behind it (correct omp behavior for non-interruptible
   * tools — a 5-minute build is not a wedge), so the verification is DEFERRED
   * and its clock starts when the tool set empties. Only "steer acked + no
   * tool in flight + no activity" is evidence of stranding — exactly the
   * state the omp bug produces (the strand happens after the interruptible
   * tool was ABORTED, so nothing is in flight). Verifying during a live tool
   * would interrupt healthy agents mid-build.
   */
  private armSteerDeliveryVerification(
    agentId: string,
    proposal: MissionControlProposal | undefined,
  ): void {
    if (!proposal) {
      return;
    }
    const armedAt = Date.now();
    if ((this.inFlightToolsByAgent.get(agentId)?.size ?? 0) > 0) {
      this.deferredSteerVerifications.set(agentId, { proposalId: proposal.id, armedAt });
      this.logger.info(
        {
          component: "steer-verify",
          agentId,
          proposalId: proposal.id,
          windowMs: STEER_DELIVERY_VERIFY_MS,
          deferred: true,
        },
        "Out-of-band steer deferred for delivery verification (tool in flight)",
      );
      return;
    }
    this.steerVerifications.set(agentId, {
      proposalId: proposal.id,
      armedAt,
      deadline: armedAt + STEER_DELIVERY_VERIFY_MS,
    });
    this.logger.info(
      {
        component: "steer-verify",
        agentId,
        proposalId: proposal.id,
        windowMs: STEER_DELIVERY_VERIFY_MS,
      },
      "Out-of-band steer armed for delivery verification",
    );
  }

  /**
   * Start the verification clock for a steer that was deferred behind an
   * in-flight tool call, now that the in-flight set is empty. The tool's own
   * terminal row that triggered this is NOT steer activity (it predates the
   * steer), so the fresh window measures the steer's effect alone.
   */
  private promoteDeferredSteerVerification(agentId: string, now: number): void {
    const deferred = this.deferredSteerVerifications.get(agentId);
    if (!deferred) {
      return;
    }
    this.deferredSteerVerifications.delete(agentId);
    this.steerVerifications.set(agentId, {
      proposalId: deferred.proposalId,
      armedAt: now,
      deadline: now + STEER_DELIVERY_VERIFY_MS,
    });
    this.logger.info(
      {
        component: "steer-verify",
        agentId,
        proposalId: deferred.proposalId,
        windowMs: STEER_DELIVERY_VERIFY_MS,
      },
      "Deferred steer verification armed (in-flight tool terminated)",
    );
  }

  /**
   * Verification sweep: an out-of-band steer that produced NO agent activity
   * within the window was never processed. Never leave the proposal recorded
   * "sent" for a message that did not land — mark it undelivered (terminal,
   * auditable) and escalate via the existing recovery interrupt, once per
   * lapse (shared latch with the stall escalation and dormant-turn detector).
   */
  private sweepSteerVerifications(now: number): void {
    for (const [agentId, verification] of this.steerVerifications) {
      if (now < verification.deadline) {
        continue;
      }
      this.steerVerifications.delete(agentId);
      const producedActivity =
        (this.lastActivityAtByAgent.get(agentId) ?? 0) > verification.armedAt;
      if (producedActivity) {
        continue;
      }
      const proposal = this.approvals.getProposal(verification.proposalId);
      this.logger.error(
        {
          component: "steer-verify",
          agentId,
          proposalId: verification.proposalId,
          windowMs: STEER_DELIVERY_VERIFY_MS,
          proposalStatus: proposal?.status ?? null,
        },
        "Out-of-band steer reported handled but the agent produced NO activity; marking undelivered and escalating",
      );
      this.lifecycleLog.write({
        event: "steer_unverified",
        agentId,
        proposalId: verification.proposalId,
        windowMs: STEER_DELIVERY_VERIFY_MS,
      });
      if (proposal && proposal.status === "sent") {
        void this.approvals.markUndelivered(proposal.id).catch((error: unknown) => {
          this.logger.warn(
            { err: error, component: "steer-verify", agentId, proposalId: proposal.id },
            "Failed to mark steer proposal undelivered",
          );
        });
      }
      const tracking = this.stallTracking.get(agentId);
      if (tracking && tracking.escalatedAt === null && tracking.dormantRecoveredAt === null) {
        tracking.dormantRecoveredAt = now;
        void this.emitEvent({
          agentId,
          kind: "stalled",
          source: "system",
          severity: "attention",
          headline: "Steer undelivered (no agent activity after delivery)",
        });
        this.fireRecoveryProposal(
          agentId,
          `A steer was reported handled but produced no agent activity for >${Math.round(
            STEER_DELIVERY_VERIFY_MS / 1000,
          )}s — the turn loop may be wedged`,
        );
      }
    }
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
    // Same survival contract as stallTracking: a run that predates this
    // process must still bound "this run" for the ready-for-review predicate.
    this.runStartedAtByAgent.set(record.id, seededAt);
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
      runStartedAt: seededAt,
      lastTurnStartedAt: null,
      dormantRecoveredAt: null,
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
    this.lastStatusAtByAgent.set(record.id, seededAt);
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

  /**
   * Three-way classification of a run's terminal failure for the feed card:
   * - "silent": the USER REPLACED the run with new work (interrupt-and-send).
   *   The superseded run's abort is machinery noise; the new run's own started
   *   card is the story. Emit NO card.
   * - "interrupted": the USER HARD-STOPPED the agent (stop button / cancel
   *   with no follow-up): origin "user", no replace in progress, abort
   *   signature → "Interrupted by you".
   * - "failed": everything else (genuine errors, provider crashes,
   *   machinery-originated interrupts) → "Failed with an error".
   */
  private classifyRunTerminal(
    agentId: string,
    errorText: string | undefined,
    candidateAgent?: ManagedAgent | null,
  ): "interrupted" | "silent" | "failed" {
    const agent = candidateAgent ?? this.agentManager.getAgent(agentId);
    const isReplace =
      agent?.pendingReplacement === true || (agent?.pendingReplacementOrigin ?? null) !== null;
    const abortSignature = /Interrupted by user|stopReason=aborted/i.test(errorText ?? "");
    if (isReplace && agent?.pendingReplacementOrigin === "user") {
      return "silent";
    }
    if (this.store.getStopOrigin(agentId) === "user" && abortSignature && !isReplace) {
      return "interrupted";
    }
    return "failed";
  }

  /**
   * The feed card for a run that ended in an error state.
   */
  private emitRunTerminalErrorCard(
    agentId: string,
    errorText: string | undefined,
    candidateAgent?: ManagedAgent | null,
  ): void {
    const classification = this.classifyRunTerminal(agentId, errorText, candidateAgent);
    if (classification === "silent") {
      return;
    }
    const interrupted = classification === "interrupted";
    void this.emitEvent({
      agentId,
      kind: interrupted ? "interrupted" : "failed",
      source: "system",
      severity: interrupted ? "info" : "attention",
      headline: interrupted ? "Interrupted by you" : "Failed with an error",
    });
  }
  private handleProviderSubagentEvent(
    event: Extract<AgentManagerEvent, { type: "provider_subagent" }>,
  ): void {
    const managerEvent = event.event;
    if (managerEvent.type === "upsert") {
      const { parentAgentId, id, status } = managerEvent.subagent;
      let set = this.runningSubagentsByAgent.get(parentAgentId);
      if (status === "running") {
        if (!set) {
          set = new Set();
          this.runningSubagentsByAgent.set(parentAgentId, set);
        }
        set.add(id);
      } else {
        set?.delete(id);
        if (set && set.size === 0) {
          this.resolveDeferredFinish(parentAgentId);
        }
      }
    } else if (managerEvent.type === "remove") {
      const set = this.runningSubagentsByAgent.get(managerEvent.parentAgentId);
      set?.delete(managerEvent.subagentId);
      if (set && set.size === 0) {
        this.resolveDeferredFinish(managerEvent.parentAgentId);
      }
    }
  }

  private hasRunningSubagents(agentId: string): boolean {
    return (this.runningSubagentsByAgent.get(agentId)?.size ?? 0) > 0;
  }

  private resolveDeferredFinish(agentId: string): void {
    if (!this.deferredFinishByAgent.delete(agentId)) {
      return;
    }
    const agent = this.agentManager.getAgent(agentId);
    const stillFinished =
      agent !== null &&
      agent.lifecycle === "idle" &&
      agent.attention.requiresAttention &&
      agent.attention.attentionReason === "finished";
    if (!stillFinished) {
      return;
    }
    this.logger.info({ component: "subagent-gate", agentId }, "agent.finished.after_subagents");
    void this.emitEvent({
      agentId,
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    void this.markReadyForReview(agentId);
  }

  private async emitEvent(
    input: Omit<MissionControlAppendInput, "agentTitle">,
    options?: { skipDigest?: boolean },
  ): Promise<MissionControlEvent> {
    const agentTitle = await this.resolveAgentTitle(input.agentId);
    const shortDescription =
      input.shortDescription ?? (await this.resolveAgentShortDescription(input.agentId));
    const event = await this.store.append({
      ...input,
      agentTitle,
      ...(shortDescription ? { shortDescription } : {}),
    });
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
        // Verifier-origin drill-in: the card opens the verifier's thread.
        ...(proposal.verifierAgentId ? { verifierAgentId: proposal.verifierAgentId } : {}),
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
        // Verifier-origin drill-in: the card opens the verifier's thread
        // (verifiers stay hidden from board buckets but are reachable here).
        ...(input.verdict.verifierAgentId
          ? { verifierAgentId: input.verdict.verifierAgentId }
          : {}),
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

  private async resolveAgentShortDescription(agentId: string): Promise<string | undefined> {
    const live = this.agentManager.getAgent(agentId);
    if (live?.shortDescription) {
      return live.shortDescription;
    }
    const record = await this.agentStorage.get(agentId).catch(() => null);
    return record?.shortDescription ?? undefined;
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
        dormantTurnSeconds: central.dormantTurnSeconds,
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

/**
 * A machinery-originated user row (the status-ask nudge's own timeline
 * placeholder) is the tracker's prompt, never agent activity. Used by the
 * stream handler for the silence clock, steer verification, and the dormant
 * detector's "no timeline output" signal alike.
 */
function isMachineryRow(event: AgentStreamEvent): boolean {
  return (
    event.type === "timeline" &&
    event.item.type === "user_message" &&
    event.item.classification === "machinery"
  );
}

/**
 * A tool call's own terminal row (completed/failed/canceled) is the
 * conclusion of a tool that was already in flight — deliberately excluded
 * from the steer-verification activity signal: it predates the steer, so it
 * is not the steer's effect (a steer queued behind a long tool must not pass
 * as "verified" just because that tool eventually finished).
 */
function isToolTerminalRow(event: AgentStreamEvent): boolean {
  return (
    event.type === "timeline" && event.item.type === "tool_call" && event.item.status !== "running"
  );
}

function hasExclusionLabels(labels: Record<string, string>): boolean {
  if (Object.keys(labels).some((key) => key.startsWith(MISSION_CONTROL_LABEL_PREFIX))) {
    return true;
  }
  return PARENT_AGENT_ID_LABEL in labels;
}
