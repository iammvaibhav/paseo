import type { Logger } from "pino";

import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";

// Ack suppression (spec): machinery-initiated Commander turns instruct no
// prose when nothing needs action; the daemon drops single-token pure-ack
// replies (isPureAckReply) from the visible thread. Replies to user-prompted
// turns are never classified.
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

// Multi-clause acknowledgments ("Acknowledged — fleet snapshot received.
// Standing by.") are also pure acks when they only state receipt + readiness:
// an ack lead, an optional neutral clause, a standby/readiness tail, and no
// action/decision language anywhere. The length cap is 120 chars (higher than
// the single-token path) because the regex shape itself is the guard.
const ACK_DROP_STANDBY_PATTERN =
  /^(acknowledged|ack|received|understood|noted|got it|roger|ok|okay|confirmed)\b[^?!\n]{0,90}\b(standing by|standing-by|on standby|awaiting|ready)\b\.?$/i;
const ACK_DROP_ACTION_PATTERN =
  /\b(dispatch|spawn|send|sent|creat|assign|recover|escalat|nudge|verif|contact|investigat|fix|build|deploy|start|continu|task|rout|handle|work|will|would|should|plan|propos|suggest|next|need|must|going|gonna|about)/i;

const ARM_TTL_MS = 600_000;

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
  if (trimmed.startsWith("<") || trimmed.includes("```") || trimmed.includes("`")) {
    return false;
  }
  if (ACK_DROP_PROPOSAL_PATTERN.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.replace(/[.!]+$/g, "").toLowerCase();
  if (normalized.length <= 60) {
    if (ACK_DROP_EXACT_TOKENS.has(normalized)) {
      return true;
    }
    if (ACK_DROP_NO_ACTION_PHRASES.some((phrase) => normalized.includes(phrase))) {
      return true;
    }
  }
  if (trimmed.length <= 120) {
    return ACK_DROP_STANDBY_PATTERN.test(trimmed) && !ACK_DROP_ACTION_PATTERN.test(trimmed);
  }
  return false;
}

/**
 * The Commander turn a machinery dispatch initiated, tracked so only its reply
 * is a candidate for ack suppression. User-prompted turns are never tracked.
 */
interface AckDropTurn {
  commanderId: string;
  turnId: string | null;
  assistantRows: Array<{ seq: number; text: string }>;
  toolCallSeen: boolean;
}

export interface CommanderAckDropOptions {
  agentManager: AgentManager;
  logger: Logger;
}

/**
 * Retracts pure-ack replies from machinery-initiated Commander turns
 * (spec Commander: "Retraction must fire on EVERY machinery dispatch path").
 * The CommanderSnapshotInjector owns one instance and arms it for the
 * snapshot's own turn (a state-only turn whose reply is a single
 * acknowledgment token); the injector's armLaunchTurn covers the launch-time
 * first turn. Arming is one-shot: only the first turn_started after `arm()`
 * is classified, so a user-prompted turn that races the dispatch is never
 * dropped. An armed dispatch that never starts a turn (out-of-band steer to
 * a busy Commander, dispatch failure) expires when the in-flight turn
 * settles. (COMPAT: the digest-era shared arming for the approvals delivery
 * path was removed with the digest queue — with per-turn snapshot injection
 * the delivered turn's own reply is never classified.)
 *
 * The guard is `isPureAckReply` + turn-level tool-call tracking: replies
 * containing a question, a proposal/offer to act, or any tool call are never
 * dropped.
 */
export class CommanderAckDrop {
  private readonly agentManager: AgentManager;
  private readonly logger: Logger;
  private commanderId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private armed = false;
  private armedAtMs = 0;
  private turn: AckDropTurn | null = null;

  constructor(options: CommanderAckDropOptions) {
    this.agentManager = options.agentManager;
    this.logger = options.logger;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** Subscribe to the Commander's stream so armed dispatches can be tracked. */
  attach(commanderId: string | null): void {
    if (this.commanderId === commanderId) {
      return;
    }
    const wasArmed = this.armed;
    const armedAt = this.armedAtMs;
    this.detach();
    this.commanderId = commanderId;
    if (wasArmed) {
      this.armed = true;
      this.armedAtMs = armedAt;
    }
    if (!commanderId) {
      return;
    }
    this.unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.agentId === commanderId) {
          this.handleStream(event);
        }
      },
      { agentId: commanderId },
    );
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.commanderId = null;
    this.armed = false;
    this.armedAtMs = 0;
    this.turn = null;
  }

  /**
   * Mark the next Commander turn as machinery-initiated (ack-classifiable).
   * One-shot: the armed flag clears as soon as a turn is captured, so later
   * user-prompted turns are never classified.
   */
  arm(): void {
    this.armed = true;
    this.armedAtMs = Date.now();
  }

  /**
   * Stop ack-classification: clears a pending arm AND drops a machinery turn
   * already being tracked. Used when the turn is no longer machinery-only —
   * the mailbox steers the user message into the snapshot turn, so its reply
   * is real content, never a retractable ack — and when a dispatch failed
   * before its turn started.
   */
  disarm(): void {
    this.armed = false;
    this.turn = null;
  }

  private handleStream(event: Extract<AgentManagerEvent, { type: "agent_stream" }>): void {
    const streamEvent = event.event;
    if (streamEvent.type === "turn_started") {
      if (this.armed && !this.turn && this.commanderId) {
        if (Date.now() - this.armedAtMs > ARM_TTL_MS) {
          this.armed = false;
        } else {
          this.armed = false;
          this.turn = {
            commanderId: this.commanderId,
            turnId: streamEvent.turnId ?? null,
            assistantRows: [],
            toolCallSeen: false,
          };
        }
      }
    }
    const turn = this.turn;
    if (!turn) {
      // An armed dispatch that never started a turn (out-of-band steer to a
      // busy Commander, dispatch racing a user prompt) must not classify the
      // next turn: expire the arm when the in-flight turn settles.
      if (
        this.armed &&
        (streamEvent.type === "turn_completed" ||
          streamEvent.type === "turn_failed" ||
          streamEvent.type === "turn_canceled")
      ) {
        this.armed = false;
      }
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
      void this.finalizeTurn(turn);
      return;
    }
    if (streamEvent.type === "turn_failed" || streamEvent.type === "turn_canceled") {
      // The machinery turn did not complete normally: never classify a partial
      // reply as an ack.
      this.turn = null;
      this.armed = false;
    }
  }

  /**
   * Classifies the machinery turn's final assistant text and, when it is a
   * pure ack (no question, proposal, or tool call), retracts it from the
   * committed timeline and logs the drop.
   */
  private async finalizeTurn(turn: AckDropTurn): Promise<void> {
    this.turn = null;
    this.armed = false;
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
      { component: "machinery", agentId: turn.commanderId, seqs, text },
      "mission_control.machinery.ack_drop",
    );
    await this.agentManager
      .removeTimelineRows(turn.commanderId, seqs, "ack-drop")
      .catch((error) => {
        this.logger.warn(
          { err: error, component: "machinery", agentId: turn.commanderId, seqs },
          "mission_control.machinery.ack_drop_retract_failed",
        );
      });
  }
}
