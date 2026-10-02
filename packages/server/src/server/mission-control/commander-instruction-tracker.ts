import { isPureAckReply } from "./commander-ack-drop.js";

/**
 * A finalized delivery window: the instruction ids that were tracked into the
 * completed turn, plus the turn's assistant prose joined in seq order ("" when
 * the window produced no answer prose).
 */
export interface CommanderTurnSnapshot {
  ids: string[];
  text: string;
}

/**
 * Per-Commander instruction-ledger fallback state machine (M8): tracks ONLY
 * instruction ids actually delivered into a Commander turn, so a turn
 * completion that answered in plain prose — without a citing post_answer /
 * clarify / proposal card — still closes its ledger rows via synthesized
 * answer cards. Genuine citing cards close their rows in the store first; the
 * finalize step re-checks the store's open set, so this never duplicates a
 * real card.
 *
 * Window model:
 * - stage(): the id is staged right after the ledger row opens, BEFORE any
 *   async dispatch. The returned rollback unstages it (delivery failure: the
 *   ledger row stays open, the tracker forgets the id).
 * - turn_started(): pending ids bind to the active turn; the assistant-row
 *   window resets so rows from a previous window never leak into the next.
 * - assistant rows accumulate in seq order (the same ordered-join convention
 *   CommanderAckDrop uses for a turn's reply).
 * - turn_completed(): the window finalizes — active ∪ pending are the ids the
 *   completed turn owed an answer for. State clears; the caller filters the
 *   ids against the store's open set and synthesizes one card per still-open
 *   id. A completed turn whose prose is empty or a pure ack (the ack-drop
 *   retracts acks — they are not content) synthesizes nothing and drops the
 *   ids: the rows stay open and the per-turn envelope re-lists them.
 * - turn_failed()/turn_canceled(): ids stay pending for the next
 *   delivery/recovery window; the failed turn's prose is dropped (it is not a
 *   completed answer) and nothing is ever synthesized without a completed
 *   turn.
 *
 * Rows accumulate whether or not a turn_started was observed (the service can
 * attach mid-turn): the completion always unions active + pending, so a
 * mid-turn attach still covers its staged ids. Machinery turns with no staged
 * ids finalize to nothing and are never mistaken for instruction deliveries.
 */
export class CommanderInstructionTracker {
  /** Staged before the current turn (delivery dispatched, turn not yet observed). */
  private readonly pending = new Set<string>();
  /** Bound to the current turn (turn_started observed, completion not yet). */
  private readonly active = new Set<string>();
  /** Assistant rows of the current window, in arrival order (= seq order). */
  private readonly rows: Array<{ seq: number; text: string }> = [];
  /** A turn_started has opened the current window. */
  private turnActive = false;

  /** True when any ids are tracked (pending or active). */
  get hasTrackedIds(): boolean {
    return this.pending.size > 0 || this.active.size > 0;
  }

  /**
   * Stage delivered instruction ids. Call immediately after the ledger rows
   * open and before any async dispatch. `intoActiveTurn` adds directly to the
   * active turn when one is open (a busy live-steer joins the in-flight turn,
   * so that turn's completion must cover the id). Returns a rollback that
   * unstages the ids — delivery failure must forget the tracker state while
   * leaving the ledger rows open.
   */
  stage(ids: string[], options?: { intoActiveTurn?: boolean }): () => void {
    const target = options?.intoActiveTurn === true && this.turnActive ? this.active : this.pending;
    for (const id of ids) {
      target.add(id);
    }
    return () => {
      for (const id of ids) {
        this.pending.delete(id);
        this.active.delete(id);
      }
    };
  }

  /** turn_started: bind pending ids to the active turn, open a fresh window. */
  turnStarted(): void {
    if (this.pending.size > 0) {
      for (const id of this.pending) {
        this.active.add(id);
      }
      this.pending.clear();
    }
    this.turnActive = true;
    this.rows.length = 0;
  }

  /** assistant_message timeline row, appended in seq order. */
  assistantRow(seq: number, text: string): void {
    this.rows.push({ seq, text });
  }

  /**
   * turn_completed: consume the window. Returns the ids the completed turn
   * owed answers for plus its ordered-joined prose — or null when there is
   * nothing to synthesize (no tracked ids, or the prose is empty / a pure ack,
   * which is not an answer). State always clears; ids whose turn produced no
   * usable prose are NOT carried forward (their rows stay open and the
   * envelope re-lists them for the Commander's next turn).
   */
  complete(): CommanderTurnSnapshot | null {
    const ids = Array.from(new Set([...this.active, ...this.pending]));
    const text = [...this.rows]
      .sort((left, right) => left.seq - right.seq)
      .map((row) => row.text)
      .join("")
      .trim();
    this.active.clear();
    this.pending.clear();
    this.rows.length = 0;
    this.turnActive = false;
    if (ids.length === 0) {
      return null;
    }
    if (text.length === 0 || isPureAckReply(text)) {
      return null;
    }
    return { ids, text };
  }

  /**
   * turn_failed / turn_canceled: the window produced no completed answer.
   * Keep the ids pending for the next delivery/recovery window; drop the
   * failed turn's prose (never synthesize from an incomplete turn).
   */
  fail(): void {
    for (const id of this.active) {
      this.pending.add(id);
    }
    this.active.clear();
    this.rows.length = 0;
    this.turnActive = false;
  }
}
