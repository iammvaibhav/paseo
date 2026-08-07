import type { Logger } from "pino";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  MissionControlEvent,
  MissionControlEventKind,
} from "@getpaseo/protocol/mission-control/types";

import type { AgentManager } from "../agent/agent-manager.js";
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

export interface MissionControlDigestOrigin {
  serverId: string;
  hostName: string;
}

interface BufferedMissionControlEvent {
  event: MissionControlEvent;
  origin: MissionControlDigestOrigin;
}

/**
 * Narrow surface PeerSlice and MissionControlService depend on, so they stay
 * decoupled from the digest internals.
 */
export interface MissionControlDigestSink {
  enqueue(event: MissionControlEvent, origin: MissionControlDigestOrigin): void;
}

export interface MissionControlDigestOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
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

  private buffer: BufferedMissionControlEvent[] = [];
  private commanderId: string | null = null;
  private unsubscribeCommander: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(options: MissionControlDigestOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ module: "mission-control-digest" });
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
    if (this.buffer.length === 0) {
      return;
    }

    const digestItems = await this.selectDigestItems(commanderId);
    if (digestItems.length === 0) {
      this.buffer = [];
      return;
    }

    const prompt = formatSystemNotificationPrompt(buildDigestBody(digestItems));
    try {
      const dispatched = await startAgentRun(this.agentManager, commanderId, prompt, this.logger, {
        replaceRunning: false,
      });
      if (dispatched.outOfBand) {
        // Matched an out-of-band handler (e.g. /goal pause) — no run started.
        return;
      }
      // startAgentRun resolves before the turn is accepted; wait so a dispatch
      // that raced a user prompt is detected and the buffer kept.
      await waitForAgentRunStartWithTimeout(this.agentManager, commanderId);
    } catch (error) {
      // The dispatch raced a user prompt or the Commander closed. Never
      // interrupt — the events wait for the next quiet window.
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
        }
      },
      { agentId: commanderId },
    );
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

function buildDigestBody(entries: readonly BufferedMissionControlEvent[]): string {
  const noun = entries.length === 1 ? "event" : "events";
  const lines = entries.map(({ event, origin }) => {
    const link = `paseo://h/${origin.serverId}/agent/${event.agentId}`;
    const line = `- [${event.kind}] ${event.headline} — ${event.agentTitle} (${origin.hostName}) — ${link}`;
    return event.detail ? `${line}\n  ${event.detail}` : line;
  });
  return `Fleet digest: ${entries.length} ${noun}.\n\n${lines.join("\n")}`;
}
