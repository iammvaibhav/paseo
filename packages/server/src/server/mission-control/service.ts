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
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import { archiveAgentCommand } from "../agent/lifecycle-command.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type {
  WorkspaceRegistry,
  ProjectRegistry,
  PersistedWorkspaceRecord,
} from "../workspace-registry.js";
import type { SessionOutboundMessage } from "../messages.js";
import type {
  MissionControlEvent,
  MissionControlLifecycleAction,
  MissionControlMetaPlan,
  MissionControlReportStatusInput,
} from "@getpaseo/protocol/mission-control/types";
import type { PeerManager } from "../peers/peer-manager.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { MISSION_CONTROL_LABEL_PREFIX } from "@getpaseo/protocol/mission-control/system-owned";
import { getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import { deriveLifecycleBucket, type LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import { hasMissionControlLabels } from "./naming.js";
import {
  MissionControlStore,
  type MissionControlAppendInput,
  type MissionControlFetchOptions,
  type MissionControlObservation,
  type MissionControlReviewStateRecord,
  type MissionControlVerdict,
} from "./store.js";
import type { MissionControlEventKind } from "@getpaseo/protocol/mission-control/types";
import {
  CentralMissionControlConfigStore,
  type ResolvedMissionControlCentralConfig,
} from "./config.js";
import { TurnLifecycleLog } from "./turn-lifecycle-log.js";
import {
  assembleRunRecord,
  isFinalizableRunRecord,
  type MissionControlRunPlacement,
  type MissionControlRunRecord,
} from "./run-records.js";
import {
  RollupCache,
  deriveProjectRollup,
  deriveWorkspaceRollup,
  type ProjectRollup,
  type WorkspaceRollup,
} from "./rollups.js";

const STALL_SWEEP_INTERVAL_MS = 30_000;
const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESTART_GRACE_MS = 60_000;
// Watchdog: record still says running but the provider runtime is dead for
// this long before self-healing the record to error.
const WATCHDOG_DEAD_RUNTIME_MS = 2 * 60_000;
/** Tier-3 fallback description cap (mirrors the ~400-char self-report rule). */
const AUTO_DERIVED_DESCRIPTION_CHARS = 400;
const TIMELINE_BUFFER_CAP = 2000;
const SELF_REPORT_RATE_LIMIT_MS = 60_000;
const ENDING_REPORT_KINDS: ReadonlySet<MissionControlEventKind> = new Set([
  "finished",
  "blocked",
  "diverged",
]);
/** Event kinds that finalize a run record (run end or a verdict landing). */
const RUN_RECORD_FINALIZING_KINDS: Record<MissionControlEventKind, boolean> = {
  started: false,
  finished: true,
  failed: true,
  blocked: false,
  stalled: false,
  milestone: false,
  finding: false,
  diverged: false,
  proposal: false,
  verdict: true,
  interrupted: true,
  clarification: false,
  answer: false,
};
/**
 * The run-end event kinds (spec 06 terminal-state guarantee): finished,
 * error (failed), and machinery interrupt. "interrupted" with a USER stop
 * origin is excluded by the guarantee at apply time.
 */
function isTerminalEventKind(kind: MissionControlEventKind): boolean {
  return kind === "finished" || kind === "failed" || kind === "interrupted";
}

// ============================================================================
// fleet_monitor (spec 03): session-scoped watch shapes + the announce-policy
// matching. The policy (proposal/clarification always; blocked/error/finished
// for monitored scope; started/milestones/verdicts never; mid-run milestones
// parked P3) is pinned here so the daemon registry and the voice node apply
// the same table.
// ============================================================================

/** Running-turn info carried by fleet_agent_status (spec 03). */
export interface AgentStatusRunningTurn {
  lifecycle: string;
  activeTurnId: string | null;
  activeTurnStartedAt: string | null;
  modeId: string | null;
  pendingPermissionCount: number;
}

/** The agent's last self-sourced report_status (headline/detail/ts). */
export interface AgentStatusLastReport {
  headline: string;
  detail: string | null;
  ts: string;
  reportKind: string | null;
}

/** One-agent status record for fleet_agent_status (spec 03). */
export interface AgentStatusRecord {
  agentId: string;
  name: string | null;
  title: string | null;
  description: string | null;
  bucket: LifecycleBucket;
  lastStatus: string | null;
  running: AgentStatusRunningTurn | null;
  lastReport: AgentStatusLastReport | null;
  workspaceId: string | null;
}

interface StallTracking {
  /** Last timeline activity (any stream event). The dormant-turn detector's
   *  "no output" clock. */
  lastStreamAt: number;
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
   *  Cleared on a landed report_status (a self-report proves the loop
   *  advanced) and reset on a new run. */
  dormantRecoveredAt: number | null;
}

export interface MissionControlServiceOptions {
  paseoHome: string;
  /** A finalized run record, for fleet-memory (queued; never blocks assembly). */
  onRunRecordFinalized?: (record: MissionControlRunRecord) => void;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  serverId: string;
  hostName: string;
  /**
   * Peer manager for central-config routing: forwarding patches to the
   * designated commander host and pushing replicas to peers. Resolved lazily
   * (the peer manager is constructed after the service in bootstrap), so a
   * function returning it is accepted too.
   */
  peerManager?: (() => PeerManager | null) | PeerManager | null;
  broadcast: (message: SessionOutboundMessage) => void;
  /**
   * The daemon-wide central config store (constructed once in bootstrap and
   * shared with naming, resetCommander, and commander-boot). Injected so a
   * patch made here is immediately visible to every consumer — there must be
   * exactly ONE instance. Optional so the service stays constructible in
   * tests without one; when absent the service falls back to its own store.
   */
  centralConfig?: CentralMissionControlConfigStore | null;
  /**
   * Apply a meta plan with no proposal at all, routed to the host its
   * serverId names. Used by remote MCP clients (/mcp/fleet), which are never
   * gated: no card, no proposal row, destructive actions included.
   */
  metaApplyDirect?: (
    metaPlan: MissionControlMetaPlan,
  ) => Promise<{ ok: true; metaAppliedOnHost?: string } | { ok: false; error: string }>;
  /**
   * Apply a meta plan against THIS daemon's registries, reached over peering:
   * the commander-host metaFromProposal routes an approved meta-kind proposal
   * whose metaPlan.serverId names this host as a peer here
   * (mission_control.meta.apply → fleetMetaApply). The receiving daemon
   * re-validates the plan against its own registries and applies it (only the
   * APPLY hops; the proposal card stays on the commander host). Wired by
   * bootstrap with the same meta-actions deps as metaFromProposal; absent →
   * the meta apply RPC reports an error.
   */
  metaApplyRemote?: (
    metaPlan: MissionControlMetaPlan,
  ) => Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  /**
   * M6 run records: resolve the workspace/project attribution frozen into a
   * run record at assembly time (host registry lookups live in bootstrap).
   * Absent → records carry no workspace/project attribution (rollups then
   * only group by what the daemon resolved).
   */
  resolveRunPlacement?: (input: {
    agentId: string;
    workspaceId?: string | null;
    cwd?: string | null;
  }) => Promise<MissionControlRunPlacement>;
  /**
   * F2: a reviewState change re-buckets the agent (spec 01 precedence) but
   * produces no agent lifecycle mutation, so connected clients would hold a
   * stale bucket until the next fetch. Live agents re-emit state through the
   * manager (the same broadcast path lifecycle changes use); a closed/stored
   * agent has no live state, and the daemon-level fan-out to every session's
   * agent_update stream lives in bootstrap (this hook). Absent → the stored
   * push is skipped (tests without the hook keep their current behavior).
   */
  onReviewStateChanged?: (agentId: string) => void;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list" | "update" | "upsert"> | null;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list"> | null;
  onWorkspaceUpdated?: (workspaceId: string) => Promise<void> | void;
  archiveWorkspace?: ((workspaceId: string, requestId: string) => Promise<unknown>) | null;
}

export interface MissionControlServiceConfig {
  retentionDays: number;
  /** Stall v2 thresholds, seconds mid-run. Central-config driven. */
  stall: {
    /** Master switch: false skips silence/status nudges AND escalation;
     *  dormant-turn recovery still runs as hard-wedge protection. */
    enabled: boolean;
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
  | {
      ok: true;
      event: MissionControlEvent;
      identity: Partial<SelfReportIdentity>;
      /** Additive guidance: frozen title notice, missing-description nag. */
      notice?: string;
    }
  | { ok: false; reason: "excluded" | "rate_limited"; message: string };

/**
 * A prompt a person sent an agent directly. `forwarded` marks the copy a peer
 * receives so its MCP clients hear about the turn; only the agent's own host
 * comments on the ticket and forwards.
 */
export interface UserPrompt {
  agentId: string;
  turnId: string | null;
  text: string;
  forwarded?: boolean;
}

/** The peer-executable name a host uses to tell its peers a user turn started on one of its agents. */
export const USER_TURN_PEER_TOOL = "paseo.user_turn";

export type ReviewStateListener = (
  agentId: string,
  record: MissionControlReviewStateRecord,
) => void;

// ==========================================================================
// fleet_recall: primary + secondary bank merge and omp session-id
// attribution. Pure helpers (unit-testable without a service instance);
// MissionControlService.hindsightRecall wires them together.
// ==========================================================================

export class MissionControlService {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly serverId: string;
  private readonly hostName: string;
  private readonly peerManagerOption: MissionControlServiceOptions["peerManager"];
  private readonly broadcast: (message: SessionOutboundMessage) => void;
  private readonly centralConfig: CentralMissionControlConfigStore;
  private readonly metaApplyDirect: MissionControlServiceOptions["metaApplyDirect"];
  private readonly metaApplyRemote: MissionControlServiceOptions["metaApplyRemote"];
  private readonly resolveRunPlacement: MissionControlServiceOptions["resolveRunPlacement"];
  private readonly onReviewStateChanged: MissionControlServiceOptions["onReviewStateChanged"];
  // M6 context architecture: run-record assembly, rollup cache, hindsight sink.
  private readonly rollupCache = new RollupCache();
  private readonly onRunRecordFinalized: ((record: MissionControlRunRecord) => void) | undefined;

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
  private readonly reviewStateListeners = new Set<ReviewStateListener>();
  private readonly selfReportListeners = new Set<(event: MissionControlEvent) => void>();
  private readonly userPromptListeners = new Set<(prompt: UserPrompt) => void>();
  /** Every emitted feed event, any kind/source — a general fan-out parallel to
   * selfReportListeners (which is scoped to source:"self"). Used by callers that need
   * to observe the Commander's own cards (e.g. the itsaplan chat-runner correlating an
   * emitCommanderCard "answer"/"clarification"/"proposal" back to the instruction id it
   * delivered — see itsaplan/chat-runner.ts). */
  private readonly eventListeners = new Set<(event: MissionControlEvent) => void>();
  private readonly workspaceRegistry: Pick<
    WorkspaceRegistry,
    "get" | "list" | "update" | "upsert"
  > | null;
  private readonly onWorkspaceUpdated?: ((workspaceId: string) => Promise<void> | void) | null;
  private readonly projectRegistry: Pick<ProjectRegistry, "get" | "list"> | null;
  private readonly archiveWorkspace:
    | ((workspaceId: string, requestId: string) => Promise<unknown>)
    | null;
  private readonly autoArchivingWorkspaces = new Set<string>();
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
   * Terminal-state guarantee (spec 06): agents whose run just ended with
   * zero self-sourced reports and already received the one status-ask steer
   * for this finish chain. While marked, the NEXT silent terminal
   * transition applies the deterministic description fallback instead of
   * steering again — the steer is never repeated and never time-based.
   * Cleared when a self-report lands, when the user stops the run, or when
   * the fallback applies.
   */
  private readonly terminalAskPending = new Set<string>();
  /**
   * Per-run finished-event dedupe (spec 01 change 1): the manager's
   * onAgentFinished fires on every clean running→idle transition; the key
   * (agentId + run start) keeps the finished event + markReadyForReview to
   * exactly one emission per run. Keyed by run start, so entries are
   * implicitly bounded and never need clearing.
   */
  private readonly cleanFinishedRuns = new Set<string>();
  /**
   * Per-run user-stop terminal-event dedupe (F1): a user-origin cancel of a
   * running turn emits exactly ONE "interrupted" event per run epoch —
   * either the running→non-running lifecycle hop in handleAgentState or the
   * turn_failed error-card path (whichever lands first). Keyed by run start,
   * so entries are implicitly bounded and never need clearing (same
   * convention as cleanFinishedRuns).
   */
  private readonly userStopTerminalEvents = new Set<string>();
  /**
   * Per-run system-abort resume dedupe: a provider-killed turn
   * ("Request was aborted (stopReason=aborted, …)" with no user stop)
   * proposes exactly ONE resume per run epoch — the turn_failed stream path
   * and the error-attention state path both funnel through
   * emitRunTerminalErrorCard, so without this the same abort cards twice.
   * Keyed by run start like userStopTerminalEvents; a fresh run re-arms.
   */
  private readonly systemAbortRecoveryByRun = new Set<string>();
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
    this.daemonConfigStore = options.daemonConfigStore;
    this.serverId = options.serverId;
    this.hostName = options.hostName;
    this.peerManagerOption = options.peerManager ?? null;
    this.broadcast = options.broadcast;
    this.metaApplyDirect = options.metaApplyDirect;
    this.metaApplyRemote = options.metaApplyRemote;
    this.resolveRunPlacement = options.resolveRunPlacement;
    this.onReviewStateChanged = options.onReviewStateChanged;
    this.workspaceRegistry = options.workspaceRegistry ?? null;
    this.onWorkspaceUpdated = options.onWorkspaceUpdated ?? null;
    this.projectRegistry = options.projectRegistry ?? null;
    this.archiveWorkspace = options.archiveWorkspace ?? null;
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
    this.onRunRecordFinalized = options.onRunRecordFinalized;
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
    }, STALL_SWEEP_INTERVAL_MS);
    this.pruneTimer = setInterval(() => {
      void this.store.prune(this.readConfig().retentionDays).catch((error) => {
        this.logger.warn({ err: error }, "Failed to prune mission control events");
      });
      // Spec 01 ready aging: same daily cadence as the prune sweep.
      this.sweepReadyAging(Date.now());
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
    if (state === "done" && options?.verdict?.summary !== "aged-out") {
      await this.maybeAutoArchiveWorkspaceOnAgentDone(agentId);
    }
  }

  /**
   * Spec 01 ready aging: reviewState "ready" rows whose updatedAt is older
   * than readyAgeOutDays (central config) age to done with the "aged-out"
   * verdict (board chip; state-only verdict card). Runs on the daily prune
   * cadence; never touches agents. readyAgeOutDays <= 0 disables aging, and
   * that is the default — a host only ages rows out if it opts in. Note the
   * stored value wins over the default, so a host that persisted a non-zero
   * value before the default changed keeps aging until its config is updated.
   */
  sweepReadyAging(now = Date.now()): void {
    const readyAgeOutDays = this.centralConfig.get().readyAgeOutDays;
    if (!Number.isFinite(readyAgeOutDays) || readyAgeOutDays <= 0) {
      return;
    }
    const cutoffMs = now - readyAgeOutDays * 24 * 60 * 60 * 1000;
    for (const [agentId, record] of this.store.getReviewStates()) {
      if (record.reviewState !== "ready") {
        continue;
      }
      const updatedAt = record.updatedAt ? Date.parse(record.updatedAt) : Number.NaN;
      if (!Number.isFinite(updatedAt) || updatedAt >= cutoffMs) {
        continue;
      }
      void this.setReviewState(agentId, "done", {
        verdict: { by: "user", summary: "aged-out", at: new Date(now).toISOString() },
      });
    }
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
   * lifecycle. agentIds applies the same action to every listed agent in
   * one call (Clear all / Mark all done); agentId is always included.
   */
  async setLifecycle(input: {
    agentId: string;
    agentIds?: string[];
    action: MissionControlLifecycleAction;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of [input.agentId, ...(input.agentIds ?? [])]) {
      if (id.length === 0 || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    const results = await Promise.all(
      ids.map((agentId) => this.applyLifecycleAction(agentId, input.action)),
    );
    const firstError = results.find((result) => !result.ok);
    return firstError ?? { ok: true };
  }

  private async applyLifecycleAction(
    agentId: string,
    action: MissionControlLifecycleAction,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const agent = await this.agentStorage.get(agentId);
    if (!agent) {
      return this.forwardLifecycleActionToPeer(agentId, action);
    }
    const now = new Date().toISOString();
    switch (action) {
      case "done": {
        const verdict: MissionControlVerdict = { by: "user", summary: "Marked done", at: now };
        await this.setReviewState(agentId, "done", { verdict });
        return { ok: true };
      }
      case "clear": {
        // Archive first. Writing cleared before a failed archive would drop
        // the row off the board while the agent stayed live (an orphan).
        try {
          await archiveAgentCommand(
            {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              logger: this.logger,
            },
            agentId,
          );
        } catch (error) {
          return {
            ok: false,
            error: getErrorMessageOr(error, `Failed to archive agent ${agentId}`),
          };
        }
        await this.store.setReviewState(agentId, "cleared");
        await this.emitVerdictEvent({
          agentId,
          verdict: { by: "user", summary: "Cleared", at: now },
        });
        this.notifyReviewState(agentId);
        return { ok: true };
      }
      case "reopen": {
        await this.store.setReviewState(agentId, "none");
        this.notifyReviewState(agentId);
        return { ok: true };
      }
    }
  }

  private async forwardLifecycleActionToPeer(
    agentId: string,
    action: MissionControlLifecycleAction,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const peerManager = this.resolvePeerManager();
    if (!peerManager) {
      return { ok: false, error: `Agent ${agentId} not found anywhere in the fleet` };
    }

    const peerStatuses = peerManager.getPeerStatuses() ?? [];
    if (peerStatuses.length === 0) {
      return { ok: false, error: `Agent ${agentId} not found anywhere in the fleet` };
    }

    let foundPeerName: string | null = null;
    const unreachablePeers: string[] = [];

    for (const status of peerStatuses) {
      if (status.state !== "online") {
        unreachablePeers.push(status.name);
        continue;
      }
      const client = peerManager.getPeerClient(status.name);
      if (!client) {
        unreachablePeers.push(status.name);
        continue;
      }
      try {
        const roster = await client.fetchAgents({
          filter: { includeArchived: true },
          page: { limit: 200 },
        });
        if (roster.entries.some((entry) => entry.agent?.id === agentId)) {
          foundPeerName = status.name;
          break;
        }
      } catch (error) {
        this.logger.warn(
          { err: error, peer: status.name, agentId },
          "mission_control.lifecycle.peer_agent_lookup_failed",
        );
        unreachablePeers.push(status.name);
      }
    }

    if (foundPeerName) {
      const client = peerManager.getPeerClient(foundPeerName);
      const peerServerId = peerManager.getPeerServerId(foundPeerName);
      if (!client || !peerServerId) {
        return { ok: false, error: `Peer "${foundPeerName}" is unreachable` };
      }
      try {
        const payload = await client.missionControlLifecycleSet({
          serverId: peerServerId,
          agentId,
          action,
        });
        return payload.ok
          ? { ok: true }
          : {
              ok: false,
              error: payload.error ?? `Peer "${foundPeerName}" rejected lifecycle action`,
            };
      } catch (error) {
        return {
          ok: false,
          error: `Peer "${foundPeerName}" unreachable: ${getErrorMessageOr(error, "round-trip failed")}`,
        };
      }
    }

    if (unreachablePeers.length > 0) {
      return {
        ok: false,
        error: `Agent ${agentId} not found locally, and peer(s) unreachable: ${unreachablePeers.join(", ")}`,
      };
    }

    return { ok: false, error: `Agent ${agentId} not found anywhere in the fleet` };
  }

  /**
   * Apply a meta plan against THIS daemon's registries, reached over peering
   * (mission_control.meta.apply — the commander host forwards an approved
   * meta-kind proposal whose metaPlan.serverId names this host as a peer).
   * The plan is re-validated against this host's live registries before
   * applying. Absent wiring → an error result (never a throw).
   */
  async applyMetaRemote(
    metaPlan: MissionControlMetaPlan,
  ): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
    if (!this.metaApplyRemote) {
      return { ok: false, error: "Meta executor is not available on this host" };
    }
    return this.metaApplyRemote(metaPlan);
  }

  /** Ungated meta apply for remote MCP clients: no proposal is recorded. */
  async applyMetaPlanDirect(
    metaPlan: MissionControlMetaPlan,
  ): Promise<{ ok: true; metaAppliedOnHost?: string } | { ok: false; error: string }> {
    if (!this.metaApplyDirect) {
      return { ok: false, error: "Meta executor is not available" };
    }
    return this.metaApplyDirect(metaPlan);
  }

  // ==========================================================================
  // v3 central config + mode
  // ==========================================================================

  private resolvePeerManager(): PeerManager | null {
    const option = this.peerManagerOption;
    return typeof option === "function" ? option() : (option ?? null);
  }

  getCentralConfig(): ResolvedMissionControlCentralConfig {
    return this.centralConfig.get();
  }

  async patchCentralConfig(
    patch: MissionControlCentralConfigPatch,
  ): Promise<ResolvedMissionControlCentralConfig> {
    // Names are write-once: a namingTheme patch affects only future
    // assignments (the theme is read fresh at assign time) and never
    // re-maps existing names, so there is nothing to do beyond persisting
    // the patch.
    return this.centralConfig.patch(patch);
  }

  // v3 user-message tagging (Commander records relatedAgentIds)
  // ==========================================================================

  // ==========================================================================
  // v3 stop origins + dormant derivation
  // ==========================================================================

  getStopOrigin(agentId: string): "user" | "machinery" | "system" | null {
    return this.store.getStopOrigin(agentId);
  }

  recordStopOrigin(agentId: string, origin: "user" | "machinery" | "system" | null): void {
    this.store.recordStopOrigin(agentId, origin);
    if (origin === "user") {
      // A user stop also clears any leftover "ready": a stopped run must read
      // as Done ("Stopped by you"), never as Ready awaiting review (a stale
      // ready would otherwise beat the user-stop derivation).
      void this.store.setReviewState(agentId, "none");
      this.notifyReviewState(agentId);
    }
  }

  isDormant(agentId: string): boolean {
    return this.store.isDormant(agentId);
  }

  dormantAgentIds(): string[] {
    return this.store.dormantAgentIds();
  }

  // ==========================================================================
  // M6 context architecture: run records + rollups (docs/commander.md
  // "Context architecture"). Records are assembled deterministically at run
  // end / ready-for-review; rollups derive from them and cache in memory.
  // ==========================================================================

  /** All retained run records, newest run first. */
  getRunRecords(): MissionControlRunRecord[] {
    return this.store.getRunRecords();
  }

  /** The most recent run record for an agent (null when it has none). */
  getLatestRunRecord(agentId: string): MissionControlRunRecord | null {
    return this.store.getLatestRunRecord(agentId);
  }

  /** The most recent run records for an agent, newest first (cap limit). */
  getAgentRunRecords(agentId: string, limit = 5): MissionControlRunRecord[] {
    return this.store
      .getRunRecords()
      .filter((record) => record.agentId === agentId)
      .slice(0, limit);
  }

  /** Workspace rollup (cached; recomputed when a new run record lands). */
  getWorkspaceRollup(workspaceId: string): WorkspaceRollup | null {
    return this.rollupCache.getWorkspace(workspaceId, () =>
      deriveWorkspaceRollup(this.store.getRunRecords(), workspaceId),
    );
  }

  /** Project rollup (cached; recomputed when a new run record lands). */
  getProjectRollup(projectId: string, commanderInstructions?: string | null): ProjectRollup | null {
    return this.rollupCache.getProject(projectId, () =>
      deriveProjectRollup(this.store.getRunRecords(), projectId, undefined, commanderInstructions),
    );
  }

  // ==========================================================================
  // M13 fleet_monitor subscriptions (spec 03): session-scoped watches over
  // mission_control_event. The registry is the subscription plumbing —
  // fleet-wide and any number of per-agent watches coexist per session,
  // independent start/stop, status lists. Announcements themselves ride the
  // existing mission_control_event broadcast: the voice node holds the
  // session's monitored set (synced from this registry) and applies the
  // announce policy (proposal/clarification always; blocked/error/finished
  // for monitored scope) as a passive listener — zero polling.
  // ==========================================================================

  /**
   * Canonical lifecycle bucket (spec 01) for one agent, computed from stored
   * state via the shared deriveLifecycleBucket — the same function the roster
   * and fleet_list_agents rows use (BucketCore). Never a client event fold.
   */
  async getLifecycleBucket(agentId: string): Promise<LifecycleBucket> {
    const record = await this.agentStorage.get(agentId);
    const live = this.agentManager.getAgent(agentId);
    const attentionReason =
      live?.attention?.requiresAttention === true
        ? live.attention.attentionReason
        : (record?.attentionReason ?? null);
    const reviewState = this.store.getReviewState(agentId).reviewState;
    return deriveLifecycleBucket({
      pendingPermissionCount: live ? live.pendingPermissions.size : 0,
      pendingProposalCount: 0,
      attentionReason: attentionReason ?? null,
      // The live lifecycle outranks the stored record: a live running agent
      // must read as running even when the disk record still says error (or
      // vice versa once the run has ended).
      lastStatus: live ? live.lifecycle : (record?.lastStatus ?? null),
      running: live?.lifecycle === "running" || live?.lifecycle === "initializing",
      reviewState,
      stopOrigin: this.store.getStopOrigin(agentId),
    });
  }

  /**
   * One-agent status record for fleet_agent_status: identity, lifecycle
   * bucket, last lifecycle status, running-turn info, and the last
   * self-sourced report_status. The tool resolves host/projectId via the
   * fleet index + workspace registry (not owned by this service).
   */
  async getAgentStatusRecord(agentId: string): Promise<AgentStatusRecord> {
    const [record, live, bucket] = await Promise.all([
      this.agentStorage.get(agentId),
      Promise.resolve(this.agentManager.getAgent(agentId)),
      this.getLifecycleBucket(agentId),
    ]);
    const lastReport = this.lastSelfReportEvent(agentId);
    return {
      agentId,
      ...this.resolveStatusIdentity(record, live),
      bucket,
      lastStatus: record?.lastStatus ?? null,
      running: this.buildStatusRunningInfo(live),
      lastReport: this.buildStatusLastReport(lastReport),
    };
  }

  /** The identity fields of a status record, resolved live-first (the live
   * agent's current state outranks the stored record). */
  private resolveStatusIdentity(
    record: StoredAgentRecord | null,
    live: ManagedAgent | null,
  ): Pick<AgentStatusRecord, "name" | "title" | "description" | "workspaceId"> {
    return {
      name: record?.name ?? live?.name ?? null,
      title: record?.title ?? live?.config?.title ?? null,
      description: record?.shortDescription ?? live?.shortDescription ?? null,
      workspaceId: record?.workspaceId ?? live?.workspaceId ?? null,
    };
  }

  /** Running-turn info from the live agent (null when not running). */
  private buildStatusRunningInfo(live: ManagedAgent | null): AgentStatusRunningTurn | null {
    if (!live) {
      return null;
    }
    return {
      lifecycle: live.lifecycle,
      activeTurnId: live.activeTurnId,
      activeTurnStartedAt: live.activeTurnStartedAt ? live.activeTurnStartedAt.toISOString() : null,
      modeId: live.currentModeId,
      pendingPermissionCount: live.pendingPermissions.size,
    };
  }

  /** The last self-report as the status record's report section (null when
   * the agent has never self-reported). */
  private buildStatusLastReport(
    lastReport: MissionControlEvent | null,
  ): AgentStatusLastReport | null {
    if (!lastReport) {
      return null;
    }
    return {
      headline: lastReport.headline,
      detail: lastReport.detail ?? null,
      ts: lastReport.ts,
      reportKind: lastReport.reportKind ?? null,
    };
  }

  /**
   * The status-ask steer for fleet_agent_status fresh:true (the only
   * mid-run status mechanism; fires only on explicit request). Shares the
   * canonical status-ask envelope with the terminal-state guarantee
   * (createStatusAskProposal). Machinery envelope: user-invisible card
   * (verboseOnly), machinery timeline row, and the <paseo-system> wrap the
   * timeline renderer hides. forceSend: a status-ask never sits pending for
   * approval.
   */
  async requestFreshStatusSteer(
    agentId: string,
    options?: { notify?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const live = this.agentManager.getAgent(agentId);
      let isOmp = live ? live.provider === "omp" : false;
      if (!live) {
        const stored = await this.agentStorage.get(agentId).catch(() => null);
        if (stored) isOmp = stored.provider === "omp";
      }
      const deliveryMode: "steer" | "queue" = options?.notify && !isOmp ? "queue" : "steer";
      const steerPromise = this.createStatusAskProposal(
        agentId,
        "fleet_agent_status fresh:true — explicit status request",
        "Status request: post a one-line report_status describing where you are right now, then continue whatever you were working on.",
        deliveryMode,
      );
      if (options?.notify && deliveryMode === "queue") {
        steerPromise.catch((error: unknown) => {
          this.logger.warn(
            { err: error, component: "monitor", agentId },
            "mission_control.fresh_status_queued_steer_failed",
          );
        });
      } else {
        await steerPromise;
      }
      return { ok: true };
    } catch (error) {
      this.logger.warn(
        { err: error, component: "monitor", agentId },
        "mission_control.fresh_status_steer_failed",
      );
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Deliver a machinery prompt (status ask, stall recovery, abort resume) to a
   * local agent. A user stop always wins: an agent whose last run the user
   * stopped is never restarted by machinery. Busy agents are live-steered
   * ("steer"), interrupted ("interrupt"), or waited on ("queue").
   */
  private async deliverMachineryPrompt(input: {
    agentId: string;
    message: string;
    deliveryMode: "steer" | "interrupt" | "queue";
    reason: string;
    classification?: "machinery";
  }): Promise<void> {
    if (this.store.getStopOrigin(input.agentId) === "user") {
      this.logger.info(
        { component: "stall", agentId: input.agentId, reason: input.reason },
        "mission_control.machinery_prompt.skipped_user_stopped",
      );
      return;
    }
    await dispatchLocalPromptMode({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId: input.agentId,
      prompt: input.message,
      mode: input.deliveryMode,
      ...(input.classification ? { classification: input.classification } : {}),
      replaceOrigin: "machinery",
      recordStopOrigin: (agentId, origin) => this.store.recordStopOrigin(agentId, origin),
      logger: this.logger,
    });
    this.logger.info(
      { component: "stall", agentId: input.agentId, reason: input.reason },
      "mission_control.machinery_prompt.delivered",
    );
  }

  /**
   * The canonical status-ask steer (spec 06): a machinery-classified timeline
   * row in the <paseo-system> wrap both timeline renderers hide in normal mode.
   * Shared by the terminal-state guarantee and fleet_agent_status fresh:true.
   */
  private createStatusAskProposal(
    agentId: string,
    reason: string,
    message: string,
    deliveryMode: "steer" | "queue" = "steer",
  ): Promise<void> {
    return this.deliverMachineryPrompt({
      agentId,
      message: formatSystemNotificationPrompt(message),
      deliveryMode,
      reason,
      classification: "machinery",
    });
  }

  // ==========================================================================
  // Terminal-state guarantee (spec 06): the only automatic status-ask
  // ==========================================================================

  /**
   * Terminal-state guarantee: when a run ends — finished, error, or a
   * machinery interrupt (never a user stop) — with zero self-sourced
   * report_status this run, the agent is steered exactly ONCE for its
   * status; the steer is never repeated and never time-based. Called from
   * emitEvent for system-source terminal events, BEFORE the event snapshot
   * resolves, so the finished card carries the tier-3 fallback description
   * when it applies. Self-source terminal events (a completed report_status)
   * are tier 1 by construction and never reach here.
   *
   * Description tiers (no LLM):
   *   1. Agent self-reports — the normal case; nothing to do.
   *   2. Zero self-reports this run → one status-ask steer.
   *   3. The steer's own run still produced nothing → deterministic
   *      fallback: first line of the last assistant message, flagged
   *      auto-derived on the record.
   *
   * Blocked-on-permission is never nudged: the turn is suspended, not over,
   * and its announcements use the blocked headline + last known description.
   */
  private async maybeApplyTerminalStatusGuarantee(agentId: string): Promise<void> {
    // Only stall-tracked classes (root + Commander workers) get the
    // status-ask: verifiers and plain subagents have legitimate silence.
    const live = this.agentManager.getAgent(agentId);
    if (!live || !this.isStallTracked(live)) {
      return;
    }
    // A user stop is the user's own interruption, not a silent run: never
    // ask (and the user took over, so any pending ask chain is moot).
    if (this.store.getStopOrigin(agentId) === "user") {
      this.terminalAskPending.delete(agentId);
      return;
    }
    // Blocked-on-permission: the turn is suspended, not over. Its
    // announcements use the blocked headline + last known description;
    // never nudge it. Read the LIVE pending-permission state: the
    // blockedByAgent set is cleared by the agent_state handler, which can
    // race the run-end finished callback (a permission approval's turn-end
    // stream can beat the daemon's post-approval emitState), so the stale
    // set entry would wrongly suppress the terminal steer.
    if ((live.pendingPermissions?.size ?? 0) > 0) {
      return;
    }
    const runStart = this.runStartedAtByAgent.get(agentId);
    if (runStart === undefined) {
      return;
    }
    // Tier 1: the agent self-reported this run — no ask; a landed report
    // also ends any pending ask chain from an earlier run.
    if (this.hasSelfSourcedReportSince(agentId, runStart)) {
      this.terminalAskPending.delete(agentId);
      return;
    }
    if (this.terminalAskPending.has(agentId)) {
      // The status-ask steer already went out for this finish chain and the
      // agent still produced nothing: tier 3 — deterministic fallback, never
      // a second steer.
      this.terminalAskPending.delete(agentId);
      await this.applyDeterministicDescription(agentId);
      return;
    }
    // DISABLED(temp): end-of-run status ask switched off by user request
    // (2026-08-21). Restore this block to re-enable the steer.
    // Tier 2: exactly one status-ask steer per finish chain.
    // this.terminalAskPending.add(agentId);
    // this.createStatusAskProposal(
    //   agentId,
    //   "Run ended without a report_status",
    //   "Your run ended without a report_status. Post a one-line report_status summarizing what you did and where you are, then continue.",
    // ).catch((error: unknown) => {
    //   this.logger.warn(
    //     { err: error, component: "stall", agentId },
    //     "Failed to create terminal status-ask steer",
    //   );
    // });
  }

  /** Any self-sourced event at/after the run start (the tier-1 predicate). */
  private hasSelfSourcedReportSince(agentId: string, sinceMs: number): boolean {
    return this.store
      .fetchEvents({ includeSuperseded: true })
      .some(
        (event) =>
          event.agentId === agentId && event.source === "self" && Date.parse(event.ts) >= sinceMs,
      );
  }

  /**
   * Tier-3 deterministic fallback (no LLM): shortDescription = first line of
   * the last assistant message, flagged auto-derived on the stored record.
   * Never throws — a missing timeline or a failed write logs and degrades
   * silently (the steer run's own cards already carry the headline).
   */
  private async applyDeterministicDescription(agentId: string): Promise<void> {
    const rows = this.timelineRows.get(agentId) ?? [];
    let lastAssistantText: string | null = null;
    for (const row of rows) {
      if (row.item.type === "assistant_message") {
        lastAssistantText = row.item.text;
      }
    }
    const firstLine = lastAssistantText
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return;
    }
    const clamped = firstLine.slice(0, AUTO_DERIVED_DESCRIPTION_CHARS).trim();
    if (!clamped) {
      return;
    }
    await this.applyIdentityUpdate(agentId, { description: clamped });
    try {
      const record = await this.agentStorage.get(agentId);
      if (record && record.shortDescription === clamped) {
        await this.agentStorage.upsert({
          ...record,
          shortDescriptionAutoDerived: true,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      this.logger.warn(
        { err: error, agentId },
        "Failed to flag auto-derived description on the stored record",
      );
    }
    this.logger.info({ component: "turn-lifecycle", agentId }, "agent.description.auto_derived");
  }

  /** The agent's most recent self-sourced report event (null when none). */
  private lastSelfReportEvent(agentId: string): MissionControlEvent | null {
    let latest: MissionControlEvent | null = null;
    for (const event of this.store.fetchEvents({ includeSuperseded: true })) {
      if (event.agentId === agentId && event.source === "self") {
        if (!latest || event.ts > latest.ts) {
          latest = event;
        }
      }
    }
    return latest;
  }

  // ==========================================================================
  // Self-reporting (report_status tool)
  // ==========================================================================

  /**
   * Self-reported status from the report_status MCP tool (renamed from
   * report_milestone; the old tool name is deleted). Excluded agents get a
   * polite error; a within-window report is only accepted when it bypasses
   * the rate limit (new run, or a fold-in into the agent's existing unacked
   * event of the same kind — see canBypassSelfReportRateLimit).
   *
   * status mapping: working → kind from input.kind; completed → finished +
   * ready-for-review (post-rollout only); inconclusive → diverged (no ready);
   * blocked → blocked (blocker severity). title/description flow through the
   * identity path.
   */
  private validateSelfReportAdmission(
    agentId: string,
    input: MissionControlReportStatusInput,
  ):
    | {
        ok: true;
        kind: MissionControlAppendInput["kind"];
        severity: MissionControlAppendInput["severity"];
        reportKind: MissionControlReportStatusInput["kind"] | undefined;
        observation: MissionControlObservation;
      }
    | { ok: false; reason: "excluded" | "rate_limited"; message: string } {
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
    const withinRateLimitWindow = this.withinSelfReportRateLimit(observation);
    const { kind, severity, reportKind } = mapReportStatus(input);
    if (withinRateLimitWindow && !this.canBypassSelfReportRateLimit(kind, observation)) {
      return {
        ok: false,
        reason: "rate_limited",
        message:
          "Rate limited: one self-report per minute per agent. Fold this update into your previous report or wait before reporting again.",
      };
    }
    return { ok: true, kind, severity, reportKind, observation };
  }

  private async applySelfReportIdentity(
    agentId: string,
    input: MissionControlReportStatusInput,
  ): Promise<{ titleIgnored: boolean }> {
    const cleanTitle = input.title?.trim();
    if (cleanTitle === undefined && input.description === undefined) {
      return { titleIgnored: false };
    }
    const recordBefore = await this.agentStorage.get(agentId).catch(() => null);
    const recordHasExplicitTitle =
      (recordBefore?.title?.trim() ?? "") !== "" && !recordBefore?.titleAutoDerived;
    const titleAccepted = Boolean(cleanTitle && (!recordHasExplicitTitle || !recordBefore?.title));

    await this.applyIdentityUpdate(agentId, {
      ...(titleAccepted && cleanTitle ? { title: cleanTitle } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });

    if (titleAccepted && cleanTitle && recordBefore?.workspaceId) {
      await this.maybeUpdateWorkspaceTitleFromFirstAgent({
        workspaceId: recordBefore.workspaceId,
        newTitle: cleanTitle,
        previousAgentTitle: recordBefore.title,
      });
    }

    return { titleIgnored: input.title !== undefined && !titleAccepted };
  }

  private recordSelfReportActivity(
    agentId: string,
    event: MissionControlEvent,
    observation: MissionControlObservation,
  ): void {
    const tracking = this.stallTracking.get(agentId);
    if (tracking) {
      tracking.lastStreamAt = Date.now();
      tracking.dormantRecoveredAt = null;
    }
    this.store.updateObservation(agentId, {
      lastSelfReportTs: event.ts,
      lastSelfReportRunEpoch: event.runEpoch ?? observation.runEpoch,
    });
  }

  async reportSelfStatus(
    agentId: string,
    input: MissionControlReportStatusInput,
  ): Promise<SelfReportResult> {
    const admission = this.validateSelfReportAdmission(agentId, input);
    if (!admission.ok) {
      return admission;
    }
    const { kind, severity, reportKind, observation } = admission;
    const { titleIgnored } = await this.applySelfReportIdentity(agentId, input);
    const event = await this.emitEvent(
      this.buildSelfReportEventInput(agentId, input, kind, severity, reportKind),
    );
    this.recordSelfReportActivity(agentId, event, observation);
    const identity = await this.readSelfReportIdentity(agentId, input);
    const notices = await this.collectSelfReportNotices(agentId, input, titleIgnored);
    const notice = notices.length > 0 ? notices.join("; ") : undefined;
    if (input.status === "completed") {
      await this.applyCompletedSelfReport(agentId);
    }
    this.dispatchSelfReportEvent(event, agentId);
    return { ok: true, event, identity, ...(notice ? { notice } : {}) };
  }

  /** The append input for a self-sourced report event, carrying the original
   * report_status kind (so the app can icon progress vs milestone vs finding
   * vs fix vs decision distinctly even though the feed collapses them onto
   * the milestone/finding card kinds) plus detail and proofs when present. */
  private buildSelfReportEventInput(
    agentId: string,
    input: MissionControlReportStatusInput,
    kind: MissionControlAppendInput["kind"],
    severity: MissionControlAppendInput["severity"],
    reportKind: MissionControlReportStatusInput["kind"] | undefined,
  ): Omit<MissionControlAppendInput, "agentTitle"> {
    return {
      agentId,
      kind,
      source: "self",
      severity,
      headline: input.headline,
      reportStatus: input.status,
      ...(reportKind !== undefined ? { reportKind } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.proofs && input.proofs.length > 0 ? { proof: input.proofs } : {}),
    };
  }

  /** Result notices appended to a self-report: a frozen title tells the agent
   * its title write was ignored; a record still lacking a description nags
   * the agent to include one (the description is the Commander's live
   * context). */
  private async collectSelfReportNotices(
    agentId: string,
    input: MissionControlReportStatusInput,
    titleIgnored: boolean,
  ): Promise<string[]> {
    const notices: string[] = [];
    if (input.title !== undefined && titleIgnored) {
      notices.push("title is fixed; description updated");
    }
    if (input.description === undefined) {
      const recordAfter = await this.agentStorage.get(agentId).catch(() => null);
      if (!(recordAfter?.shortDescription?.trim() ?? "")) {
        notices.push(
          "description is missing on your agent record — include a 2-3 sentence `description` in your next report_status so whoever runs the fleet has your live context",
        );
      }
    }
    return notices;
  }

  /** A landed "completed" self-report marks the agent ready-for-review
   * (post-rollout only) and finalizes its run record via the ready
   * transition. */
  private async applyCompletedSelfReport(agentId: string): Promise<void> {
    // Ready-for-review accrues only from rollout onward; pre-rollout agents
    // stay dormant even when a finish event predates the rollout marker.
    if (this.store.getRolloutTs() !== null) {
      await this.store.setReviewState(agentId, "ready");
      this.notifyReviewState(agentId);
      // M6: the completed run finalizes its record via the ready transition.
      void this.finalizeRunRecord(agentId, this.currentRunEpoch(agentId));
    }
  }

  /** Fan the landed event out to every self-report listener; a listener
   * failure never breaks the report. */
  private dispatchSelfReportEvent(event: MissionControlEvent, agentId: string): void {
    for (const listener of this.selfReportListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "mission_control.self_report_listener_failed");
      }
    }
  }

  /**
   * Whether a report from this agent lands inside the 60s self-report
   * rate-limit window. The window is run-scoped, like coalescing: a report in
   * a NEW run is never spam (the previous report belongs to the superseded
   * run), so it only applies when the last report landed in the agent's
   * current run.
   */
  private withinSelfReportRateLimit(observation: MissionControlObservation): boolean {
    if (observation.lastSelfReportTs === null) {
      return false;
    }
    if (observation.lastSelfReportRunEpoch !== observation.runEpoch) {
      return false;
    }
    return Date.now() - Date.parse(observation.lastSelfReportTs) < SELF_REPORT_RATE_LIMIT_MS;
  }

  /**
   * The self-report rate limit's OWN escape, independent of feed coalescing
   * (production rule: two unrelated behavioral rules never share a predicate —
   * the coalesce check doubling as the rate-limit escape silently reintroduced
   * a fixed bug). A report inside the 60s window is admitted when it is
   *   - a NEW-run report: the persisted lastSelfReportRunEpoch pins the
   *     previous self-report to a superseded run, so this one is never spam
   *     (the window itself is run-scoped the same way), or
   *   - a same-run fold-in: it continues the agent's still-pending card of
   *     the same kind — the unacked head of the current run's chain — so it
   *     folds into that card instead of spamming a new one.
   * The fold-in conjuncts are read through the store's getEvent/isEventPending
   * primitives (existence, run epoch, ack state) rather than wouldCoalesce.
   */
  private canBypassSelfReportRateLimit(
    kind: MissionControlEventKind,
    observation: MissionControlObservation,
  ): boolean {
    // Ending reports (done, blocked, inconclusive) are what reporting is for;
    // a milestone a few seconds earlier must not delay them.
    if (
      observation.lastSelfReportRunEpoch !== observation.runEpoch ||
      ENDING_REPORT_KINDS.has(kind)
    ) {
      return true;
    }
    const headId = observation.lastEventByKind[kind];
    if (headId === undefined) {
      return false;
    }
    const head = this.store.getEvent(headId);
    if (head === undefined || (head.runEpoch ?? 0) !== observation.runEpoch) {
      return false;
    }
    return this.store.isEventPending(head.id);
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
  /**
   * A person sent this agent a prompt from the app (not a bot, a peer daemon,
   * or machinery). Listeners mirror it to the agent's ticket and notify bots
   * subscribed to the agent.
   */
  noteUserPrompt(prompt: UserPrompt): void {
    for (const listener of this.userPromptListeners) {
      try {
        listener(prompt);
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: prompt.agentId },
          "mission_control.user_prompt_listener_failed",
        );
      }
    }
  }

  subscribeUserPrompts(listener: (prompt: UserPrompt) => void): () => void {
    this.userPromptListeners.add(listener);
    return () => {
      this.userPromptListeners.delete(listener);
    };
  }

  subscribeSelfReports(listener: (event: MissionControlEvent) => void): () => void {
    this.selfReportListeners.add(listener);
    return () => {
      this.selfReportListeners.delete(listener);
    };
  }

  /**
   * Subscribe to every emitted feed event, any kind/source — unlike
   * subscribeSelfReports (scoped to source:"self"), this fires for every card the
   * Commander itself emits (answer/clarification/proposal) as well. The itsaplan
   * chat-runner uses it to correlate a delivered instruction id (respondsTo) back to
   * the Commander's reply without threading a new callback through emitCommanderCard.
   */
  subscribeEvents(listener: (event: MissionControlEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
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

  /**
   * Spec 01 change 1 (wired by bootstrap): the manager notifies Mission
   * Control directly on a clean running→idle transition — finishes no longer
   * latch a "finished" attention, so this is the ONLY clean-finish signal.
   * Emits the finished event and marks ready-for-review exactly once per run
   * (deduped by run start). Excluded classes (the Commander, verifiers,
   * untracked machinery) never emit lifecycle events.
   */
  handleAgentFinished(params: { agentId: string }): void {
    const agent = this.agentManager.getAgent(params.agentId);
    if (!agent || this.isExcludedAgent(agent)) {
      return;
    }
    const runStartedAt = this.runStartedAtByAgent.get(agent.id);
    const key = `${agent.id}:${runStartedAt ?? "unseen-run"}`;
    if (this.cleanFinishedRuns.has(key)) {
      return;
    }
    this.cleanFinishedRuns.add(key);
    void this.emitEvent({
      agentId: agent.id,
      kind: "finished",
      source: "system",
      severity: "info",
      headline: "Finished",
    });
    void this.markReadyForReview(agent.id);
  }

  private handleAgentState(agent: ManagedAgent): void {
    if (agent.lifecycle !== "running") {
    }
    if (this.isExcludedAgent(agent)) {
      // Lifecycle-untracked: the Commander itself and non-verifier machinery
      // (or a class the user gated off). They never emit MC lifecycle events.
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
        // A user-originated new run (any run that is NOT a machinery
        // supersede) resets the previous run's review lifecycle: a leftover
        // "ready" must not carry into the fresh run, and pending proposals
        // for the agent are stale — approving one would steer a run the user
        // already moved past. Machinery replaces keep their proposals (the
        // superseded run is a fleet-internal recovery, not a user decision).
        if (agent.pendingReplacementOrigin !== "machinery") {
          void this.store.setReviewState(agent.id, "none");
          this.notifyReviewState(agent.id);
        }
        // A new run means any in-flight tool state from the previous run is
        // stale (a wedged/interrupted run may never have closed its tools).
        this.inFlightToolsByAgent.delete(agent.id);
        this.toolStartedAtByAgent.delete(agent.id);
        const runStartedAt = Date.now();
        // Bounds "this run" for the ready-for-review predicate (scope "all"):
        // kept past run end because stallTracking is torn down at the run
        // boundary BEFORE the finished-attention handler consults it.
        this.runStartedAtByAgent.set(agent.id, runStartedAt);
        this.armStallTracking(agent, runStartedAt);
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
      // F1: a USER-origin stop of this run (cancel with no follow-up) ends
      // through the silent turn_canceled hop — no attention latch, no other
      // card — so the board would fold only the 'started' event and lose the
      // stoppedBy:'user' snapshot its 'Stopped by you' chip reads
      // (lifecycle.ts resolveDoneReason). Emit the terminal interrupted card
      // exactly once per run epoch.
      this.emitUserStopInterruptedIfApplicable(agent);
    }

    if (agent.attention.requiresAttention) {
      const reason = agent.attention.attentionReason;
      if (this.attentionKeyByAgent.get(agent.id) !== reason) {
        this.attentionKeyByAgent.set(agent.id, reason);
        // COMPAT(finishedAttentionReason): added in v0.3, remove after 2026-12-01.
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
    if (this.store.getStopOrigin(agentId) === "user") {
      return;
    }
    if (this.centralConfig.get().evaluationScope === "all" && !this.hasAuditableRun(agentId)) {
      return;
    }
    await this.store.setReviewState(agentId, "ready");
    this.notifyReviewState(agentId);
    // M6: ready-for-review finalizes the run record (deterministic upsert).
    void this.finalizeRunRecord(agentId, this.currentRunEpoch(agentId));
  }

  /**
   * Scope-"all" auditable-run predicate (see markReadyForReview): the agent
   * was DISPATCHED — its timeline holds a launch brief (a non-empty
   * user_message row) — AND it reported status at least once in the current
   * run (a self-sourced mission-control event at/after the run start).
   * Reuses the per-agent timeline buffer and the store's self-report feed
   * (the verifier's own context pack reads the same records), so no new
   * persistence is introduced. A conversational session never satisfies it:
   * a chat also carries user messages, so without report_status history a
   * finished turn produces no audit.
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

  // ==========================================================================
  // M6 run-record assembly (deterministic; no transcript reads, no model calls)
  // ==========================================================================

  /**
   * Assemble and persist the run record for (agentId, runEpoch), then push it
   * to the fleet memory bank when configured. Idempotent: re-assembly (run
   * end, ready-for-review, verdict landing) upserts the same record id.
   * Fire-and-forget from the event path — failures log, never block.
   */
  private async finalizeRunRecord(agentId: string, runEpoch: number): Promise<void> {
    try {
      const identity = await this.resolveRunIdentity(agentId);
      let placement: MissionControlRunPlacement | null = null;
      const live = this.agentManager.getAgent(agentId);
      let workspaceId = live?.workspaceId ?? null;
      let cwd = live?.cwd ?? null;
      if (!live) {
        // Closed agent: attribution comes from the durable record.
        const stored = await this.agentStorage.get(agentId).catch(() => null);
        workspaceId = stored?.workspaceId ?? null;
        cwd = stored?.cwd ?? null;
      }
      if (this.resolveRunPlacement) {
        try {
          placement = await this.resolveRunPlacement({ agentId, workspaceId, cwd });
        } catch (error) {
          this.logger.warn({ err: error, agentId }, "mission_control.run_record.placement_failed");
        }
      }
      const timelineRows = await this.readAgentTimelineRows(agentId);
      const record = assembleRunRecord({
        agentId,
        agentName: identity.name,
        agentTitle: identity.title,
        hostAlias: this.resolveHostAlias(),
        serverId: this.serverId,
        runEpoch,
        events: this.store.fetchEvents({ includeSuperseded: true }),
        timelineRows,
        reviewVerdict: this.store.getReviewState(agentId).verdict,
        placement,
      });
      this.store.putRunRecord(record);
      this.rollupCache.invalidate();
      if (isFinalizableRunRecord(record)) this.onRunRecordFinalized?.(record);
    } catch (error) {
      this.logger.warn(
        { err: error, agentId, runEpoch },
        "mission_control.run_record.assembly_failed",
      );
    }
  }

  /** Trigger assembly when a run ends (finished/failed/interrupted) or a verdict lands. */
  private maybeAssembleRunRecordForEvent(event: MissionControlEvent): void {
    if (!RUN_RECORD_FINALIZING_KINDS[event.kind]) {
      return;
    }
    void this.finalizeRunRecord(
      event.agentId,
      event.runEpoch ?? this.currentRunEpoch(event.agentId),
    );
  }

  private currentRunEpoch(agentId: string): number {
    return this.store.getObservation(agentId).runEpoch;
  }

  /** The agent's fleet identity for run records (name + living title). */
  private async resolveRunIdentity(agentId: string): Promise<{ name: string; title: string }> {
    const live = this.agentManager.getAgent(agentId);
    const record = await this.agentStorage.get(agentId).catch(() => null);
    const name = live?.name ?? record?.name ?? record?.title ?? agentId;
    return { name, title: record?.title ?? name };
  }

  /** Host alias for run records: the configured mission-control alias or hostname. */
  private resolveHostAlias(): string {
    const alias = this.daemonConfigStore.get().missionControl?.hostAlias?.trim();
    return alias || this.hostName;
  }

  /** Launch-brief reader: timeline rows, empty when the agent is closed. */
  private async readAgentTimelineRows(agentId: string): Promise<AgentTimelineRow[]> {
    try {
      return await this.agentManager.getTimelineRows(agentId);
    } catch {
      return [];
    }
  }

  private handleAgentStream(
    agentId: string,
    event: AgentStreamEvent,
    seq?: number,
    timestamp?: string,
  ): void {
    const now = Date.now();
    if (this.excludedAgentIds.has(agentId) || this.isExcludedAgent(null, agentId)) {
      // Lifecycle-untracked agents (machinery or a gated-off class) never
      // reach the stall machinery; only their activity is recorded.
      if (!isMachineryRow(event) && !isToolTerminalRow(event)) {
        this.lastActivityAtByAgent.set(agentId, now);
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
    }
    if (tracking) {
      if (!machineryRow) {
        // Machinery-originated rows (the status-ask steer's own timeline
        // placeholder) are the tracker's prompts, never agent activity: they
        // must not reset the dormant-turn silence clock. Any other timeline
        // activity does.
        tracking.lastStreamAt = now;
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
   * Stall sweep (spec 06): NO wall-clock status nudges — the silence (120s)
   * and cadence (300s) status-ask steers are deleted, and with them the
   * escalation path that hung off an unanswered nudge. The terminal-state
   * guarantee (maybeApplyTerminalStatusGuarantee) is the ONLY automatic
   * status-ask and fires at run-end transitions, never on a timer. What
   * remains here is failure recovery, not status:
   * - Dormant-turn detector: a running agent with NO timeline output for
   *   > dormantTurnSeconds AND no tool call in flight has a wedged turn —
   *   omp's loop failed to advance (live incident: agent 3a71c7bb sat 26
   *   minutes with an unprocessed user message and NOTHING in flight). A
   *   DECLARED tool call (an unmatched running tool_call row, e.g. a
   *   30-minute `hub wait`) is WORKING and never flagged. A pending
   *   permission is in-flight too (the agent is blocked on the user, not
   *   wedged).
   * - The dead-runtime watchdog lives in runWatchdog (unchanged).
   * `stallDetectionEnabled` remains as the config master switch for this
   * machinery; the status-ask path it used to gate no longer exists.
   */
  private sweepStalled(): void {
    if (this.inRestartGrace()) {
      return;
    }
    const now = Date.now();
    const { dormantTurnSeconds } = this.readConfig().stall;
    const dormantMs = dormantTurnSeconds * 1000;
    for (const [agentId, tracking] of this.stallTracking) {
      if (this.stalledByAgent.has(agentId)) {
        continue;
      }
      // Healed runs are dead (record -> error); never recovered again.
      if (tracking.healed) {
        continue;
      }
      // User-stopped runs are Done; never recover them.
      if (this.store.getStopOrigin(agentId) === "user") {
        continue;
      }
      if (
        tracking.dormantRecoveredAt === null &&
        (this.inFlightToolsByAgent.get(agentId)?.size ?? 0) === 0 &&
        !this.blockedByAgent.has(agentId) &&
        now - tracking.lastStreamAt >= dormantMs
      ) {
        this.fireDormantRecovery(agentId, tracking, dormantTurnSeconds);
      }
    }
  }

  /** Interrupt-and-continue recovery. Callers guarantee once-per-heal/lapse. */
  private fireRecoveryProposal(agentId: string, reason: string): void {
    void this.deliverMachineryPrompt({
      agentId,
      message: "Continue whatever you were working on and post a one-line report_status.",
      deliveryMode: "interrupt",
      reason,
    }).catch((error: unknown) => {
      this.logger.warn({ err: error, component: "stall", agentId }, "Stall recovery failed");
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
      // Healed: the record flipped to error; the sweep skips healed runs and
      // the dormant detector never double-cards this run.
      tracking.healed = true;
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
        // Boot adoption arms the stall nudges; verifiers and plain subagents
        // are never stall-tracked (legitimate silence), so only stall-tracked
        // classes adopt.
        if (this.isStallTracked(live)) {
          this.adoptSurvivingRun(record);
          adopted += 1;
        }
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

  private classifyAgent(agent: {
    internal?: boolean;
    labels: Record<string, string>;
  }): McTrackingClass {
    if (agent.internal) {
      return "never";
    }
    return classifyAgentLabels(agent.labels);
  }

  /**
   * Whether the agent participates in Mission Control lifecycle events
   * (started/finished/failed cards, run records, review states). Subagents
   * read the central-config gate; machinery is never tracked; root agents
   * always.
   */
  private isLifecycleTracked(agent: {
    internal?: boolean;
    labels: Record<string, string>;
  }): boolean {
    switch (this.classifyAgent(agent)) {
      case "never":
        return false;
      case "subagent":
        return this.centralConfig.get().trackSubagents;
      case "root":
        return true;
    }
  }

  /**
   * Whether the agent participates in the stall machinery (nudges, the
   * dormant-turn detector, dead-runtime reconciliation). Only root agents are
   * stall-tracked: a subagent answers to its parent and has legitimate
   * silence, so MC must not nudge or wedge-recover it.
   */
  private isStallTracked(agent: { internal?: boolean; labels: Record<string, string> }): boolean {
    return this.classifyAgent(agent) === "root";
  }

  /**
   * Arm the stall machinery for a run start. Only stall-tracked classes
   * (root agents, Commander workers) participate in the dormant-turn
   * detector and dead-runtime watchdog; verifiers and plain subagents have
   * legitimate silence and must never be wedge-recovered by MC. Spec 06:
   * the status-ask nudges are gone — the terminal-state guarantee is the
   * only status-ask and lives outside this tracker.
   */
  private armStallTracking(agent: ManagedAgent, runStartedAt: number): void {
    if (!this.isStallTracked(agent)) {
      return;
    }
    this.stallTracking.set(agent.id, {
      lastStreamAt: runStartedAt,
      deadSince: null,
      healed: false,
      runStartedAt,
      lastTurnStartedAt: null,
      dormantRecoveredAt: null,
    });
  }

  private isExcludedAgent(agent?: ManagedAgent | null, agentId?: string): boolean {
    const candidate = agent ?? (agentId ? this.agentManager.getAgent(agentId) : null);
    if (candidate) {
      return !this.isLifecycleTracked(candidate);
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
   * F1: the terminal board card for a USER-origin stop of a running turn.
   * A cancel produces a running→idle hop (turn_canceled) with no attention
   * latch, so nothing else would emit — the board folds only the 'started'
   * card and loses the stoppedBy:'user' snapshot its 'Stopped by you' chip
   * reads (lifecycle.ts resolveDoneReason). Emits the interrupted event with
   * the stop origin snapshotted (source system; the machinery-turn gate
   * already excludes interrupted from chat, spec 07). Exactly once per run
   * epoch — the shared dedupe also covers the turn_failed error-card path,
   * whichever lands first.
   */
  private emitUserStopInterrupted(agentId: string): void {
    const runStartedAt = this.runStartedAtByAgent.get(agentId);
    const key = `${agentId}:${runStartedAt ?? "unseen-run"}`;
    if (this.userStopTerminalEvents.has(key)) {
      return;
    }
    this.userStopTerminalEvents.add(key);
    this.logger.info(
      { component: "turn-lifecycle", agentId, origin: "user" },
      "agent.run.stopped_by_user",
    );
    void this.emitEvent({
      agentId,
      kind: "interrupted",
      source: "system",
      severity: "info",
      headline: "Interrupted by you",
    });
  }

  /**
   * F1 gate, called from handleAgentState's run-end branch. Only the SILENT
   * user stop qualifies: runs that ended with an attention latch keep their
   * existing cards (a clean finish owns its story; an error run goes through
   * classifyRunTerminal — interrupted only for the user-abort signature,
   * failed otherwise), a USER replace (interrupt-and-send) stays silent (the
   * superseded run's abort is machinery noise and the new run's own started
   * card is the story), and machinery/system stops never match the user
   * origin. The clean-finished guard keeps a run that genuinely finished
   * (the clean running→idle latch fired before the stop landed) from also
   * reading as user-stopped.
   */
  private emitUserStopInterruptedIfApplicable(agent: ManagedAgent): void {
    if (this.store.getStopOrigin(agent.id) !== "user") {
      return;
    }
    // Runs that ended with an attention latch keep their existing cards.
    if (agent.attention.requiresAttention) {
      const reason = agent.attention.attentionReason;
      if (reason === "finished" || reason === "error") {
        return;
      }
    }
    if (agent.pendingReplacement === true || (agent.pendingReplacementOrigin ?? null) !== null) {
      return;
    }
    const runStartedAt = this.runStartedAtByAgent.get(agent.id);
    const finishedKey = `${agent.id}:${runStartedAt ?? "unseen-run"}`;
    if (this.cleanFinishedRuns.has(finishedKey)) {
      return;
    }
    this.emitUserStopInterrupted(agent.id);
  }

  /**
   * The feed card for a run that ended in an error state. A provider-killed
   * turn ("Request was aborted (stopReason=aborted, …)" with no user stop and
   * no supersede in flight) additionally proposes ONE resume per run epoch:
   * the agent stays parked in error and the user gets a Resume card instead
   * of retyping the nudge. Ask mode holds the card; auto mode sends it.
   * A resumed run re-arms naturally — the key is per run epoch.
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
    // F1: dedupe against the lifecycle-hop emission — a user stop whose abort
    // also surfaces as turn_failed must still produce exactly one card.
    if (interrupted) {
      const runStartedAt = this.runStartedAtByAgent.get(agentId);
      const key = `${agentId}:${runStartedAt ?? "unseen-run"}`;
      if (this.userStopTerminalEvents.has(key)) {
        return;
      }
      this.userStopTerminalEvents.add(key);
    }
    void this.emitEvent({
      agentId,
      kind: interrupted ? "interrupted" : "failed",
      source: "system",
      severity: interrupted ? "info" : "attention",
      headline: interrupted ? "Interrupted by you" : "Failed with an error",
    });
    if (!interrupted) {
      this.maybeProposeSystemAbortResume(agentId, errorText, candidateAgent);
    }
  }

  private maybeProposeSystemAbortResume(
    agentId: string,
    errorText: string | undefined,
    candidateAgent?: ManagedAgent | null,
  ): void {
    const trimmed = errorText?.trim() ?? "";
    if (!/^request was aborted\b/i.test(trimmed) || !/stopreason=aborted/i.test(trimmed)) {
      return;
    }
    if (this.store.getStopOrigin(agentId) === "user") {
      return;
    }
    const agent = candidateAgent ?? this.agentManager.getAgent(agentId);
    if (
      agent &&
      (agent.pendingReplacement === true || (agent.pendingReplacementOrigin ?? null) !== null)
    ) {
      return;
    }
    if (agent && !this.isStallTracked(agent)) {
      return;
    }
    if ((agent?.pendingPermissions?.size ?? 0) > 0) {
      return;
    }
    const runStartedAt = this.runStartedAtByAgent.get(agentId);
    const key = `${agentId}:${runStartedAt ?? "unseen-run"}`;
    if (this.systemAbortRecoveryByRun.has(key)) {
      return;
    }
    this.systemAbortRecoveryByRun.add(key);
    void this.deliverMachineryPrompt({
      agentId,
      message:
        "Your last turn was killed provider-side (request aborted) before it finished. Continue whatever you were working on from where it stopped, then post a one-line report_status.",
      deliveryMode: "steer",
      reason: "Provider-side abort killed the turn; one resume",
    }).catch((error: unknown) => {
      this.logger.warn(
        { err: error, component: "turn-lifecycle", agentId },
        "System-abort resume failed",
      );
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
    // COMPAT(finishedAttentionReason): added in v0.3, remove after 2026-12-01.
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
  ): Promise<MissionControlEvent> {
    // Terminal-state guarantee (spec 06): a system-source run-end event for a
    // silent run fires the one status-ask steer — or, when the steer's own
    // run also produced nothing, applies the deterministic description
    // fallback — BEFORE the identity snapshot resolves so the finished card
    // carries the tier-3 description when it applies. Self-source terminal
    // events (a completed report_status) are tier 1 by construction.
    if (isTerminalEventKind(input.kind) && input.source !== "self") {
      await this.maybeApplyTerminalStatusGuarantee(input.agentId);
    }
    const agentName = await this.resolveAgentName(input.agentId);
    const agentTitle = await this.resolveAgentTitle(input.agentId);
    const shortDescription =
      input.shortDescription ?? (await this.resolveAgentShortDescription(input.agentId));
    // Snapshot the stop origin at emit time so recorded cards never read the
    // live directory stoppedBy (which the daemon may rewrite later).
    const stoppedBy = this.store.getStopOrigin(input.agentId);
    const event = await this.store.append({
      ...input,
      agentTitle,
      ...(agentName ? { agentName } : {}),
      ...(shortDescription
        ? { shortDescription, agentDescription: input.agentDescription ?? shortDescription }
        : {}),
      ...(stoppedBy ? { stoppedBy } : {}),
    });
    this.broadcast({
      type: "mission_control_event",
      event,
    });
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(
          { err: error, eventId: event.id },
          "mission_control.event_listener_failed",
        );
      }
    }
    // M6 run records: a run-end or verdict event finalizes the run's record.
    this.maybeAssembleRunRecordForEvent(event);
    return event;
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
    return this.emitEvent({
      agentId: input.agentId,
      kind: "verdict",
      source: input.verdict.by === "verifier" ? "verifier" : "system",
      severity: "info",
      headline,
      detail: input.verdict.summary,
      // Every card emitted here resolved the item's review state (done /
      // cleared — the lifecycle only posts verdict cards on such
      // transitions): the card is state-only, so the app skips it in normal
      // (non-verbose) mode (spec 07). Verdict-insufficient cards (item stays
      // needs-you) never come through this path and carry no flag.
      stateOnly: true,
      // Verifier-origin drill-in: the card opens the verifier's thread
      // (verifiers stay hidden from board buckets but are reachable here).
      ...(input.verdict.verifierAgentId ? { verifierAgentId: input.verdict.verifierAgentId } : {}),
    });
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
    this.pushAgentStateAfterReviewChange(agentId);
  }

  /**
   * F2: a reviewState change re-buckets the agent (spec 01 precedence) but
   * produces no agent lifecycle mutation, so connected clients would hold a
   * stale bucket field (fetch_agents payload / board sections / sidebar
   * badge) until the next fetch. Push a fresh agent state/upsert so the
   * recomputed bucket lands immediately:
   * - LIVE agents re-emit state through the manager (the same agent_state
   *   broadcast path lifecycle changes use — every session's agent_update
   *   subscription forwards it with the bucket re-attached at the wire).
   * - CLOSED/STORED agents have no live state; the bootstrap-wired hook fans
   *   the stored-record upsert equivalent out to every trusted session.
   */
  private pushAgentStateAfterReviewChange(agentId: string): void {
    const agent = this.agentManager.getAgent(agentId);
    if (agent) {
      if (agent.internal) {
        return;
      }
      try {
        this.agentManager.notifyAgentState(agentId);
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "mission_control.review_state_state_push_failed");
      }
      return;
    }
    try {
      this.onReviewStateChanged?.(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "mission_control.review_state_stored_push_failed");
    }
  }
  /**
   * PASEO-21: Auto-archive a workspace when its only agent is marked Done.
   * If other active (non-archived) agents remain in the workspace, or if
   * the workspace is a project base workspace or already archived, no-op.
   */
  async maybeAutoArchiveWorkspaceOnAgentDone(agentId: string): Promise<void> {
    if (!this.archiveWorkspace) {
      return;
    }
    try {
      const agentRecord = await this.agentStorage.get(agentId);
      const workspaceId =
        agentRecord?.workspaceId ?? this.agentManager.getAgent(agentId)?.workspaceId;
      if (!workspaceId) {
        return;
      }

      if (this.autoArchivingWorkspaces.has(workspaceId)) {
        return;
      }

      if (this.workspaceRegistry) {
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (!workspace || workspace.archivedAt) {
          return;
        }
      }

      if (this.projectRegistry) {
        const projects = await this.projectRegistry.list();
        const isBaseWorkspace = projects.some(
          (project) => !project.archivedAt && project.baseWorkspaceId === workspaceId,
        );
        if (isBaseWorkspace) {
          return;
        }
      }

      const activeAgentIds = new Set<string>();
      for (const liveAgent of this.agentManager.listAgents()) {
        if (liveAgent.workspaceId === workspaceId) {
          activeAgentIds.add(liveAgent.id);
        }
      }
      const storedRecords = await this.agentStorage.listByWorkspace(workspaceId);
      for (const record of storedRecords) {
        if (!record.archivedAt) {
          activeAgentIds.add(record.id);
        }
      }

      if (activeAgentIds.size === 1 && activeAgentIds.has(agentId)) {
        this.autoArchivingWorkspaces.add(workspaceId);
        try {
          const requestId = `auto-archive-workspace-agent-done-${agentId}-${Date.now()}`;
          this.logger.info(
            { agentId, workspaceId, requestId },
            "mission_control.auto_archive_workspace_on_agent_done",
          );
          await this.archiveWorkspace(workspaceId, requestId);
        } finally {
          this.autoArchivingWorkspaces.delete(workspaceId);
        }
      }
    } catch (error) {
      this.logger.warn(
        { err: error, agentId },
        "mission_control.auto_archive_workspace_on_agent_done_failed",
      );
    }
  }

  /**
   * The event-card title (spec 06): the record's written-once WORK title
   * first — the board's key line reads it; the fleet name stays the chip
   * (resolveAgentName), never the card title.
   */
  private async resolveAgentTitle(agentId: string): Promise<string> {
    const record = await this.agentStorage.get(agentId).catch(() => null);
    if (record?.title) {
      return record.title;
    }
    const live = this.agentManager.getAgent(agentId);
    return live?.name ?? record?.name ?? agentId;
  }

  /** The fleet name snapshot for event cards (additive agentName field). */
  private async resolveAgentName(agentId: string): Promise<string | undefined> {
    const live = this.agentManager.getAgent(agentId);
    if (live?.name) {
      return live.name;
    }
    const record = await this.agentStorage.get(agentId).catch(() => null);
    return record?.name ?? undefined;
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

  private async maybeUpdateWorkspaceTitleFromFirstAgent(params: {
    workspaceId: string;
    newTitle: string;
    previousAgentTitle?: string | null;
  }): Promise<void> {
    if (!this.workspaceRegistry) {
      return;
    }
    const { workspaceId, newTitle, previousAgentTitle } = params;
    try {
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (!workspace || workspace.archivedAt) {
        return;
      }
      const workspaceTitle = workspace.title?.trim() ?? "";
      const isProvisionalWorkspaceTitle =
        workspaceTitle === "" ||
        (previousAgentTitle && workspaceTitle === previousAgentTitle.trim()) ||
        /^#+\s*verbatim\s*ask/i.test(workspaceTitle) ||
        workspaceTitle.toLowerCase() === "verbatim ask" ||
        workspaceTitle.toLowerCase() === "verbatim ask (migrated)";
      if (!isProvisionalWorkspaceTitle) {
        return;
      }
      const recordsInWorkspace = (await this.agentStorage.list()).filter(
        (r) => r.workspaceId === workspaceId && !r.internal && !r.archivedAt,
      );
      if (recordsInWorkspace.length > 1) {
        return;
      }
      const updater = (current: PersistedWorkspaceRecord) => ({
        ...current,
        title: newTitle,
        updatedAt: new Date().toISOString(),
      });
      if (
        "update" in this.workspaceRegistry &&
        typeof this.workspaceRegistry.update === "function"
      ) {
        await this.workspaceRegistry.update(workspaceId, updater);
      } else if (
        "upsert" in this.workspaceRegistry &&
        typeof this.workspaceRegistry.upsert === "function"
      ) {
        await this.workspaceRegistry.upsert({
          ...workspace,
          title: newTitle,
          updatedAt: new Date().toISOString(),
        });
      }
      await this.onWorkspaceUpdated?.(workspaceId);
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId },
        "Failed to update workspace title from first agent report_status",
      );
    }
  }

  private readConfig(): MissionControlServiceConfig {
    const central = this.centralConfig.get();
    return {
      // v3: retention + stall thresholds are central-config driven.
      retentionDays: central.retentionDays,
      stall: {
        enabled: central.stallDetectionEnabled,
        silenceNudgeSeconds: central.silenceNudgeSeconds,
        statusNudgeSeconds: central.statusNudgeSeconds,
        escalateSeconds: central.escalateSeconds,
        dormantTurnSeconds: central.dormantTurnSeconds,
      },
    };
  }
}

type MissionControlCentralConfigPatch = Parameters<CentralMissionControlConfigStore["patch"]>[0];

/**
 * A machinery-originated user row (the status-ask steer's own timeline
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

/**
 * Why an agent participates in Mission Control lifecycle events. The
 * Commander itself and non-verifier machinery (monitors, build-hash stamps)
 * are never tracked; root agents always; verifiers, Commander workers, and
 * plain subagents per the central-config gates.
 */
export type McTrackingClass = "never" | "subagent" | "root";

/**
 * Pure label classification. `commanderAgentId` is the host's Commander id
 * (cached by the service): a parent-labeled agent whose parent IS the
 * Commander is a Commander worker; any other parent makes it a subagent.
 */
export function classifyAgentLabels(labels: Record<string, string>): McTrackingClass {
  if (
    Object.keys(labels).some(
      (key) =>
        key === MISSION_CONTROL_LABEL_PREFIX || key.startsWith(`${MISSION_CONTROL_LABEL_PREFIX}.`),
    )
  ) {
    return "never"; // machinery (old Commander/Verifier records, build-hash stamps)
  }
  return getParentAgentIdFromLabels(labels) ? "subagent" : "root";
}

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
