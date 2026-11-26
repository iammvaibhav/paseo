import type { Logger } from "pino";
import type { PersistentNotifyEntry, TurnOrigin } from "@getpaseo/protocol/messages";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { McpNotifyTargetRef } from "./finish-notifier.js";

/**
 * Callback targets an agent keeps for its turns, stored on its record. Each foreground turn
 * the agent starts arms a watch for every entry whose `turns` include the turn's origin, on
 * this host, next to whatever targets the call that started the turn named. The finish
 * notifier keeps one watch per target per turn (a call's context wins).
 */
export interface PersistentNotify {
  /** A webhook name this host's notify targets include. */
  isConfigured(name: string): boolean;
  get(agentId: string): Promise<PersistentNotifyEntry[]>;
  /**
   * Replace the agent's entries ([] clears). The turn the agent is running now, or `turnId`,
   * is armed for the new entries too.
   */
  set(
    agentId: string,
    entries: PersistentNotifyEntry[],
    options?: { turnId?: string },
  ): Promise<void>;
  /** Start arming turns as they start; returns the unsubscribe. */
  start(): () => void;
}

/** The client name persistent watches report as (`client` in their events). */
export const PERSISTENT_NOTIFY_CLIENT = "persistent-notify";

export function persistentTargetRef(entry: PersistentNotifyEntry): McpNotifyTargetRef {
  return typeof entry.target === "string" ? { name: entry.target } : { agent: entry.target.agent };
}

export function persistentEntryApplies(entry: PersistentNotifyEntry, origin: TurnOrigin): boolean {
  return !entry.turns || entry.turns.includes(origin);
}

/**
 * Refuses entries that could never deliver: a webhook name this host has not configured, an
 * agent that notifies itself (each finish would start the next turn), or one target twice.
 */
export function validatePersistentNotify(
  agentId: string,
  entries: readonly PersistentNotifyEntry[],
  isConfigured: (name: string) => boolean,
): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const ref = persistentTargetRef(entry);
    const key = "name" in ref ? `name:${ref.name}` : `agent:${ref.agent}`;
    if (seen.has(key)) return `${describe(ref)} is listed twice; give each target one entry.`;
    seen.add(key);
    if ("agent" in ref && ref.agent === agentId) {
      return "An agent cannot be its own persistent target: each finish would start its next turn.";
    }
    if ("name" in ref && !isConfigured(ref.name)) {
      return `notify target "${ref.name}" is not configured (daemon.mcp.notifyTargets).`;
    }
  }
  return null;
}

function describe(ref: McpNotifyTargetRef): string {
  return "name" in ref ? `notify target "${ref.name}"` : `agent ${ref.agent}`;
}

export function createPersistentNotify(deps: {
  agentManager: Pick<AgentManager, "onForegroundTurnStarted" | "getAgent">;
  agentStorage: Pick<AgentStorage, "get" | "setPersistentNotify">;
  isConfigured: (name: string) => boolean;
  /** Arm one entry's watch on this host for the turn. */
  arm: (agentId: string, turnId: string, entry: PersistentNotifyEntry) => void;
  logger: Logger;
}): PersistentNotify {
  const { agentManager, agentStorage, logger } = deps;
  // The origin of each agent's latest turn, for a set that arms the turn already running.
  const latestTurn = new Map<string, { turnId: string; origin: TurnOrigin }>();

  const get = async (agentId: string) => (await agentStorage.get(agentId))?.persistentNotify ?? [];

  const armTurn = (
    agentId: string,
    turnId: string,
    origin: TurnOrigin,
    entries: readonly PersistentNotifyEntry[],
  ) => {
    for (const entry of entries) {
      if (persistentEntryApplies(entry, origin)) deps.arm(agentId, turnId, entry);
    }
  };

  return {
    isConfigured: deps.isConfigured,
    get,

    async set(agentId, entries, options) {
      const invalid = validatePersistentNotify(agentId, entries, deps.isConfigured);
      if (invalid) throw new Error(invalid);
      await agentStorage.setPersistentNotify(agentId, entries);
      const turnId = options?.turnId ?? agentManager.getAgent(agentId)?.activeForegroundTurnId;
      if (!turnId) return;
      const latest = latestTurn.get(agentId);
      armTurn(agentId, turnId, latest?.turnId === turnId ? latest.origin : "prompt", entries);
    },

    start() {
      return agentManager.onForegroundTurnStarted(({ agentId, turnId, origin }) => {
        latestTurn.set(agentId, { turnId, origin });
        void get(agentId)
          .then((entries) => armTurn(agentId, turnId, origin, entries))
          .catch((error: unknown) => {
            logger.warn(
              { err: error, agentId, turnId },
              "persistent notify: arming the turn failed",
            );
          });
      });
    },
  };
}
