import type { Logger } from "pino";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  MissionControlEvent,
  MissionControlEventKind,
  MissionControlProof,
} from "@getpaseo/protocol/mission-control/types";

import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  formatSystemNotificationPrompt,
  startAgentRun,
  waitForAgentRunStartWithTimeout,
} from "../agent/agent-prompt.js";

const COMMANDER_LABEL = "paseo.mission-control";
const COMMANDER_LABEL_VALUE = "commander";
const DIGEST_SWEEP_INTERVAL_MS = 30_000;
// notifyOnFinish already tells the Commander about its own subagents, so these
// events would duplicate the direct notification.
const PARENT_NOTIFIED_DIGEST_KINDS: Partial<Record<MissionControlEventKind, true>> = {
  finished: true,
  failed: true,
};
// The orchestrator reminder used to ride every digest body; v3 moved it into
// the Commander's static system prompt — never in message bodies again.

// Ack suppression (spec): digests instruct no prose when nothing needs action;
// the daemon drops single-token pure-ack replies (isPureAckReply) from the
// visible thread.
const DIGEST_NO_PROSE_INSTRUCTION =
  'If this digest needs no action from you, reply with a single short acknowledgment token (for example "ok") and nothing else. No summaries, no narration.';

// Ack suppression: a digest-initiated run that answers with pure
// acknowledgment (no question, proposal, or tool call) is retracted from the
// visible thread. Replies to user-prompted turns are never classified.
const ACK_DROP_EXACT_TOKENS: ReadonlySet<string> = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "ack",
  "acknowledged",
  "got it",
  "roger",
  "understood",
  "noted",
  "done",
  "sounds good",
  "will do",
  "sure",
  "yep",
  "yes",
  "fine",
  "10-4",
  "👍",
  "👌",
  "✅",
]);
const ACK_DROP_NO_ACTION_PHRASES: readonly string[] = [
  "no action needed",
  "no action required",
  "nothing to do",
  "nothing needs action",
  "nothing to report",
  "nothing actionable",
  "no changes needed",
  "all clear",
  "nothing new",
  "no updates",
];
// Offers to act, plans, or open-ended remarks are proposals, never acks.
const ACK_DROP_PROPOSAL_PATTERN =
  /\b(should i|shall i|want me to|can i|i can|i will|i'll|i'd|let me|do you want|i could|i might|propose|suggest|plan|happy to|ready to)\b/i;

export interface MissionControlDigestOrigin {
  serverId: string;
  hostName: string;
}

interface BufferedMissionControlEvent {
  event: MissionControlEvent;
  origin: MissionControlDigestOrigin;
}

/**
 * The Commander turn a digest dispatch initiated, tracked so only its reply is
 * a candidate for ack suppression. User-prompted turns are never tracked.
 */
interface AckDropTurn {
  commanderId: string;
  turnId: string | null;
  assistantRows: Array<{ seq: number; text: string }>;
  toolCallSeen: boolean;
}

/**
 * Pure-ack heuristic (spec Edge cases): true only for a short reply that
 * acknowledges without action. Never true for replies containing a question,
 * a proposal/offer to act, or structured/tool-call-ish content. Tool calls are
 * additionally excluded at the turn level by the caller.
 */
export function isPureAckReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("?")) {
    return false;
  }
  if (trimmed.includes("\n")) {
    return false;
  }
  if (trimmed.length > 60) {
    return false;
  }
  if (trimmed.startsWith("<") || trimmed.includes("```") || trimmed.includes("`")) {
    return false;
  }
  if (ACK_DROP_PROPOSAL_PATTERN.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.replace(/[.!]+$/g, "").toLowerCase();
  if (ACK_DROP_EXACT_TOKENS.has(normalized)) {
    return true;
  }
  return ACK_DROP_NO_ACTION_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * Narrow surface PeerSlice and MissionControlService depend on, so they stay
 * decoupled from the digest internals.
 */
export interface MissionControlDigestSink {
  enqueue(event: MissionControlEvent, origin: MissionControlDigestOrigin): void;
}

/**
 * Supplies the fleet-context block for digest bodies. Implemented by
 * mission-control/context.ts; the digest stays agnostic of how the context is
 * assembled. `fresh` requests a full snapshot instead of a delta — used after
 * omp compaction or a session restart wiped the launch-time context pack.
 * Null block = nothing to say (no change, or context unavailable).
 */
export interface MissionControlDigestContextProvider {
  deltaBlock(fresh?: boolean): Promise<string | null>;
}

export interface MissionControlDigestOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  contextProvider?: MissionControlDigestContextProvider | null;
}

/**
 * Batches fleet events and delivers them to the Commander as one
 * <paseo-system> digest whenever the Commander is idle. Never interrupts: the
 * digest goes out through startAgentRun with replaceRunning:false, and a
 * dispatch that races a user prompt leaves the buffer untouched.
 */
export class MissionControlDigest implements MissionControlDigestSink {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;
  private readonly contextProvider: MissionControlDigestContextProvider | null;

  private buffer: BufferedMissionControlEvent[] = [];
  private commanderId: string | null = null;
  private unsubscribeCommander: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  /** True between a successful digest dispatch and the digest turn's terminal event. */
  private ackDropArmed = false;
  private ackDropTurn: AckDropTurn | null = null;
  /**
   * Commander session marker tracking: when the session id changes (restart)
   * or a compaction event passes on the stream, the launch-time context pack
   * is gone and the next digest re-injects a full snapshot instead of a delta.
   */
  private lastSessionId: string | null = null;
  private snapshotNeeded = false;

  constructor(options: MissionControlDigestOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ module: "mission-control-digest" });
    this.contextProvider = options.contextProvider ?? null;
  }

  start(): void {
    if (this.sweepTimer) {
      return;
    }
    const timer = setInterval(() => {
      this.maybeFlush();
    }, DIGEST_SWEEP_INTERVAL_MS);
    // Node's Timeout unrefs so the sweep never keeps the daemon alive.
    const nodeTimer = timer as unknown as { unref?: () => void };
    nodeTimer.unref?.();
    this.sweepTimer = timer;
    this.maybeFlush();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.unsubscribeCommander?.();
    this.unsubscribeCommander = null;
    this.commanderId = null;
    this.ackDropArmed = false;
    this.ackDropTurn = null;
  }

  enqueue(event: MissionControlEvent, origin: MissionControlDigestOrigin): void {
    this.buffer.push({ event, origin });
    this.maybeFlush();
  }

  private maybeFlush(): void {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    void this.flushOnce()
      .catch((error) => {
        this.logger.error({ err: error }, "mission_control.digest.flush_failed");
      })
      .finally(() => {
        this.flushing = false;
      });
  }

  private async flushOnce(): Promise<void> {
    const commanderId = await this.discoverCommanderId();
    this.syncCommanderSubscription(commanderId);
    if (!commanderId) {
      return;
    }
    const commander = this.agentManager.getAgent(commanderId);
    if (!commander || commander.lifecycle !== "idle") {
      return;
    }
    if (this.agentManager.hasInFlightRun(commanderId)) {
      return;
    }
    // A changed provider session id means the conversation was restarted and
    // the launch-time context pack is gone — the next digest must re-inject it.
    const sessionId = commander.persistence?.sessionId ?? null;
    if (this.lastSessionId !== null && sessionId !== null && sessionId !== this.lastSessionId) {
      this.snapshotNeeded = true;
    }
    this.lastSessionId = sessionId;
    if (this.buffer.length === 0) {
      return;
    }

    const digestItems = await this.selectDigestItems(commanderId);
    if (digestItems.length === 0) {
      this.buffer = [];
      return;
    }

    const fresh = this.snapshotNeeded;
    this.snapshotNeeded = false;
    const contextBlock = this.contextProvider ? await this.contextProvider.deltaBlock(fresh) : null;
    const prompt = formatSystemNotificationPrompt(buildDigestBody(digestItems, contextBlock));
    // Arm before dispatch: the Commander was verified idle with no in-flight
    // run, so the next turn_started observed belongs to this digest. Any
    // dispatch failure below disarms again.
    this.ackDropArmed = true;
    try {
      const dispatched = await startAgentRun(this.agentManager, commanderId, prompt, this.logger, {
        replaceRunning: false,
      });
      if (dispatched.outOfBand) {
        // Matched an out-of-band handler (e.g. /goal pause) — no run started.
        this.ackDropArmed = false;
        return;
      }
      // startAgentRun resolves before the turn is accepted; wait so a dispatch
      // that raced a user prompt is detected and the buffer kept.
      await waitForAgentRunStartWithTimeout(this.agentManager, commanderId);
    } catch (error) {
      // The dispatch raced a user prompt or the Commander closed. Never
      // interrupt — the events wait for the next quiet window.
      this.ackDropArmed = false;
      this.ackDropTurn = null;
      this.snapshotNeeded = fresh || this.snapshotNeeded;
      this.logger.warn(
        { err: error, agentId: commanderId, eventCount: digestItems.length },
        "mission_control.digest.dispatch_deferred",
      );
      return;
    }

    this.buffer = [];
    this.logger.info(
      { agentId: commanderId, eventCount: digestItems.length },
      "mission_control.digest.flushed",
    );
    this.armAttentionClear(commanderId);
  }

  /**
   * The Commander is the agent labeled paseo.mission-control=commander, live or
   * stored. A closed Commander cannot receive digests, but its id is still
   * subscribed to so a later resume is picked up.
   */
  private async discoverCommanderId(): Promise<string | null> {
    for (const agent of this.agentManager.listAgents()) {
      if (agent.labels[COMMANDER_LABEL] === COMMANDER_LABEL_VALUE) {
        return agent.id;
      }
    }
    const records = await this.agentStorage.list();
    const stored = records.find(
      (record) => !record.archivedAt && record.labels[COMMANDER_LABEL] === COMMANDER_LABEL_VALUE,
    );
    return stored?.id ?? null;
  }

  private syncCommanderSubscription(commanderId: string | null): void {
    if (this.commanderId === commanderId) {
      return;
    }
    this.unsubscribeCommander?.();
    this.unsubscribeCommander = null;
    this.commanderId = commanderId;
    if (!commanderId) {
      return;
    }
    this.unsubscribeCommander = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === commanderId) {
          this.maybeFlush();
          return;
        }
        if (event.type === "agent_stream" && event.agentId === commanderId) {
          this.handleCommanderStream(event);
        }
      },
      { agentId: commanderId },
    );
  }

  /**
   * Tracks the digest-initiated Commander turn so a pure-ack reply can be
   * retracted from the visible thread. Only turns started while
   * `ackDropArmed` (i.e. dispatched by this digest) are candidates — user
   * turns never are.
   */
  private handleCommanderStream(event: Extract<AgentManagerEvent, { type: "agent_stream" }>): void {
    const streamEvent = event.event;
    if (streamEvent.type === "timeline" && streamEvent.item.type === "compaction") {
      // The Commander's conversation was compacted — the launch-time context
      // pack is summarized away; re-inject a fresh snapshot on the next digest.
      this.snapshotNeeded = true;
    }
    if (streamEvent.type === "turn_started") {
      if (this.ackDropArmed && !this.ackDropTurn && this.commanderId) {
        this.ackDropTurn = {
          commanderId: this.commanderId,
          turnId: streamEvent.turnId ?? null,
          assistantRows: [],
          toolCallSeen: false,
        };
      }
      return;
    }
    const turn = this.ackDropTurn;
    if (!turn) {
      return;
    }
    if (streamEvent.type === "timeline") {
      const item = streamEvent.item;
      if (item.type === "assistant_message" && event.seq !== undefined) {
        turn.assistantRows.push({ seq: event.seq, text: item.text });
      } else if (item.type === "tool_call") {
        turn.toolCallSeen = true;
      }
      return;
    }
    if (streamEvent.type === "turn_completed") {
      void this.finalizeAckDropTurn(turn);
      return;
    }
    if (streamEvent.type === "turn_failed" || streamEvent.type === "turn_canceled") {
      // The digest turn did not complete normally: never classify a partial
      // reply as an ack.
      this.ackDropTurn = null;
      this.ackDropArmed = false;
    }
  }

  /**
   * Classifies the digest turn's final assistant text and, when it is a pure
   * ack (no question, proposal, or tool call), retracts it from the committed
   * timeline and logs the drop.
   */
  private async finalizeAckDropTurn(turn: AckDropTurn): Promise<void> {
    this.ackDropTurn = null;
    this.ackDropArmed = false;
    if (turn.toolCallSeen || turn.assistantRows.length === 0) {
      return;
    }
    const text = turn.assistantRows
      .map((row) => row.text)
      .join("")
      .trim();
    if (!isPureAckReply(text)) {
      return;
    }
    const seqs = turn.assistantRows.map((row) => row.seq);
    this.logger.info(
      { component: "digest", agentId: turn.commanderId, seqs, text },
      "mission_control.digest.ack_drop",
    );
    await this.agentManager
      .removeTimelineRows(turn.commanderId, seqs, "ack-drop")
      .catch((error) => {
        this.logger.warn(
          { err: error, component: "digest", agentId: turn.commanderId, seqs },
          "mission_control.digest.ack_drop_retract_failed",
        );
      });
  }

  private async selectDigestItems(commanderId: string): Promise<BufferedMissionControlEvent[]> {
    const parentLookup = new Map<string, boolean>();
    const selected: BufferedMissionControlEvent[] = [];
    for (const entry of this.buffer) {
      if (
        PARENT_NOTIFIED_DIGEST_KINDS[entry.event.kind] &&
        (await this.isCommanderChild(entry.event.agentId, commanderId, parentLookup))
      ) {
        continue;
      }
      selected.push(entry);
    }
    return selected;
  }

  private async isCommanderChild(
    agentId: string,
    commanderId: string,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    const cached = cache.get(agentId);
    if (cached !== undefined) {
      return cached;
    }
    const live = this.agentManager.getAgent(agentId);
    const stored = await this.agentStorage.get(agentId);
    const parentAgentId =
      getParentAgentIdFromLabels(live?.labels) ?? getParentAgentIdFromLabels(stored?.labels);
    const result = parentAgentId === commanderId;
    cache.set(agentId, result);
    return result;
  }

  /**
   * A digest-triggered run settles to idle through the same transition that
   * flags an agent as needing attention, so clear it once the run we dispatched
   * finishes. Runs the user starts themselves are not affected: this watcher is
   * armed only after a successful digest dispatch.
   */
  private armAttentionClear(agentId: string): void {
    const unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state" || event.agent.id !== agentId) {
          return;
        }
        if (event.agent.lifecycle === "idle" || event.agent.lifecycle === "error") {
          unsubscribe();
          void this.agentManager.clearAgentAttention(agentId).catch((error) => {
            this.logger.warn(
              { err: error, agentId },
              "mission_control.digest.attention_clear_failed",
            );
          });
        }
      },
      // No replay: the Commander is still idle when the watcher arms, and the
      // terminal transition of the dispatched run must not be mistaken for it.
      { agentId, replayState: false },
    );
  }
}

function buildDigestBody(
  entries: readonly BufferedMissionControlEvent[],
  contextBlock: string | null,
): string {
  const noun = entries.length === 1 ? "event" : "events";
  const lines = entries.map(({ event, origin }) => {
    const link = `paseo://h/${origin.serverId}/agent/${event.agentId}`;
    const line = `- [${event.kind}] ${event.headline} — ${event.agentTitle} (${origin.hostName}) — ${link}`;
    const detail = event.detail ? `\n  ${event.detail}` : "";
    const proofs = (event.proof ?? [])
      .map((proof) => `\n  proof: ${formatDigestProof(proof)}`)
      .join("");
    return `${line}${detail}${proofs}`;
  });
  const body = `Fleet digest: ${entries.length} ${noun}.\n\n${lines.join("\n")}`;
  const prefixed = contextBlock ? `${contextBlock}\n\n${body}` : body;
  return `${prefixed}\n\n${DIGEST_NO_PROSE_INSTRUCTION}`;
}

function formatDigestProof(proof: MissionControlProof): string {
  const label = proof.label ?? proof.kind;
  const target = proof.url ?? proof.path;
  if (target) {
    return `${label}: ${target}`;
  }
  if ("excerpt" in proof && typeof proof.excerpt === "string" && proof.excerpt.trim()) {
    const trimmed = proof.excerpt.trim();
    return `${label}: ${trimmed.length > 100 ? `${trimmed.slice(0, 100)}…` : trimmed}`;
  }
  return label;
}
