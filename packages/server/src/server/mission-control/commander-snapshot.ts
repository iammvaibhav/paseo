import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AgentPromptInput, AgentRunOptions } from "../agent/agent-sdk-types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt, startAgentRun } from "../agent/agent-prompt.js";
import { CommanderAckDrop, type CommanderAckDropOptions } from "./commander-ack-drop.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";
import { WORLD_SNAPSHOT_MARKER, type WorldSnapshot } from "./context.js";

// How long the injector waits for its own snapshot turn to settle when the
// delivered message must not replace it (replaceRunning:false callers — the
// machinery-turn path). A wedged snapshot turn must not stall the message.
const SNAPSHOT_SETTLE_TIMEOUT_MS = 30_000;
// The no-prose instruction rides the snapshot body so the Commander's reply to
// a state-only turn is a single acknowledgment token — which the composed
// CommanderAckDrop then retracts. Mirrors the digest-era instruction (the
// Commander's system prompt still states the same convention).
const SNAPSHOT_NO_PROSE_INSTRUCTION =
  'If this fleet state needs no action from you, reply with a single short acknowledgment token (for example "ok") and nothing else. No summaries, no narration.';

export interface CommanderSnapshotInjectorOptions {
  agentManager: Pick<
    AgentManager,
    | "getAgent"
    | "hasInFlightRun"
    | "subscribe"
    | "removeTimelineRows"
    | "fetchTimeline"
    | "tryRunOutOfBand"
    | "replaceAgentRun"
    | "streamAgent"
    | "reloadAgentSession"
    | "beforeAgentRun"
  >;
  logger: Logger;
  /** Build the current world snapshot (mission-control/context). */
  buildSnapshot: () => Promise<WorldSnapshot>;
}

/**
 * Per-turn world-snapshot injection for the Commander (docs/commander.md
 * "Runtime model": stateless turns, fleet state regenerated and injected every
 * turn, never accreted). Wired into `startAgentRun` via the AgentManager
 * `beforeAgentRun` seam (agent-manager + agent-prompt); every message
 * delivered to the commander-labeled agent rides the same path.
 *
 * Mechanics:
 * - The snapshot is dispatched as its OWN standalone `<paseo-system>` message
 *   immediately before the delivered message, so it is a distinct timeline row
 *   (the app renders any user row starting with the envelope as machinery; a
 *   snapshot glued into the user's own row would hide their message). The
 *   dispatch rides a unique clientMessageId so the row is staged at turn start
 *   — it survives the delivered message's replacement of the snapshot turn.
 * - Supersede-in-place: the previous snapshot row is retracted via
 *   `removeTimelineRows` — the same retraction primitive CommanderAckDrop uses
 *   on omp timelines — before the fresh snapshot is dispatched. Rows are
 *   matched by the WORLD_SNAPSHOT_MARKER stamp, so the launch-time first
 *   message is superseded too.
 * - The snapshot turn's own reply is a machinery turn: a pure-ack "ok" is
 *   retracted by the composed CommanderAckDrop (one-shot arm, cleared if the
 *   delivered message's replace cancels the snapshot turn first).
 * - Busy Commander (a turn already in flight, e.g. a native steer or an
 *   interrupt): a new run cannot start, so injection is skipped and logged —
 *   the running turn already carries the previous snapshot row in context.
 *   Documented as the busy-path exception; the next idle turn re-injects.
 */
export class CommanderSnapshotInjector {
  private readonly agentManager: CommanderSnapshotInjectorOptions["agentManager"];
  private readonly logger: Logger;
  private readonly buildSnapshot: () => Promise<WorldSnapshot>;
  /** Ack-retraction tracker for the snapshot's own machinery turn. */
  readonly ackDrop: CommanderAckDrop;

  private attachedId: string | null = null;
  /** Seqs of every current snapshot row (launch + injections + late provider
   *  echoes), for supersede-in-place. Adopted from the canonical timeline at
   *  each turn — the stream event seq can lag the staged row's real seq. */
  private snapshotRowSeqs: number[] = [];
  /** Re-entrancy guard: the injector's own snapshot dispatch must not recurse. */
  private dispatchingSnapshot = false;

  constructor(options: CommanderSnapshotInjectorOptions) {
    this.agentManager = options.agentManager;
    this.logger = options.logger.child({ module: "mission-control", component: "snapshot" });
    this.buildSnapshot = options.buildSnapshot;
    this.ackDrop = new CommanderAckDrop({
      agentManager: options.agentManager as CommanderAckDropOptions["agentManager"],
      logger: this.logger,
    });
  }

  /**
   * The startAgentRun seam (wired by bootstrap as AgentManager beforeAgentRun).
   * For the commander-labeled agent: supersede the previous snapshot row and
   * dispatch a fresh snapshot as its own machinery message, so the delivered
   * message's turn sees current fleet state. Returns the prompt unchanged —
   * injection is a separate dispatch, never an edit of the user's message.
   * `replaceRunning` mirrors the delivered message's startAgentRun option:
   * false (queue/machinery path) waits for the snapshot turn to settle so the
   * delivered run can start after it; true (user path) lets the delivered run
   * replace the snapshot turn once its row is staged.
   */
  async beforeTurn(input: {
    agentId: string;
    prompt: AgentPromptInput;
    runOptions?: AgentRunOptions;
    replaceRunning?: boolean;
  }): Promise<void> {
    if (this.dispatchingSnapshot) {
      return;
    }
    const agent = this.agentManager.getAgent(input.agentId);
    if (!agent || agent.labels[MISSION_CONTROL_LABEL_KEY] !== MISSION_CONTROL_LABEL_VALUE) {
      return;
    }
    // The launch-time first message IS the world snapshot
    // (buildCommanderLaunchConfig): never inject a snapshot ahead of a
    // snapshot — but arm the ack-drop HERE, before the launch turn starts
    // (onCommanderCreated fires only after the run is dispatched, too late to
    // classify the turn), so the launch turn's pure-ack reply is retracted
    // like any later snapshot turn. Machinery turns (needs-you events) carry
    // no marker and still get the fresh snapshot ahead of them.
    if (typeof input.prompt === "string" && input.prompt.includes(WORLD_SNAPSHOT_MARKER)) {
      this.attach(input.agentId);
      this.ackDrop.arm();
      return;
    }
    this.attach(input.agentId);
    // Adoption must settle BEFORE the supersede below: the previous snapshot
    // rows (launch first message, or rows from before this daemon process)
    // are only known once the timeline has been read. Fire-and-forget would
    // race the retraction and leave stale snapshot rows behind.
    await this.adoptSnapshotRows(input.agentId);
    if (this.agentManager.hasInFlightRun(input.agentId)) {
      // A turn is already in flight (native steer, interrupt replace): a
      // snapshot run cannot start. The running turn already carries the
      // previous snapshot row in context; skip and let the next idle turn
      // re-inject. (Busy-path exception — documented in the class doc.)
      this.logger.debug(
        { agentId: input.agentId },
        "mission_control.snapshot.skipped_busy_commander",
      );
      return;
    }
    await this.supersedePreviousSnapshots(input.agentId);
    try {
      await this.dispatchSnapshot(input.agentId);
    } catch (error) {
      // The snapshot is advisory: a failed injection must never fail the
      // message itself. The delivered turn simply runs on the previous row.
      this.logger.warn(
        { err: error, agentId: input.agentId },
        "mission_control.snapshot.dispatch_failed",
      );
      return;
    }
    if (input.replaceRunning === false) {
      // The caller will not replace the snapshot turn (machinery-turn path,
      // queue dispatch): wait for it to settle so the caller's run can start.
      await this.waitForSnapshotSettlement(input.agentId);
    }
  }

  /**
   * Arm the ack-drop tracker for the launch-time first turn (the initial
   * snapshot's pure-ack reply). Called by commander-boot's onCommanderCreated
   * so the very first reply is retracted like any later snapshot ack.
   */
  armLaunchTurn(commanderId: string): void {
    this.attach(commanderId);
    this.ackDrop.arm();
  }

  /** Subscribe to the Commander's stream (ack-drop tracking) on attach. */
  attach(commanderId: string): void {
    if (this.attachedId === commanderId) {
      return;
    }
    this.detach();
    this.attachedId = commanderId;
    this.ackDrop.attach(commanderId);
  }

  detach(): void {
    this.attachedId = null;
    this.snapshotRowSeqs = [];
    this.ackDrop.detach();
  }

  /**
   * Adopt every committed snapshot row (launch first message, prior
   * injections, and late provider echoes of them) from the CANONICAL in-memory
   * timeline — not the durable store, whose commits can lag a freshly created
   * Commander, and not the stream event seq, which can drift from the staged
   * row's real seq. Called at every turn, awaited before the supersede.
   */
  private async adoptSnapshotRows(agentId: string): Promise<void> {
    let result;
    try {
      result = await this.agentManager.fetchTimeline(agentId, { direction: "tail" });
    } catch {
      // Agent not loaded yet — nothing to adopt; the next turn re-reads.
      return;
    }
    const seqs: number[] = [];
    for (const row of result.rows) {
      if (row.item.type === "user_message" && row.item.text.includes(WORLD_SNAPSHOT_MARKER)) {
        seqs.push(row.seq);
      }
    }
    if (seqs.length > 0) {
      this.snapshotRowSeqs = seqs;
      this.logger.debug({ agentId, seqs }, "mission_control.snapshot.adopted_existing_rows");
    }
  }

  /**
   * Retract every current snapshot row (supersede-in-place): the launch row,
   * prior injections, and any duplicate provider echoes of them. All are stale
   * once the fresh snapshot is dispatched — the thread never accretes fleet
   * state, and the app never sees duplicate machinery rows.
   */
  private async supersedePreviousSnapshots(agentId: string): Promise<void> {
    const seqs = this.snapshotRowSeqs;
    this.snapshotRowSeqs = [];
    if (seqs.length === 0) {
      return;
    }
    await this.agentManager
      .removeTimelineRows(agentId, seqs, "snapshot-supersede")
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, agentId, seqs },
          "mission_control.snapshot.supersede_retract_failed",
        );
      });
  }

  /**
   * Dispatch the fresh snapshot as its own standalone machinery message. The
   * ack-drop is armed before dispatch so the snapshot turn's pure-ack reply
   * is retracted (one-shot: if the delivered message replaces this turn, the
   * cancel clears the arm and the message's turn is never classified). The
   * dispatch rides a unique clientMessageId so the row is staged synchronously
   * at turn start — a delivered message that replaces this turn (user path)
   * cannot race the row out of the timeline.
   */
  private async dispatchSnapshot(agentId: string): Promise<void> {
    const { block } = await this.buildSnapshot();
    const prompt = formatSystemNotificationPrompt(
      `${block.trim()}\n\n${SNAPSHOT_NO_PROSE_INSTRUCTION}`,
    );
    this.dispatchingSnapshot = true;
    this.ackDrop.arm();
    try {
      await startAgentRun(this.agentManager, agentId, prompt, this.logger, {
        replaceRunning: false,
        runOptions: { clientMessageId: `snapshot-${randomUUID()}` },
      });
    } catch (error) {
      this.ackDrop.disarm();
      throw error;
    } finally {
      this.dispatchingSnapshot = false;
    }
    this.logger.info({ agentId }, "mission_control.snapshot.injected");
  }

  /**
   * Wait for the snapshot's own turn to settle (used when the delivered
   * message must not replace it). Bounded; on timeout the caller's dispatch
   * fails loudly on its own "active run" and the event stays in the feed.
   */
  private waitForSnapshotSettlement(agentId: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | null = null;
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    timer = setTimeout(() => {
      this.logger.warn({ agentId }, "mission_control.snapshot.settle_timeout");
      finish();
    }, SNAPSHOT_SETTLE_TIMEOUT_MS);
    unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.agentId === agentId &&
          (event.event.type === "turn_completed" ||
            event.event.type === "turn_failed" ||
            event.event.type === "turn_canceled")
        ) {
          finish();
        }
      },
      { agentId },
    );
    return promise;
  }
}
