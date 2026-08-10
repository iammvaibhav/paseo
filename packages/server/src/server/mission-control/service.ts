import type { Logger } from "pino";
import type {
  AgentLifecycleStatus,
  AgentManager,
  AgentManagerEvent,
  ManagedAgent,
} from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { SessionOutboundMessage } from "../messages.js";
import type {
  MissionControlCentralConfig,
  MissionControlEvent,
  MissionControlInstruction,
  MissionControlLifecycleAction,
  MissionControlMetaPlan,
  MissionControlMode,
  MissionControlProposal,
  MissionControlProposalSpawnPlan,
  MissionControlReportStatusInput,
} from "@getpaseo/protocol/mission-control/types";
import type { PeerManager } from "../peers/peer-manager.js";
import { PARENT_AGENT_ID_LABEL, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";
import { getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import { hasMissionControlLabels } from "./naming.js";
import {
  MissionControlStore,
  generateProposalId,
  type MissionControlAppendInput,
  type MissionControlFetchOptions,
  type MissionControlMessageTag,
  type MissionControlObservation,
  type MissionControlReviewStateRecord,
  type MissionControlVerdict,
} from "./store.js";
import type { MissionControlEventKind } from "@getpaseo/protocol/mission-control/types";
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
import { CommanderInstructionTracker } from "./commander-instruction-tracker.js";
import { isDesignatedCommanderHost } from "./commander-boot.js";
import type { MissionControlPresenceSource } from "./presence.js";
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
import {
  HindsightClient,
  type HindsightRecallMatch,
  type HindsightRecallResult,
} from "./hindsight.js";

const STALL_SWEEP_INTERVAL_MS = 30_000;
const DAILY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESTART_GRACE_MS = 60_000;
// Watchdog: record still says running but the provider runtime is dead for
// this long before self-healing the record to error.
const WATCHDOG_DEAD_RUNTIME_MS = 2 * 60_000;
const TIMELINE_BUFFER_CAP = 2000;
const SELF_REPORT_RATE_LIMIT_MS = 60_000;
/** Hindsight written-key set cap (guards unbounded memory; keys are run-scoped). */
const HINDSIGHT_WRITTEN_KEYS_CAP = 5000;
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
 * M8 mailbox: speculative auto-recall budget. When a user/voice instruction
 * is delivered to the Commander, the daemon fires a hindsight recall with the
 * raw instruction text IN PARALLEL with delivery under this hard, constant
 * budget. Within budget → a 'Possibly related (auto-recall):' block rides the
 * envelope; timeout / unconfigured / error → attach nothing and deliver
 * regardless (a late result is dropped — no late steers). The budget is the
 * ONLY thing that can delay the envelope, and it is bounded and constant.
 */
const SPECULATIVE_RECALL_BUDGET_MS = 600;
/** Auto-recall block caps: ≤3 one-liners, each memory text truncated. */
const SPECULATIVE_RECALL_MAX_LINES = 3;
const SPECULATIVE_RECALL_TEXT_CAP = 120;
/**
 * Commander watchdog: the Commander is excluded from stall nudges/escalation
 * by design, so a Commander looping on a failing tool looks frozen forever.
 * After this many consecutive failed calls of the SAME tool in one turn, with
 * validation/not-configured class errors, a single Needs-you card is emitted.
 * Card only — the Commander is never nudged or interrupted.
 */
const COMMANDER_TOOL_LOOP_THRESHOLD = 3;

/**
 * Synthetic instruction-answer card caps: the headline follows the event
 * convention (≤ 120 chars, plain language) and the body is the Commander's
 * turn prose, bounded so a long reply never balloons the feed card.
 */
const SYNTHETIC_ANSWER_HEADLINE_CAP = 120;
const SYNTHETIC_ANSWER_BODY_CAP = 2000;

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

// The no-prose tail of an M3 machinery turn (mirrors the digest-era and
// snapshot-turn instructions): the Commander handles the event or acks.
const MACHINERY_TURN_NO_PROSE_INSTRUCTION =
  'This is a machinery turn. Handle it per your playbook: route, dispatch, or recover with your tools. If no action is needed from you, reply with a single short acknowledgment token (for example "ok") and nothing else. No summaries, no narration.';

// The no-prose tail of a follow-up machinery turn (a dispatched agent's
// terminal event or verdict): the Commander decides ONE of the three follow-up
// moves and acts with its tools — never narration (the feed card already
// shows the outcome).
const MACHINERY_FOLLOW_UP_INSTRUCTION =
  "This is a follow-up on a worker you dispatched. Decide ONE of: (a) propose a follow-up action with your gated tools, (b) post_answer to summarize the outcome to the user, or (c) nothing when the feed card already says it all. Never narrate.";

/** Machinery-turn run-dedupe set cap (guards unbounded memory; keys are run-scoped). */
const MACHINERY_TURN_RUN_DEDUPE_CAP = 5000;

/**
 * The machinery-turn message body: the needs-you event as a standalone
 * <paseo-system> message (the app renders any user row starting with the
 * envelope as machinery). For dispatched-agent follow-ups the message also
 * carries the worker's last report headline and (when present) the verdict
 * line, and the tail switches from the needs-you ack rule to the follow-up
 * decision rule. The fresh world snapshot arrives as its OWN envelope
 * immediately before this row, injected by the CommanderSnapshot Injector on
 * the same delivery path.
 */
function buildMachineryTurnMessage(
  event: MissionControlEvent,
  serverId: string,
  hostName: string,
  extras?: { lastReportHeadline?: string; verdictLine?: string },
): string {
  const link = `paseo://h/${serverId}/agent/${event.agentId}`;
  const detail = event.detail?.trim() ? `\n${event.detail.trim()}` : "";
  const lastReport = extras?.lastReportHeadline?.trim()
    ? `\nLast report: "${extras.lastReportHeadline.trim()}"`
    : "";
  const verdictLine = extras?.verdictLine?.trim() ? `\n${extras.verdictLine.trim()}` : "";
  const isFollowUp =
    event.kind === "finished" ||
    event.kind === "failed" ||
    event.kind === "interrupted" ||
    event.kind === "verdict";
  return formatSystemNotificationPrompt(
    [
      `Needs you: [${event.kind}] ${event.headline} — ${event.agentTitle} (${hostName}) — ${link}${detail}${lastReport}${verdictLine}`,
      isFollowUp ? MACHINERY_FOLLOW_UP_INSTRUCTION : MACHINERY_TURN_NO_PROSE_INSTRUCTION,
    ].join("\n\n"),
  );
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
  /**
   * This host's Mission Control alias (daemon config missionControl.hostAlias,
   * trimmed; null when unset). Central-config ownership resolution
   * (isDesignatedCommanderHost) matches commanderHost against hostName OR
   * hostAlias — same resolution commander-boot uses.
   */
  hostAlias?: string | null;
  /**
   * Peer manager for central-config routing: forwarding patches to the
   * designated commander host and pushing replicas to peers. Resolved lazily
   * (the peer manager is constructed after the service in bootstrap), so a
   * function returning it is accepted too.
   */
  peerManager?: (() => PeerManager | null) | PeerManager | null;
  broadcast: (message: SessionOutboundMessage) => void;
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
   * Execute a commander-origin meta-kind proposal (fleet_meta called by the
   * Commander): apply the fleet meta action described by the proposal's
   * metaPlan (rename/archive project·workspace·agent, create project, move
   * agent, promote workspace). Wired by bootstrap where the meta actions
   * module + move-agent RPC live; absent → meta proposals resolve with an
   * error (never bounce back to pending). Mirrors spawnFromProposal.
   * `metaAppliedOnHost` (additive) names the resolved host the action ran on
   * ("local" or the peer name) so the gate can stamp the proposal record and
   * its event detail.
   */
  metaFromProposal?: (
    proposal: MissionControlProposal,
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
   * Apply a spawn plan against THIS daemon's registries, reached over peering:
   * the commander-host spawn executor routes an approved spawn-kind proposal
   * whose plan targets this host as a peer here (mission_control.spawn.apply
   * → fleetSpawnApply). The receiving daemon validates the plan's cwd
   * contract against its own filesystem, creates the absolute cwd with mkdir
   * recursive when missing, and creates the agent in ITS OWN registry — the
   * mkdir happens on the target host, never the commander's. The plan arrives
   * with paseo.parent-agent-id already stamped by the commander, so the label
   * persists in this host's registry. Only the APPLY hops (the proposal card
   * stays on the commander host). Wired by bootstrap; absent → the spawn
   * apply RPC reports an error.
   */
  spawnApplyRemote?: (
    spawnPlan: MissionControlProposalSpawnPlan,
  ) => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  /**
   * Archive the current Commander and spawn a fresh one with a new context
   * pack (mission_control.commander.reset). Wired by bootstrap with the full
   * commander-boot machinery; absent → the reset RPC reports an error.
   */
  resetCommander?: () => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
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
   * M8 mailbox: hand the speculative-recall block (when one resolved within
   * budget) to the CommanderSnapshotInjector, which appends it to the NEXT
   * snapshot dispatch. The idle delivery path sets it immediately before
   * dispatching the snapshot turn, so the fresh snapshot carries the block;
   * machinery turns never set it (never trigger recall). Absent → idle
   * deliveries simply skip the auto-recall block (the ledger block still
   * rides the snapshot).
   */
  setPendingInstructionEnvelope?: (block: string | null) => void;
  /**
   * M10 mailbox: dispatch a fresh Commander snapshot turn NOW (the
   * injector's dispatchSnapshotTurn) and report whether a snapshot turn is
   * in flight for the idle delivery path to steer the delivered message
   * into. Absent → the idle path falls back to the plain-run delivery (its
   * seam still injects a snapshot ahead of the run).
   */
  dispatchSnapshotTurn?: (agentId: string) => Promise<boolean>;
  /**
   * M10 mailbox: disarm the snapshot turn's ack-drop after the idle delivery
   * path steered the user message into it — the turn's reply is now the
   * Commander's real answer, never a retractable machinery ack.
   */
  disarmSnapshotAckDrop?: () => void;
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
  | { ok: true; event: MissionControlEvent; identity: Partial<SelfReportIdentity> }
  | { ok: false; reason: "excluded" | "rate_limited"; message: string };

export type ReviewStateListener = (
  agentId: string,
  record: MissionControlReviewStateRecord,
) => void;

// ==========================================================================
// fleet_recall: primary + secondary bank merge and omp session-id
// attribution. Pure helpers (unit-testable without a service instance);
// MissionControlService.hindsightRecall wires them together.
// ==========================================================================

/**
 * Attribution resolved locally for a recall match carrying an omp
 * `metadata.session_id`: the Paseo agent whose persistence handle stores that
 * session id. Present only when a live agent or stored record matched.
 */
export interface RecallMatchAttribution {
  agentId: string;
  agentName: string;
  agentTitle: string;
  workspaceId: string | null;
}

/**
 * The minimal identity slice the resolver needs. Both live agents
 * (ManagedAgent) and stored records (StoredAgentRecord) satisfy this shape;
 * callers map persistence.sessionId onto it explicitly.
 */
export interface RecallAttributionSource {
  id: string;
  sessionId: string | null;
  name?: string;
  title?: string | null;
  shortDescription?: string;
  workspaceId?: string | null;
}

/**
 * Merge a primary and (best-effort) secondary recall: primary matches first,
 * then secondary, overall limit respected. A failed primary IS the failure
 * (the bank contract stands); a failed secondary degrades silently to the
 * primary's matches.
 */
export function mergeRecallResults(
  primary: HindsightRecallResult,
  secondary: HindsightRecallResult | null,
  limit: number,
): HindsightRecallResult {
  if (!primary.ok) {
    return primary;
  }
  const matches = [
    ...primary.matches,
    ...(secondary !== null && secondary.ok ? secondary.matches : []),
  ].slice(0, limit);
  return { ok: true, matches };
}

/**
 * Resolve an omp session id to a Paseo agent. Live agents win over stored
 * records (freshest state); either way the match is on the persistence
 * handle's sessionId — the same id omp stamps on bank recall results. Returns
 * null when no agent record carries the session id (the caller passes the raw
 * session_id/entities through so the Commander can fleet_search it).
 */
export function resolveRecallAttribution(
  sessionId: string,
  liveAgents: RecallAttributionSource[],
  storedRecords: RecallAttributionSource[],
): RecallMatchAttribution | null {
  const source =
    liveAgents.find((agent) => agent.sessionId === sessionId) ??
    storedRecords.find((record) => record.sessionId === sessionId);
  if (!source) {
    return null;
  }
  const agentTitle = source.title ?? source.shortDescription ?? source.name;
  const agentName = source.name ?? agentTitle;
  return {
    agentId: source.id,
    agentName: agentName ?? source.id,
    agentTitle: agentTitle ?? source.id,
    workspaceId: source.workspaceId ?? null,
  };
}

export class MissionControlService {
  private readonly logger: Logger;
  private readonly store: MissionControlStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly serverId: string;
  private readonly hostName: string;
  private readonly hostAlias: string | null;
  private readonly peerManagerOption: MissionControlServiceOptions["peerManager"];
  private readonly broadcast: (message: SessionOutboundMessage) => void;
  private readonly verifier: MissionControlServiceOptions["verifier"];
  private readonly centralConfig: CentralMissionControlConfigStore;
  private readonly presenceSource: MissionControlPresenceSource;
  private readonly resetCommanderFn: MissionControlServiceOptions["resetCommander"];
  private readonly spawnFromProposal: MissionControlServiceOptions["spawnFromProposal"];
  private readonly metaFromProposal: MissionControlServiceOptions["metaFromProposal"];
  private readonly metaApplyRemote: MissionControlServiceOptions["metaApplyRemote"];
  private readonly spawnApplyRemote: MissionControlServiceOptions["spawnApplyRemote"];
  private readonly resolveRunPlacement: MissionControlServiceOptions["resolveRunPlacement"];
  private readonly setPendingInstructionEnvelope: MissionControlServiceOptions["setPendingInstructionEnvelope"];
  private readonly dispatchSnapshotTurn: MissionControlServiceOptions["dispatchSnapshotTurn"];
  private readonly disarmSnapshotAckDrop: MissionControlServiceOptions["disarmSnapshotAckDrop"];
  readonly approvals: MissionControlApprovals;
  // M6 context architecture: run-record assembly, rollup cache, hindsight sink.
  private readonly rollupCache = new RollupCache();
  private readonly hindsightClient: HindsightClient;
  /** Run records already written to the fleet bank (dedupe reassembles). */
  private readonly hindsightWrittenKeys = new Set<string>();
  /**
   * Per-run machinery-turn dedupe: one follow-up turn per agent per run epoch
   * for dispatched-agent terminal events and verdicts. Keys
   * "<agentId>:<runEpoch>:terminal" / "<agentId>:<runEpoch>:verdict" — a new
   * run (a `started` event bumps the epoch) earns a fresh turn, and repeated
   * events of the same trigger in one epoch never re-alert the Commander.
   * The classic needs-you triggers (blocked/stalled) keep their own guards.
   */
  private readonly machineryTurnedRunEpochs = new Set<string>();

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
  /**
   * Per-Commander instruction-ledger fallback: ids staged by the mailbox
   * right after their ledger rows open, plus the current turn's assistant-row
   * window, so a turn completion that answered in plain prose (no citing
   * post_answer / clarify / proposal card) still closes its ledger rows via
   * synthesized answer cards. Keyed by commander agent id — a Commander reset
   * archives the old id and spawns a fresh one; tracker state must not leak
   * across. Entries are deleted at window finalize.
   */
  private readonly commanderInstructionTrackers = new Map<string, CommanderInstructionTracker>();
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
    this.daemonConfigStore = options.daemonConfigStore;
    this.serverId = options.serverId;
    this.hostName = options.hostName;
    this.hostAlias = options.hostAlias?.trim() || null;
    this.peerManagerOption = options.peerManager ?? null;
    this.broadcast = options.broadcast;
    this.verifier = options.verifier ?? null;
    this.presenceSource = options.presence;
    this.resetCommanderFn = options.resetCommander;
    this.spawnFromProposal = options.spawnFromProposal;
    this.metaFromProposal = options.metaFromProposal;
    this.metaApplyRemote = options.metaApplyRemote;
    this.spawnApplyRemote = options.spawnApplyRemote;
    this.resolveRunPlacement = options.resolveRunPlacement;
    this.setPendingInstructionEnvelope = options.setPendingInstructionEnvelope;
    this.dispatchSnapshotTurn = options.dispatchSnapshotTurn;
    this.disarmSnapshotAckDrop = options.disarmSnapshotAckDrop;
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
    this.hindsightClient = new HindsightClient({ logger: this.logger });
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
        // COMPAT(digest): the digest-era ack-retraction arming for the
        // delivered Commander turn was removed with the digest queue. The
        // CommanderSnapshotInjector now owns the retraction primitive and
        // arms it only for its own snapshot turn — a delivered message's
        // reply (a proposal decision) is never classified.
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
      },
      publishProposalEvent: async (proposal) => {
        const event = await this.emitProposalEvent(proposal);
        return { id: event.id };
      },
      // EDGE: a denied proposal must never be silent when it carries a
      // revision (deny + editedMessage) or when it was commander-origin — the
      // outcome goes back to the Commander through the mailbox (the same path
      // chat uses, source "chat"), so the ledger opens a row and the
      // Commander reacts (docs/commander.md: "Edit sends your changes back to
      // the Commander, which re-proposes"). One delivery per deny: a revision
      // keeps precedence and the reason rides along in the same message.
      // Never silent: a missing Commander or a failed delivery logs loudly;
      // the deny itself has already resolved.
      deliverDenyOutcome: async ({ proposal, revision, reason }) => {
        const commanderId = await this.resolveCommanderAgentId();
        if (!commanderId) {
          this.logger.warn(
            { component: "approvals", proposalId: proposal.id },
            "mission_control.approvals.deny_outcome_no_commander",
          );
          return;
        }
        let text: string;
        if (revision) {
          text = `Your proposal ${proposal.id} was denied with this revision: ${revision}`;
          if (reason) {
            text += `; reason: ${reason}`;
          }
        } else {
          const summary = proposal.message.slice(0, 80);
          text = `Your proposal ${proposal.id} (${summary}) was denied`;
          if (reason) {
            text += `; reason: ${reason}`;
          }
        }
        const result = await this.deliverCommanderInstruction({
          text,
          source: "chat",
        });
        if (!result.ok) {
          this.logger.warn(
            { component: "approvals", proposalId: proposal.id, error: result.error },
            "mission_control.approvals.deny_outcome_delivery_failed",
          );
        }
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
      // Single execution path for meta-kind proposals (approve or auto mode):
      // the Commander's fleet_meta actions (rename/archive/move/create/
      // promote) apply through the bootstrap-wired metaFromProposal hook.
      applyMeta: async (proposal) => {
        if (!this.metaFromProposal) {
          return { ok: false, error: "Meta executor is not available" };
        }
        return this.metaFromProposal(proposal);
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

  /**
   * M4: emit a Commander interaction card (kind "clarification" or "answer")
   * to the feed, attributed to the Commander (agentId = the Commander's agent
   * id, resolved live). These are cards TO the user — a structured question
   * with options, or a structured fleet answer — never side effects on the
   * fleet, so they are not approval-gated and never trigger machinery turns.
   * Returns null when no Commander is resolvable (the card cannot be
   * attributed); the caller surfaces that as a tool error.
   */
  async emitCommanderCard(
    input:
      | {
          kind: "clarification";
          headline: string;
          clarification: MissionControlEvent["clarification"];
        }
      | {
          kind: "answer";
          headline: string;
          answer: MissionControlEvent["answer"];
        },
  ): Promise<MissionControlEvent | null> {
    const commanderId = await this.resolveCommanderAgentId();
    if (!commanderId) {
      this.logger.warn(
        { component: "commander-card", kind: input.kind },
        "mission_control.commander_card.no_commander",
      );
      return null;
    }
    const event = await this.emitEvent({
      agentId: commanderId,
      kind: input.kind,
      source: "system",
      severity: "info",
      headline: input.headline,
      ...("clarification" in input && input.clarification
        ? { clarification: input.clarification }
        : {}),
      ...("answer" in input && input.answer ? { answer: input.answer } : {}),
    });
    // M8 instruction ledger: a citing card (respondsTo) closes the row.
    const respondsTo =
      (input.kind === "clarification" ? input.clarification?.respondsTo : undefined) ??
      (input.kind === "answer" ? input.answer?.respondsTo : undefined);
    if (respondsTo) {
      this.closeInstructionForCard(respondsTo);
    }
    return event;
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
    reason?: string;
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

  /**
   * The Commander's agent id (the agent labeled paseo.mission-control=
   * commander), if one exists on this host. Public accessor the spawn
   * executor uses to stamp paseo.parent-agent-id on spawned workers at
   * execution time (survives restarts — reads storage first, like the
   * internal resolver).
   */
  async getCommanderAgentId(): Promise<string | null> {
    return this.resolveCommanderAgentId();
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

  // ==========================================================================
  // M8 mailbox: ONE delivery path for every message to the Commander
  // (docs/commander.md "The mailbox"). Chat (app composer), voice
  // (commander_dispatch), and machinery (dispatchMachineryTurn) all land
  // here or on the same dispatchLocalPromptMode primitive. Rule: commander
  // idle → a fresh snapshot turn is dispatched first, then the message is
  // STEERED into that in-flight turn (join-don't-replace — a replace would
  // cancel the snapshot turn and the provider would drop the prompt, so the
  // model never sees the fresh fleet state); commander mid-turn → omp
  // live-steer (the native steer path — NEVER replaceRunning) wrapping the
  // message in the ack-and-fold envelope. The daemon owns the envelope, so
  // chat and voice get identical semantics.
  // ==========================================================================

  /**
   * Deliver a user/voice instruction to the Commander through the mailbox.
   * Opens a ledger row, fires the speculative auto-recall (bounded, in
   * parallel), then:
   *  - busy → steer with the envelope: 'New instruction (#<id>)…' + the open
   *    instruction list + the auto-recall block (when within budget).
   *  - idle → dispatch a fresh snapshot as its own turn first, then STEER
   *    the message into that in-flight turn (the snapshot body carries the
   *    ledger block + the pending auto-recall block, so the steered text is
   *    the plain message). No snapshot turn in flight (settled fast / busy
   *    skip / failed dispatch) → the plain-run fallback, whose seam
   *    re-injects a snapshot ahead of the run.
   * The client's dispatchMode is IGNORED for Commander targets — there is no
   * queueing and no interrupt here (session.ts routes commander-targeted
   * sends through this method).
   */
  async deliverCommanderInstruction(input: {
    text: string;
    source: "chat" | "voice";
    /** Composer attachments (descriptors; the daemon resolves them into the
     *  prompt). The envelope text rides them like any fleet send. */
    attachments?: AgentAttachment[];
  }): Promise<
    { ok: true; instructionId: string; deliveredAs: "run" | "steer" } | { ok: false; error: string }
  > {
    const commanderId = await this.resolveCommanderAgentId();
    if (!commanderId) {
      return { ok: false, error: "No Commander agent on this host" };
    }
    const instruction = this.store.openInstruction({ text: input.text, source: input.source });
    // Instruction-ledger fallback: stage the id BEFORE any async dispatch so
    // a turn completion that answers in prose alone still closes this row via
    // a synthesized answer card. Rolled back if delivery fails (the row itself
    // stays open — the instruction never reached a turn, so it is neither
    // delivered nor answered). A busy steer joins the in-flight turn: its
    // completion must cover this id even when no turn_started is observed.
    const busy = this.agentManager.hasInFlightRun(commanderId);
    const unstageInstruction = this.commanderInstructionTracker(commanderId).stage(
      [instruction.id],
      { intoActiveTurn: busy },
    );
    try {
      // Speculative auto-recall (user-approved design): fire the dual-bank
      // recall with the raw instruction text, in parallel with delivery, under
      // a hard constant budget. Within budget → the block rides the envelope;
      // timeout / unconfigured / error → nothing is attached and delivery is
      // never delayed beyond the budget (a late result is dropped — no late
      // steers). fleet_recall (the Commander's own tool) is untouched.
      const recallBlock = await this.buildSpeculativeRecallBlock(input.text);
      if (busy) {
        const envelope = [
          `New instruction (${instruction.id}). Acknowledge it in one line, fold it into your open work, prioritize user-facing asks, then continue.`,
          this.formatOpenInstructionsBlock(),
          recallBlock,
        ]
          .filter((block): block is string => block !== null && block.length > 0)
          .join("\n\n");
        await dispatchLocalPromptMode({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId: commanderId,
          prompt: envelope,
          attachments: input.attachments,
          mode: "steer",
          classification: "instruction",
          replaceOrigin: "machinery",
          recordStopOrigin: (agentId, origin) => this.store.recordStopOrigin(agentId, origin),
          logger: this.logger,
          // The Commander's own turn loop is covered by the dormant-turn
          // detector (machinery turns arm nothing here either); the mailbox
          // steer never marks the Commander undelivered.
          onOutOfBandSteer: () => {
            this.armSteerDeliveryVerification(commanderId, undefined);
          },
        });
        this.logger.info(
          { instructionId: instruction.id, source: input.source },
          "mission_control.mailbox.steered",
        );
        return { ok: true, instructionId: instruction.id, deliveredAs: "steer" };
      }
      // Idle: hand the recall block (if any) to the snapshot injector so the
      // fresh snapshot carries it alongside the ledger block.
      this.setPendingInstructionEnvelope?.(recallBlock || null);
      // M10: dispatch the fresh snapshot as its OWN turn first, then STEER the
      // message into the in-flight snapshot turn — the same native steer the
      // busy branch uses (proven to reach the provider session). The plain-run
      // delivery below starts the user run with replaceRunning, which CANCELS
      // the snapshot turn; the provider then drops the cancelled prompt, so
      // the model never sees the fresh fleet state — the timeline row alone
      // cannot carry it (the launch-pack staleness).
      const snapshotInFlight = (await this.dispatchSnapshotTurn?.(commanderId)) ?? false;
      if (snapshotInFlight) {
        // The snapshot turn exists to carry this message: the ledger and
        // auto-recall blocks already ride the snapshot body, so the steered
        // text is the plain message — never the 'New instruction (#N).
        // Acknowledge…' mid-turn wrapper (that wrapper belongs to steers into
        // a turn whose primary ask is NOT this message).
        await dispatchLocalPromptMode({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId: commanderId,
          prompt: input.text.trim(),
          attachments: input.attachments,
          mode: "steer",
          classification: "instruction",
          replaceOrigin: "machinery",
          recordStopOrigin: (agentId, origin) => this.store.recordStopOrigin(agentId, origin),
          logger: this.logger,
          // Mirrors the busy branch: the Commander's own turn loop is covered
          // by the dormant-turn detector; the mailbox steer never marks the
          // Commander undelivered (armed with no proposal — a no-op).
          onOutOfBandSteer: () => {
            this.armSteerDeliveryVerification(commanderId, undefined);
          },
        });
        // The turn the message just joined is no longer a machinery ack turn:
        // its reply is the Commander's answer to the user — never retracted.
        this.disarmSnapshotAckDrop?.();
        this.logger.info(
          { instructionId: instruction.id, source: input.source },
          "mission_control.mailbox.ran",
        );
        return { ok: true, instructionId: instruction.id, deliveredAs: "run" };
      }
      // No snapshot turn in flight to steer into (already settled — a fast
      // model — or none was dispatched: busy skip / dispatch failure): the
      // plain-run fallback. Its seam re-injects a fresh snapshot ahead of the
      // run (advisory — a failed injection never fails the message).
      await dispatchLocalPromptMode({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId: commanderId,
        prompt: input.text.trim(),
        attachments: input.attachments,
        mode: "steer",
        classification: "instruction",
        recordStopOrigin: (agentId, origin) => this.store.recordStopOrigin(agentId, origin),
        logger: this.logger,
      });
      this.logger.info(
        { instructionId: instruction.id, source: input.source },
        "mission_control.mailbox.ran",
      );
      return { ok: true, instructionId: instruction.id, deliveredAs: "run" };
    } catch (error) {
      // Delivery failed before the id reached a turn: forget the tracker
      // state (the ledger row stays open — honest: never delivered, never
      // answered; the per-turn envelope re-lists it for a later delivery).
      unstageInstruction();
      throw error;
    }
  }

  /**
   * M8 ledger: every retained instruction row, newest first (the verbose
   * thread's open list + close affordance reads this).
   */
  listInstructions(): MissionControlInstruction[] {
    return this.store.listInstructions();
  }

  /**
   * M8 ledger: manual close from the verbose thread affordance
   * (mission_control.instructions.close). Idempotent: closing an unknown or
   * already-closed row is a no-op success (the app re-lists and the row
   * simply disappears from the open set).
   */
  async closeInstruction(
    instructionId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.store.closeInstruction(instructionId, "manual");
    return { ok: true };
  }

  /**
   * M8 ledger block for the per-turn envelope: 'Open instructions:' with the
   * open rows, regenerated per turn like the snapshot — never accreted. Empty
   * string when nothing is open. `excludeId` (optional) skips a row that is
   * about to be listed by its own 'New instruction' line (not used — the
   * ledger block lists the new row too, since the envelope is the whole
   * picture; kept for future callers).
   */
  formatOpenInstructionsBlock(_excludeId?: string): string {
    const open = this.store.listOpenInstructions();
    if (open.length === 0) {
      return "";
    }
    const lines = open.map((instruction) => {
      const oneLine = instruction.text.replace(/\s+/g, " ").trim();
      return `- ${instruction.id}: ${oneLine}`;
    });
    return `Open instructions:\n${lines.join("\n")}`;
  }

  /**
   * Close the ledger row a citing card answers (respondsTo), closedBy
   * "cardId". A no-op for unknown/already-closed ids. Called when the
   * Commander emits a proposal, clarification, or answer card carrying
   * respondsTo.
   */
  closeInstructionForCard(respondsTo: string): void {
    const closed = this.store.closeInstruction(respondsTo, "cardId");
    if (closed) {
      this.logger.info(
        { instructionId: respondsTo, closedBy: "cardId" },
        "mission_control.instructions.closed_by_card",
      );
    }
  }

  /**
   * Speculative auto-recall: race the dual-bank hindsight recall (with
   * attribution) against the hard constant budget and format ≤3 one-liners
   * when it wins. Null on timeout / unconfigured / error — callers attach
   * nothing and deliver regardless (the budget bounds any delay; a late
   * result is dropped, never a late steer).
   */
  private async buildSpeculativeRecallBlock(text: string): Promise<string | null> {
    const recallPromise = this.hindsightRecall(text, SPECULATIVE_RECALL_MAX_LINES);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SPECULATIVE_RECALL_BUDGET_MS);
    });
    let result: HindsightRecallResult | null;
    try {
      result = await Promise.race([recallPromise, timeout]);
    } catch (error) {
      this.logger.debug({ err: error }, "mission_control.mailbox.auto_recall_error");
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!result || !result.ok || result.matches.length === 0) {
      this.logger.debug({}, "mission_control.mailbox.auto_recall_empty");
      return null;
    }
    // The dual-bank recall enriches omp matches with Paseo-agent attribution
    // (service.attributeRecallMatches) — the declared result type predates
    // the enrichment, so narrow here.
    const matches = result.matches as Array<
      HindsightRecallMatch & { attribution?: RecallMatchAttribution }
    >;
    const lines = matches.slice(0, SPECULATIVE_RECALL_MAX_LINES).map((match) => {
      const memoryText = match.text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, SPECULATIVE_RECALL_TEXT_CAP);
      const attribution = match.attribution
        ? ` (${match.attribution.agentName || match.attribution.agentId}${
            match.attribution.workspaceId ? `, ${match.attribution.workspaceId}` : ""
          })`
        : "";
      return `- ${memoryText}${attribution} [${match.bank}]`;
    });
    return `Possibly related (auto-recall):\n${lines.join("\n")}`;
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

  /**
   * Apply a spawn plan against THIS daemon's registries, reached over peering
   * (mission_control.spawn.apply — the commander host forwards an approved
   * spawn-kind proposal whose plan targets this host as a peer). THIS host
   * validates the cwd contract against its own filesystem, creates the
   * absolute cwd with mkdir recursive when missing, and creates the agent in
   * its own registry (the mkdir happens here, never on the commander's disk).
   * Absent wiring → an error result (never a throw).
   */
  async applySpawnRemote(
    spawnPlan: MissionControlProposalSpawnPlan,
  ): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
    if (!this.spawnApplyRemote) {
      return { ok: false, error: "Spawn executor is not available on this host" };
    }
    return this.spawnApplyRemote(spawnPlan);
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
    // Names are write-once: a namingTheme patch affects only future
    // assignments (the theme is read fresh at assign time) and never
    // re-maps existing names, so there is nothing to do beyond persisting
    // the patch.
    return this.centralConfig.patch(patch);
  }

  async setMode(mode: MissionControlMode): Promise<ResolvedMissionControlCentralConfig> {
    return this.centralConfig.setMode(mode);
  }

  // ==========================================================================
  // Central-config ownership + replication (Wave 2): the host named by
  // centralConfig.commanderHost owns central-config.json. A daemon receiving
  // mission_control.config.patch applies + persists + replicates when IT is
  // the commander host; otherwise it FORWARDS the patch to the commander host
  // over peering and returns ITS response (never applies locally, never
  // silently succeeds). Peers receiving mission_control.config.replica
  // replace their local snapshot (last-writer-wins) so consumers on every
  // host — stall detector, hindsight writer, verifier — read the same policy.
  // ==========================================================================

  /**
   * Ownership-aware central-config write (patch path). Discriminated result
   * so the session can emit the exact wire payload:
   *  - ok:true   → applied (owner) or forwarded+applied (non-owner), config resolved.
   *  - ok:false  → NOT applied anywhere (unreachable commander host), config = the
   *                local (unchanged) resolved snapshot, unreachableCommanderHost set.
   */
  async patchCentralConfigRouted(
    patch: MissionControlCentralConfigPatch,
  ): Promise<CentralConfigWriteResult> {
    const designated = this.centralConfig.get().commanderHost?.trim() || null;
    // Standalone: no commander host designated — every host keeps its own
    // central config (current behavior). Local apply, no replication.
    if (designated === null) {
      return { ok: true, config: await this.centralConfig.patch(patch) };
    }
    if (this.isThisCommanderHost(designated)) {
      return this.applyCentralConfigPatchAsOwner(patch);
    }
    return this.forwardCentralConfigPatch(designated, patch);
  }

  /** Ownership-aware mode toggle (same write path as patch). */
  async setModeRouted(mode: MissionControlMode): Promise<CentralConfigWriteResult> {
    const designated = this.centralConfig.get().commanderHost?.trim() || null;
    if (designated === null) {
      return { ok: true, config: await this.centralConfig.setMode(mode) };
    }
    if (this.isThisCommanderHost(designated)) {
      return this.applyCentralConfigPatchAsOwner({ mode });
    }
    return this.forwardCentralConfigPatch(designated, { mode });
  }

  /**
   * The commander host pushes its current snapshot to a peer that just came
   * online (sync-on-connect). Only the commander host pushes; every other
   * host's peer connection is answered by the commander side of that link.
   */
  async syncCentralConfigToPeer(peerName: string): Promise<void> {
    const designated = this.centralConfig.get().commanderHost?.trim() || null;
    if (designated === null || !this.isThisCommanderHost(designated)) {
      return;
    }
    const peerManager = this.resolvePeerManager();
    const client = peerManager?.getPeerClient(peerName);
    if (!client) {
      this.logger.warn({ peer: peerName }, "mission_control.config.sync_on_connect_no_peer_client");
      return;
    }
    client.missionControlConfigReplica(this.centralConfig.get(), { from: this.hostName });
    this.logger.info({ peer: peerName }, "mission_control.config.synced_on_connect");
  }

  /**
   * Replica receive path: full snapshot replace (last-writer-wins), in-memory
   * store + persisted file. NEVER re-pushes — a replica is already the
   * outcome of an owner push; re-pushing would loop.
   */
  async applyCentralConfigReplica(snapshot: MissionControlCentralConfig): Promise<void> {
    await this.centralConfig.replace(snapshot);
  }

  private isThisCommanderHost(designated: string): boolean {
    return isDesignatedCommanderHost({
      central: { commanderHost: designated },
      hostName: this.hostName,
      hostAlias: this.hostAlias,
    });
  }

  private resolvePeerManager(): PeerManager | null {
    const option = this.peerManagerOption;
    return typeof option === "function" ? option() : (option ?? null);
  }

  private async applyCentralConfigPatchAsOwner(
    patch: MissionControlCentralConfigPatch,
  ): Promise<CentralConfigWriteResult> {
    const previous = this.centralConfig.get();
    const next = await this.centralConfig.patch(patch);
    const commanderHostChanged =
      patch.commanderHost !== undefined &&
      (patch.commanderHost ?? null) !== (previous.commanderHost ?? null);
    if (commanderHostChanged) {
      this.logger.warn(
        {
          component: "config",
          from: previous.commanderHost ?? null,
          to: next.commanderHost ?? null,
        },
        "mission_control.config.commander_host_migrated — old owner pushes final snapshot to every peer (one migration hop)",
      );
    }
    await this.replicateCentralConfig(next);
    return { ok: true, config: next };
  }

  /** Push the full snapshot to every online peer (fire-and-forget, logged). */
  private async replicateCentralConfig(config: ResolvedMissionControlCentralConfig): Promise<void> {
    const peerManager = this.resolvePeerManager();
    if (!peerManager) {
      return;
    }
    const online = peerManager.getPeerStatuses().filter((peer) => peer.state === "online");
    if (online.length === 0) {
      return;
    }
    await Promise.all(
      online.map(async (peer) => {
        const client = peerManager.getPeerClient(peer.name);
        if (!client) {
          return;
        }
        try {
          client.missionControlConfigReplica(config, { from: this.hostName });
        } catch (error) {
          this.logger.warn(
            { err: error, peer: peer.name },
            "Failed to replicate central config to peer",
          );
        }
      }),
    );
  }

  /**
   * Non-owner write path: forward the patch to the commander host over
   * peering and return ITS response verbatim. When the commander host is not
   * a configured peer, not online, or the round-trip fails, return an
   * explicit error (additive unreachableCommanderHost on the wire) — NEVER
   * apply locally, NEVER silently succeed.
   */
  private async forwardCentralConfigPatch(
    commanderHost: string,
    patch: MissionControlCentralConfigPatch,
  ): Promise<CentralConfigWriteResult> {
    const peerManager = this.resolvePeerManager();
    const peerStatus = peerManager?.getPeerStatus(commanderHost) ?? null;
    const peerClient = peerManager?.getPeerClient(commanderHost) ?? null;
    const localConfig = this.centralConfig.get();
    if (!peerStatus || peerStatus.state !== "online" || !peerClient) {
      const error =
        peerStatus === null
          ? `Commander host "${commanderHost}" is not a configured peer; central config was NOT updated`
          : `Commander host "${commanderHost}" is unreachable (${peerStatus.state}); central config was NOT updated`;
      this.logger.warn(
        {
          commanderHost,
          state: peerStatus?.state ?? "not-configured",
          patchKeys: Object.keys(patch),
        },
        "mission_control.config.forward_unreachable",
      );
      return {
        ok: false,
        error,
        unreachableCommanderHost: commanderHost,
        config: localConfig,
      };
    }
    try {
      const response = await peerClient.missionControlConfigPatch(patch);
      if (!response.ok) {
        this.logger.warn(
          { commanderHost, error: response.error },
          "mission_control.config.forward_rejected",
        );
        return {
          ok: false,
          error: response.error ?? `Commander host "${commanderHost}" rejected the patch`,
          ...(response.unreachableCommanderHost
            ? { unreachableCommanderHost: response.unreachableCommanderHost }
            : {}),
          config: localConfig,
        };
      }
      this.logger.info(
        { commanderHost, patchKeys: Object.keys(patch) },
        "mission_control.config.forwarded",
      );
      return { ok: true, config: response.config };
    } catch (error) {
      this.logger.warn({ err: error, commanderHost }, "mission_control.config.forward_failed");
      return {
        ok: false,
        error: `Commander host "${commanderHost}" unreachable: ${getErrorMessageOr(error, "round-trip failed")}; central config was NOT updated`,
        unreachableCommanderHost: commanderHost,
        config: localConfig,
      };
    }
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
  getProjectRollup(projectId: string): ProjectRollup | null {
    return this.rollupCache.getProject(projectId, () =>
      deriveProjectRollup(this.store.getRunRecords(), projectId),
    );
  }

  /**
   * Semantic recall over the configured fleet bank, plus (when configured)
   * the read-only secondary omp bank. Never blocks and never throws: when
   * the bank is unconfigured or unreachable the caller gets
   * { ok: false, reason: "memory unavailable" }. Results are merged primary
   * first with the overall limit respected; a secondary failure degrades
   * silently to the primary's matches. Every match carrying an omp
   * `metadata.session_id` is attributed to the Paseo agent whose persistence
   * handle stores that session id (live agents first, then stored records).
   */
  async hindsightRecall(query: string, limit = 5): Promise<HindsightRecallResult> {
    const config = this.centralConfig.get();
    if (!HindsightClient.isEnabled(config.hindsightUrl)) {
      return { ok: false, reason: "memory unavailable", error: "hindsight is not configured" };
    }
    const secondaryBank = config.hindsightSecondaryBank?.trim();
    const [primary, secondary] = await Promise.all([
      this.hindsightClient.recall({
        url: config.hindsightUrl,
        bank: config.hindsightBank,
        query,
        limit,
      }),
      secondaryBank
        ? this.hindsightClient.recall({
            url: config.hindsightUrl,
            bank: secondaryBank,
            query,
            limit,
          })
        : Promise.resolve(null),
    ]);
    const merged = mergeRecallResults(primary, secondary, limit);
    if (!merged.ok) {
      return merged;
    }
    return { ok: true, matches: await this.attributeRecallMatches(merged.matches) };
  }

  /**
   * Enrich recall matches whose `sessionId` (the omp session id on the bank
   * memory's metadata) resolves to a Paseo agent: live agents first, then
   * stored records, both matched on the persistence handle's sessionId.
   * Unresolved matches pass through untouched (raw session_id/tags/entities
   * stay on the wire for the Commander to fleet_search).
   */
  private async attributeRecallMatches(
    matches: HindsightRecallMatch[],
  ): Promise<Array<HindsightRecallMatch & { attribution?: RecallMatchAttribution }>> {
    const sessionIds = matches
      .map((match) => match.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null);
    if (sessionIds.length === 0) {
      return matches;
    }
    const liveAgents: RecallAttributionSource[] = this.agentManager.listAgents().map((agent) => ({
      id: agent.id,
      sessionId: agent.persistence?.sessionId ?? null,
      name: agent.name,
      shortDescription: agent.shortDescription,
      workspaceId: agent.workspaceId,
    }));
    const storedRecords: RecallAttributionSource[] = (await this.agentStorage.list()).map(
      (record) => ({
        id: record.id,
        sessionId: record.persistence?.sessionId ?? null,
        name: record.name,
        title: record.title ?? null,
        shortDescription: record.shortDescription,
        workspaceId: record.workspaceId,
      }),
    );
    const attributionBySessionId = new Map<string, RecallMatchAttribution>();
    for (const sessionId of new Set(sessionIds)) {
      const attribution = resolveRecallAttribution(sessionId, liveAgents, storedRecords);
      if (attribution) {
        attributionBySessionId.set(sessionId, attribution);
      }
    }
    if (attributionBySessionId.size === 0) {
      return matches;
    }
    return matches.map((match) => {
      const attribution =
        match.sessionId !== null ? attributionBySessionId.get(match.sessionId) : undefined;
      return attribution ? { ...match, attribution } : match;
    });
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
    this.store.updateObservation(agentId, {
      lastSelfReportTs: event.ts,
      lastSelfReportRunEpoch: event.runEpoch ?? observation.runEpoch,
    });
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
        // M6: the completed run finalizes its record via the ready transition.
        void this.finalizeRunRecord(agentId, this.currentRunEpoch(agentId));
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
    if (observation.lastSelfReportRunEpoch !== observation.runEpoch) {
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
      this.maybeWriteRunRecordToHindsight(record);
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

  /**
   * Write a finalized run record to the fleet bank (fire-and-forget, failures
   * throttled by the client). Written once per record; a record carrying a
   * verdict is always re-written (the verdict is the final word on the run).
   */
  private maybeWriteRunRecordToHindsight(record: MissionControlRunRecord): void {
    if (!isFinalizableRunRecord(record)) {
      return;
    }
    const config = this.centralConfig.get();
    if (!HindsightClient.isEnabled(config.hindsightUrl)) {
      return;
    }
    if (record.verdict === null && this.hindsightWrittenKeys.has(record.id)) {
      return;
    }
    this.hindsightWrittenKeys.add(record.id);
    if (this.hindsightWrittenKeys.size > HINDSIGHT_WRITTEN_KEYS_CAP) {
      const first = this.hindsightWrittenKeys.values().next().value;
      if (typeof first === "string") {
        this.hindsightWrittenKeys.delete(first);
      }
    }
    void this.hindsightClient
      .writeRunRecord({ url: config.hindsightUrl, bank: config.hindsightBank, record })
      .catch(() => {
        // The client swallows failures already; belt-and-braces for the void path.
      });
  }

  private trackCommanderInstructionIfApplicable(
    agentId: string,
    event: AgentStreamEvent,
    seq?: number,
  ): void {
    const agent = this.agentManager.getAgent(agentId);
    if (agent?.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE) {
      this.trackCommanderInstruction(agentId, event, seq);
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
      // Instruction-ledger fallback: track the Commander's delivery window
      // (turn_started / assistant rows / turn completion) so a turn that
      // answers in plain prose — no citing card — still closes its ledger
      // rows via synthesized answer cards. Only the Commander is tracked
      // (verifier streams carry no staged ids and would no-op anyway).
      this.trackCommanderInstructionIfApplicable(agentId, event, seq);
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
   * Instruction-ledger fallback window tracking for the Commander's stream
   * (excluded-agent path, Commander only): turn_started binds staged ids to
   * the turn and opens the assistant-row window; assistant_message rows
   * accumulate in seq order (the ordered-join convention CommanderAckDrop
   * uses); turn_completed finalizes the window; turn_failed/turn_canceled
   * keep the ids pending for the next delivery/recovery window and never
   * synthesize (a failed turn's prose is not a completed answer).
   */
  private trackCommanderInstruction(agentId: string, event: AgentStreamEvent, seq?: number): void {
    const tracker = this.commanderInstructionTracker(agentId);
    if (event.type === "turn_started") {
      tracker.turnStarted();
      return;
    }
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      if (seq !== undefined) {
        tracker.assistantRow(seq, event.item.text);
      }
      return;
    }
    if (event.type === "turn_completed") {
      this.finalizeCommanderInstructionWindow(agentId, tracker);
      return;
    }
    if (event.type === "turn_failed" || event.type === "turn_canceled") {
      tracker.fail();
    }
  }

  /**
   * turn_completed: synthesize one generic answer card per still-open tracked
   * id through the SAME emitCommanderCard path the Commander's own
   * post_answer/clarify tools use — event format, feed UI, and ledger closure
   * stay one path. Ids a genuine citing card already closed (respondsTo →
   * closeInstructionForCard) are filtered out against the store's open set at
   * this point, so the fallback never duplicates a real card. Machinery turns
   * and unrelated old ledger rows never enter the tracked set and are never
   * touched.
   */
  private finalizeCommanderInstructionWindow(
    agentId: string,
    tracker: CommanderInstructionTracker,
  ): void {
    const snapshot = tracker.complete();
    this.commanderInstructionTrackers.delete(agentId);
    if (!snapshot) {
      return;
    }
    const openIds = new Set(this.store.listOpenInstructions().map((instruction) => instruction.id));
    const stillOpen = snapshot.ids.filter((id) => openIds.has(id));
    if (stillOpen.length === 0) {
      return;
    }
    void this.synthesizeCommanderAnswerCards(agentId, stillOpen, snapshot.text).catch((error) => {
      this.logger.warn(
        { err: error, agentId, component: "commander-card" },
        "mission_control.instructions.synthetic_answer_failed",
      );
    });
  }

  /**
   * Emit the synthetic answer cards for one finalized delivery window: one
   * generic answer card per still-open tracked id, body = the turn's prose,
   * respondsTo = the id (emitCommanderCard closes the ledger row). Headline
   * follows the ledger's one-line style and the event's ≤120-char convention;
   * body is capped so a long reply never balloons the feed card.
   */
  private async synthesizeCommanderAnswerCards(
    agentId: string,
    ids: string[],
    text: string,
  ): Promise<void> {
    const byId = new Map(
      this.store.listInstructions().map((instruction) => [instruction.id, instruction]),
    );
    for (const id of ids) {
      const oneLine = (byId.get(id)?.text ?? "").replace(/\s+/g, " ").trim();
      const headline = `Answer to ${id}${oneLine ? `: ${oneLine}` : ""}`.slice(
        0,
        SYNTHETIC_ANSWER_HEADLINE_CAP,
      );
      const event = await this.emitCommanderCard({
        kind: "answer",
        headline,
        answer: {
          kind: "generic",
          headline,
          body: text.slice(0, SYNTHETIC_ANSWER_BODY_CAP),
          respondsTo: id,
        },
      });
      if (event) {
        this.logger.info(
          { component: "commander-card", eventId: event.id, instructionId: id, agentId },
          "mission_control.instructions.synthetic_answer",
        );
      }
    }
  }

  /** The per-Commander tracker for an agent id, created on first use. */
  private commanderInstructionTracker(agentId: string): CommanderInstructionTracker {
    let tracker = this.commanderInstructionTrackers.get(agentId);
    if (!tracker) {
      tracker = new CommanderInstructionTracker();
      this.commanderInstructionTrackers.set(agentId, tracker);
    }
    return tracker;
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
    const {
      enabled,
      silenceNudgeSeconds,
      statusNudgeSeconds,
      escalateSeconds,
      dormantTurnSeconds,
    } = this.readConfig().stall;
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
      // With stall detection disabled (central stallDetectionEnabled false)
      // the daemon never asks agents for status updates: no silence/status
      // nudges and no escalation (nudgedAt stays null, so the escalate
      // branch below is inert). The dormant-turn detector still runs below —
      // a wedged loop is a harness bug, not a status-ask, and stays covered.
      if (enabled) {
        this.runStallNudgeAndEscalate(
          agentId,
          tracking,
          now,
          silenceNudgeSeconds,
          statusNudgeSeconds,
          escalateSeconds,
          escalateMs,
        );
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
  private runStallNudgeAndEscalate(
    agentId: string,
    tracking: StallTracking,
    now: number,
    silenceNudgeSeconds: number,
    statusNudgeSeconds: number,
    escalateSeconds: number,
    escalateMs: number,
  ): void {
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
  }

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
  ): Promise<MissionControlEvent> {
    const agentTitle = await this.resolveAgentTitle(input.agentId);
    const shortDescription =
      input.shortDescription ?? (await this.resolveAgentShortDescription(input.agentId));
    // Snapshot the stop origin at emit time so recorded cards never read the
    // live directory stoppedBy (which the daemon may rewrite later).
    const stoppedBy = this.store.getStopOrigin(input.agentId);
    const event = await this.store.append({
      ...input,
      agentTitle,
      ...(shortDescription ? { shortDescription } : {}),
      ...(stoppedBy ? { stoppedBy } : {}),
    });
    this.broadcast({
      type: "mission_control_event",
      event,
    });
    // M6 run records: a run-end or verdict event finalizes the run's record.
    this.maybeAssembleRunRecordForEvent(event);
    // M3 runtime model: the feed keeps the event; the Commander no longer
    // receives event streams as chat. Needs-you events (blocked /
    // stalled-escalation / verdict-insufficient) trigger a machinery turn,
    // and Commander-dispatched agents additionally trigger one on terminal
    // events and verdicts (both modes) — the fresh world snapshot rides the
    // same turn via the CommanderSnapshotInjector's beforeAgentRun seam.
    this.maybeDispatchMachineryTurn(event);
    // M9 cross-host follow-through: when THIS daemon is NOT the commander
    // host, a terminal event for one of its commander-dispatched workers can
    // never reach the commander host's machinery-turn gate locally (that host
    // has no record of a peer-host worker). Forward the event over peering so
    // the commander host runs the gate with the worker's labels from the
    // payload.
    this.maybeForwardTerminalEventToCommander(event);
    return event;
  }

  // --- M3 machinery turns (docs/commander.md "Runtime model") ---

  /**
   * Event kinds that qualify for a machinery turn, mode aside. Blocked
   * (permission / verification-failed / tool-loop) and stalled (escalation,
   * dormant-turn, steer-undelivered, self-heal) always qualify. For agents
   * the Commander DISPATCHED (spawned via fleet_create_agent or adopted via
   * a delivered fleet_send_prompt), terminal events (finished / failed /
   * interrupted) and verdicts ALSO qualify — the dispatch → finish →
   * follow-up loop closes only when the Commander hears the outcome, in ask
   * and auto alike. Non-dispatched agents keep the narrow rules: verdict
   * cards qualify only when the verdict does NOT resolve the item (ready /
   * none) — a completion needs no routing. The mode gate lives in
   * runMachineryTurnGate: ask mode dispatches only dispatched-agent events
   * (any action the Commander takes becomes a gated proposal card, so the
   * follow-up is safe), auto mode dispatches everything that qualifies.
   */
  private async shouldDispatchMachineryTurn(
    event: MissionControlEvent,
    labelsOverride?: Record<string, string> | null,
  ): Promise<boolean> {
    if (event.kind === "blocked" || event.kind === "stalled") {
      return true;
    }
    if (event.kind === "verdict") {
      if (
        await this.isDispatchedByLabels(labelsOverride ?? (await this.agentLabels(event.agentId)))
      ) {
        return true;
      }
      // Verdict-insufficient: the item stays needs-you (ready/none). A
      // done/cleared verdict resolves the item — the Commander is not
      // consulted about completions.
      const review = this.store.getReviewState(event.agentId);
      return review?.reviewState === "ready" || review?.reviewState === "none";
    }
    if (event.kind === "finished" || event.kind === "failed" || event.kind === "interrupted") {
      return await this.isDispatchedByLabels(
        labelsOverride ?? (await this.agentLabels(event.agentId)),
      );
    }
    return false;
  }

  /**
   * Fire-and-forget machinery turn: delivers the qualifying event to the
   * Commander as a steer-classified machinery message. Ask mode dispatches
   * only Commander-dispatched-agent events (a machinery turn is safe there
   * because any action the Commander takes becomes a gated proposal card);
   * non-dispatched events stay AUTO-mode-only (noise control). Follow-up
   * turns (terminal events + verdicts on dispatched agents) are rate-limited
   * to one per agent per run epoch. The fresh world snapshot rides the same
   * delivery automatically — the delivered message goes through
   * startAgentRun, whose beforeAgentRun seam runs the CommanderSnapshot
   * Injector first. Failures are logged, never surfaced: the event card
   * already reached the feed, and the event is never re-queued (payloads are
   * computed at delivery).
   */
  private maybeDispatchMachineryTurn(
    event: MissionControlEvent,
    labelsOverride?: Record<string, string> | null,
  ): void {
    void this.runMachineryTurnGate(event, labelsOverride).catch((error) => {
      // centralConfig reads and the dispatched check can throw pre-
      // initialization; never let the event emission path fail on the
      // machinery-turn side effect.
      this.logger.warn(
        { err: error, eventId: event.id },
        "mission_control.machinery_turn.gate_failed",
      );
    });
  }

  private async runMachineryTurnGate(
    event: MissionControlEvent,
    labelsOverride?: Record<string, string> | null,
  ): Promise<void> {
    if (!(await this.shouldDispatchMachineryTurn(event, labelsOverride))) {
      return;
    }
    const dispatched = await this.isDispatchedByLabels(
      labelsOverride ?? (await this.agentLabels(event.agentId)),
    );
    if (this.centralConfig.get().mode !== "auto" && !dispatched) {
      return;
    }
    if (dispatched && !this.claimMachineryTurnSlot(event)) {
      return;
    }
    try {
      await this.dispatchMachineryTurn(event);
    } catch (error) {
      this.logger.warn(
        { err: error, eventId: event.id, kind: event.kind, agentId: event.agentId },
        "mission_control.machinery_turn.dispatch_failed",
      );
    }
  }

  /**
   * Whether the Commander dispatched this agent: spawned via fleet_create_agent
   * (label paseo.parent-agent-id pointing at a Commander-labeled agent) or
   * adopted via a delivered fleet_send_prompt (paseo.commander-adopted-at).
   * Live labels first, then the durable stored record (the marker must
   * survive reloads and agent restarts — same fallback as the Commander
   * identity check).
   */
  /**
   * Whether the given worker labels mark the agent as Commander-dispatched:
   * spawned via fleet_create_agent (label paseo.parent-agent-id pointing at a
   * Commander-labeled agent) or adopted via a delivered fleet_send_prompt
   * (paseo.commander-adopted-at). Used by the local gate with the worker's
   * OWN labels AND by the forwarded-event gate with the labels that rode the
   * mission_control.event.forward payload (the commander host has no local
   * record of a peer-host worker, but the parent check still resolves — the
   * parent is the commander agent, which lives HERE).
   */
  private async isDispatchedByLabels(labels: Record<string, string> | null): Promise<boolean> {
    const parentAgentId = getParentAgentIdFromLabels(labels);
    if (parentAgentId) {
      const parentLabels = await this.agentLabels(parentAgentId);
      if (parentLabels?.[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE) {
        return true;
      }
    }
    const adoptedAt = labels?.[COMMANDER_ADOPTED_AT_LABEL];
    return typeof adoptedAt === "string" && adoptedAt.trim().length > 0;
  }

  /** Live labels first, then the durable stored record. */
  private async agentLabels(agentId: string): Promise<Record<string, string> | null> {
    const live = this.agentManager.getAgent(agentId);
    if (live?.labels) {
      return live.labels;
    }
    const record = await this.agentStorage.get(agentId).catch(() => null);
    return record?.labels ?? null;
  }

  /**
   * One follow-up machinery turn per agent per run epoch: terminal events
   * share one slot per epoch, verdicts another (a verifier retry posting a
   * second insufficient verdict must not re-alert the Commander). Claims the
   * slot before dispatch — one attempt per epoch, mirroring the run-record
   * dedupe state. The classic needs-you triggers (blocked/stalled) keep their
   * own guards and never claim a slot.
   */
  private claimMachineryTurnSlot(event: MissionControlEvent): boolean {
    if (
      event.kind !== "finished" &&
      event.kind !== "failed" &&
      event.kind !== "interrupted" &&
      event.kind !== "verdict"
    ) {
      return true;
    }
    const namespace = event.kind === "verdict" ? "verdict" : "terminal";
    const key = `${event.agentId}:${event.runEpoch ?? 0}:${namespace}`;
    if (this.machineryTurnedRunEpochs.has(key)) {
      return false;
    }
    this.machineryTurnedRunEpochs.add(key);
    if (this.machineryTurnedRunEpochs.size > MACHINERY_TURN_RUN_DEDUPE_CAP) {
      const first = this.machineryTurnedRunEpochs.values().next().value;
      if (typeof first === "string") {
        this.machineryTurnedRunEpochs.delete(first);
      }
    }
    return true;
  }

  private async dispatchMachineryTurn(event: MissionControlEvent): Promise<void> {
    const commanderId = await this.resolveCommanderAgentId();
    if (!commanderId) {
      this.logger.debug(
        { eventId: event.id, kind: event.kind },
        "mission_control.machinery_turn.no_commander",
      );
      return;
    }
    if (event.agentId === commanderId) {
      // The Commander's own card (e.g. a failed spawn) must not be messaged
      // back to itself — events the Commander's own follow-up produces about
      // ITSELF never re-trigger a machinery turn.
      return;
    }
    await dispatchLocalPromptMode({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId: commanderId,
      prompt: buildMachineryTurnMessage(
        event,
        this.serverId,
        this.hostName,
        this.machineryTurnExtras(event),
      ),
      mode: "steer",
      classification: "machinery",
      replaceOrigin: "machinery",
      recordStopOrigin: (agentId, origin) => this.store.recordStopOrigin(agentId, origin),
      logger: this.logger,
      onOutOfBandSteer: () => {
        this.armSteerDeliveryVerification(commanderId, undefined);
      },
    });
    this.logger.info(
      { eventId: event.id, kind: event.kind, agentId: event.agentId },
      "mission_control.machinery_turn.dispatched",
    );
  }

  /**
   * Follow-up message extras: the worker's last report_status headline and
   * (when present) the verdict line, so the Commander can decide the
   * follow-up without a look-up round trip.
   */
  private machineryTurnExtras(event: MissionControlEvent): {
    lastReportHeadline?: string;
    verdictLine?: string;
  } {
    const lastReportHeadline = this.lastSelfReportHeadline(event.agentId);
    const verdict = this.store.getReviewState(event.agentId).verdict;
    let verdictLine: string | undefined;
    if (verdict) {
      verdictLine = `Verdict: ${verdict.summary} (by ${verdict.by})`;
    } else if (event.kind === "verdict" && event.detail?.trim()) {
      verdictLine = `Verdict: ${event.detail.trim()}`;
    }
    return {
      ...(lastReportHeadline ? { lastReportHeadline } : {}),
      ...(verdictLine ? { verdictLine } : {}),
    };
  }

  /** Headline of the agent's most recent report_status self-report, if any. */
  private lastSelfReportHeadline(agentId: string): string | null {
    for (const event of this.store.fetchEvents({ includeSuperseded: true })) {
      if (event.agentId === agentId && event.source === "self") {
        return event.headline;
      }
    }
    return null;
  }

  // --- M9 cross-host event forwarding (docs/commander.md "Runtime model") ---

  /**
   * Forward a terminal event to the commander host over peering
   * (mission_control.event.forward) when THIS daemon is NOT the commander
   * host and the event's agent is one the Commander dispatched (labeled
   * paseo.parent-agent-id or paseo.commander-adopted-at — the parent record
   * lives on the commander host, so presence is the forward-side test). The
   * commander host runs its machinery-turn gate with the worker's labels from
   * the payload (it has no local record of a peer-host worker). Fire-and-
   * forget and advisory: an unreachable commander host is a warn + drop,
   * never a retry queue in v1.
   */
  private maybeForwardTerminalEventToCommander(event: MissionControlEvent): void {
    void this.runForwardTerminalEventToCommander(event).catch((error) => {
      this.logger.warn(
        { err: error, eventId: event.id, kind: event.kind },
        "mission_control.event_forward.gate_failed",
      );
    });
  }

  private async runForwardTerminalEventToCommander(event: MissionControlEvent): Promise<void> {
    if (
      event.kind !== "finished" &&
      event.kind !== "failed" &&
      event.kind !== "interrupted" &&
      event.kind !== "verdict"
    ) {
      return;
    }
    const designated = this.centralConfig.get().commanderHost?.trim() || null;
    if (designated === null || this.isThisCommanderHost(designated)) {
      return;
    }
    const labels = await this.agentLabels(event.agentId);
    if (!labels || !hasCommanderDispatchMarker(labels)) {
      return;
    }
    await this.forwardEventToCommander(designated, event, labels);
  }

  private async forwardEventToCommander(
    commanderHost: string,
    event: MissionControlEvent,
    labels: Record<string, string>,
  ): Promise<void> {
    const peerManager = this.resolvePeerManager();
    const peerStatus = peerManager?.getPeerStatus(commanderHost) ?? null;
    const peerClient = peerManager?.getPeerClient(commanderHost) ?? null;
    if (!peerStatus || peerStatus.state !== "online" || !peerClient) {
      // Machinery is advisory: unreachable commander host → warn + drop.
      this.logger.warn(
        {
          commanderHost,
          state: peerStatus?.state ?? "not-configured",
          eventId: event.id,
          kind: event.kind,
          agentId: event.agentId,
        },
        "mission_control.event_forward.commander_unreachable",
      );
      return;
    }
    try {
      const payload = await peerClient.missionControlEventForward({ event, labels });
      if (!payload.ok) {
        this.logger.warn(
          { commanderHost, eventId: event.id, error: payload.error },
          "mission_control.event_forward.rejected",
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, commanderHost, eventId: event.id },
        "mission_control.event_forward.failed",
      );
    }
  }

  /**
   * Ingest a terminal event forwarded by a NON-commander host over peering
   * (mission_control.event.forward — the session handler routes here). The
   * worker's labels ride the payload so the machinery-turn gate can decide
   * without a local record of the worker (the parent-commander check still
   * resolves: the parent is the commander agent, which lives HERE). The event
   * is NEVER written to this host's events store — the feed aggregates
   * per-host via the app — and never re-broadcast; only the gate consumes it.
   */
  async ingestForwardedEvent(input: {
    event: MissionControlEvent;
    labels: Record<string, string> | null;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    this.maybeDispatchMachineryTurn(input.event, input.labels ?? {});
    return { ok: true };
  }

  /** Proposal cards ride the feed as kind:"proposal" events. */
  private async emitProposalEvent(proposal: MissionControlProposal): Promise<MissionControlEvent> {
    const pending = proposal.status === "pending";
    // Meta-kind proposals may target fleet objects rather than an agent
    // (rename/archive project·workspace, create project, promote): their
    // targetAgentId is "" by convention. The card still needs a real event
    // identity — fall back to the Commander (the origin of these cards) so
    // the feed resolves a live agent title and drill-in works.
    let agentId = proposal.targetAgentId;
    if (proposal.kind === "meta" && !agentId) {
      agentId = (await this.resolveCommanderAgentId()) ?? agentId;
    }
    return this.emitEvent({
      agentId,
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
    });
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
 * Result of an ownership-aware central-config write (patchCentralConfigRouted
 * / setModeRouted). ok:true config is the resolved config (from this daemon
 * when it is the owner, or the commander host's response when forwarded);
 * ok:false means the write was NOT applied anywhere — unreachableCommanderHost
 * names the host the forward failed on (additive wire field). The config
 * rides the wire as the optional-keyed MissionControlCentralConfig shape
 * (resolved configs are assignable to it; the app resolves defaults again at
 * the RPC boundary).
 */
export type CentralConfigWriteResult =
  | {
      ok: true;
      config: MissionControlCentralConfig;
    }
  | {
      ok: false;
      error: string;
      /** The local (unchanged) resolved snapshot, for the wire response. */
      config: MissionControlCentralConfig;
      unreachableCommanderHost?: string;
    };

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

/**
 * Forward-side dispatched-worker test (M9): the worker carries
 * paseo.parent-agent-id (its parent record — the commander agent — lives on
 * the commander host, so presence is the test here, not a parent-labels
 * lookup) or paseo.commander-adopted-at. The commander host re-checks with
 * the full gate (parent labels resolve there).
 */
function hasCommanderDispatchMarker(labels: Record<string, string>): boolean {
  return (
    getParentAgentIdFromLabels(labels) !== null ||
    typeof labels[COMMANDER_ADOPTED_AT_LABEL] === "string"
  );
}

function hasExclusionLabels(labels: Record<string, string>): boolean {
  // System-owned (Commander/verifiers/machinery) via the one shared
  // predicate; History Ask parentage is a separate exclusion signal.
  if (isSystemOwnedAgentLabels(labels)) {
    return true;
  }
  return PARENT_AGENT_ID_LABEL in labels;
}
