import { randomUUID } from "node:crypto";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";
import { createWatchJournal } from "../watch-journal.js";
import type { AgentManager } from "./agent-manager.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent-prompt.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";

/**
 * Agent-to-agent notifyOnFinish: a caller agent that creates or prompts a
 * child with notifyOnFinish is woken with a system notification when the
 * child's run finishes, errors, is closed, or blocks on a permission.
 *
 * Watches survive a daemon restart. Each transition is logged and appended to
 * a JSONL journal ($PASEO_HOME/mcp-fleet/agent-finish-watches.jsonl). On
 * shutdown the daemon suspends the watches before closing agents, so the
 * shutdown's "closed" state never reaches the caller; at startup it restores
 * every watch still pending. A restart interrupts the child's run, so a
 * restored watch waits for the child's resumed run (the deploy nudge restarts
 * it) and reports that run's end, or tells the caller the child was
 * interrupted when no run resumes within the grace period. A final
 * notification fired but not confirmed delivered before the restart is sent
 * again.
 */

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

export interface AgentFinishWatches {
  arm(input: {
    childAgentId: string;
    callerAgentId: string;
    requireParentOwnership: boolean;
  }): void;
  /**
   * Re-arm the watches a previous daemon process left pending. Call once at
   * startup, before the server accepts prompts, so a restored watch sees its
   * child's resumed run start.
   */
  restore(): Promise<{ restored: number }>;
  /**
   * Daemon shutdown: stop every watch without notifying and flush the
   * journal; the watches stay pending for restore(). Call before agents close.
   */
  suspend(): Promise<void>;
}

export interface AgentFinishWatchesOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  /** Watch journal (JSONL). Absent → watches live in memory only and restore() finds none. */
  journalPath?: string;
  /** After a restart, how long a restored watch waits for its child's run to resume. */
  resumeGraceMs?: number;
}

const INTERRUPTED = "was interrupted by a daemon restart and did not resume";

type FinishNotificationReason =
  | "finished"
  | "errored"
  | "needs permission"
  | "was closed"
  | typeof INTERRUPTED;

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface WatchIds {
  ts: string;
  watchId: string;
  childAgentId: string;
  callerAgentId: string;
}

interface ArmedEntry extends WatchIds {
  event: "armed";
  requireParentOwnership: boolean;
}

type JournalEntry =
  | ArmedEntry
  | (WatchIds & { event: "fired"; reason: FinishNotificationReason; terminal: boolean })
  | (WatchIds & { event: "delivered"; reason: FinishNotificationReason; terminal: boolean })
  | (WatchIds & {
      event: "skipped";
      reason: FinishNotificationReason;
      terminal: boolean;
      why: string;
    })
  | (WatchIds & {
      event: "failed";
      reason: FinishNotificationReason;
      terminal: boolean;
      error: string;
    })
  | (WatchIds & { event: "stopped"; why: string })
  | (WatchIds & { event: "suspended" | "restored" | "resumed" })
  | (WatchIds & { event: "gave_up"; why: string });

interface PendingWatch {
  armed: ArmedEntry;
  /** A final notification fired but never confirmed delivered, skipped or failed. */
  unsent: FinishNotificationReason | null;
}

interface ActiveWatch {
  armed: ArmedEntry;
  /** Stop observing the child; records nothing. */
  close(): void;
}

interface NotifyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

/** The watches the journal shows armed and not yet settled, in arm order. */
function pendingWatches(entries: readonly JournalEntry[]): PendingWatch[] {
  const pending = new Map<string, PendingWatch>();
  for (const entry of entries) {
    if (entry.event === "armed") {
      pending.set(entry.watchId, { armed: entry, unsent: null });
      continue;
    }
    const watch = pending.get(entry.watchId);
    if (!watch) continue;
    if (entry.event === "stopped" || entry.event === "gave_up") {
      pending.delete(entry.watchId);
    } else if (entry.event === "fired") {
      if (entry.terminal) watch.unsent = entry.reason;
    } else if (
      entry.event === "delivered" ||
      entry.event === "skipped" ||
      entry.event === "failed"
    ) {
      if (entry.terminal) pending.delete(entry.watchId);
    }
  }
  return [...pending.values()];
}

export function createAgentFinishWatches(options: AgentFinishWatchesOptions): AgentFinishWatches {
  const { agentManager, agentStorage } = options;
  const resumeGraceMs = options.resumeGraceMs ?? 10 * 60_000;
  const logger = options.logger.child({ module: "agent-finish-watches" });
  const journal = options.journalPath
    ? createWatchJournal<JournalEntry>({ path: options.journalPath, logger })
    : null;
  // A caller waits on a child through one watch. Arming again, such as a
  // follow-up prompt while the child still runs, replaces the earlier one so
  // the child's next finish reaches the caller once.
  const active = new Map<string, ActiveWatch>();
  let suspended = false;

  // Logs the transition and appends it to the journal, in call order.
  const record = (entry: JournalEntry) => {
    const level = entry.event === "failed" || entry.event === "gave_up" ? "warn" : "info";
    logger[level](entry, `agent finish watch ${entry.event}`);
    journal?.append(entry);
  };

  const idsOf = (armed: ArmedEntry): WatchIds => ({
    ts: new Date().toISOString(),
    watchId: armed.watchId,
    childAgentId: armed.childAgentId,
    callerAgentId: armed.callerAgentId,
  });

  const deliver = async (
    armed: ArmedEntry,
    reason: FinishNotificationReason,
    terminal: boolean,
    permissionRequest?: AgentPermissionRequest,
  ) => {
    const { childAgentId, callerAgentId } = armed;
    try {
      const callerRecord = await agentStorage.get(callerAgentId);
      if (callerRecord?.archivedAt) {
        record({ event: "skipped", ...idsOf(armed), reason, terminal, why: "caller archived" });
        return;
      }
      const childRecord = await agentStorage.get(childAgentId);
      if (
        armed.requireParentOwnership &&
        getParentAgentIdFromLabels(childRecord?.labels) !== callerAgentId
      ) {
        record({ event: "skipped", ...idsOf(armed), reason, terminal, why: "not the parent" });
        return;
      }
      const body = formatFinishNotificationBody({
        childAgentId,
        title: childRecord?.title ?? childAgentId,
        reason,
        lastAssistantMessage: await agentManager.getLastAssistantMessage(childAgentId),
        permissionRequest,
      });
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: callerAgentId,
        prompt: formatSystemNotificationPrompt(body),
        activeTurnBehavior: "steer",
        unarchive: false,
        logger,
      });
      record({ event: "delivered", ...idsOf(armed), reason, terminal });
    } catch (error) {
      logger.error(
        { err: error, childAgentId, callerAgentId, reason },
        "Failed to notify caller agent",
      );
      record({ event: "failed", ...idsOf(armed), reason, terminal, error: String(error) });
    }
  };

  /**
   * Observe the child until its run ends. A restored watch ignores the
   * child's idle and closed states until its resumed run starts, and reports
   * the interruption when no run starts within the grace period.
   */
  const watchChild = (armed: ArmedEntry, restored: boolean) => {
    const { childAgentId, callerAgentId } = armed;
    const key = JSON.stringify([childAgentId, callerAgentId]);
    const previous = active.get(key);
    if (previous) {
      previous.close();
      record({ event: "stopped", ...idsOf(previous.armed), why: "replaced by a newer watch" });
    }

    let hasSeenRunning = false;
    let stopped = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | null = null;
    let notificationQueue = Promise.resolve();
    const notifiedPermissionRequestIds = new Set<string>();

    const watch: ActiveWatch = {
      armed,
      close() {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
        clearTimeout(graceTimer);
        if (active.get(key) === watch) active.delete(key);
      },
    };
    active.set(key, watch);

    const notify = (reason: FinishNotificationReason, notifyOptions: NotifyOptions = {}) => {
      if (stopped) return;
      const terminal = notifyOptions.terminal ?? true;
      if (terminal) watch.close();
      record({ event: "fired", ...idsOf(armed), reason, terminal });
      notificationQueue = notificationQueue.then(() =>
        deliver(armed, reason, terminal, notifyOptions.permissionRequest),
      );
    };

    const sawRunning = () => {
      if (restored && !hasSeenRunning && graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
        record({ event: "resumed", ...idsOf(armed) });
      }
      hasSeenRunning = true;
    };

    unsubscribe = agentManager.subscribe(
      (event) => {
        if (stopped) return;

        if (event.type === "agent_state") {
          for (const requestId of notifiedPermissionRequestIds) {
            if (!event.agent.pendingPermissions.has(requestId)) {
              notifiedPermissionRequestIds.delete(requestId);
            }
          }
          if (event.agent.lifecycle === "running") {
            if (event.agent.pendingPermissions.size === 0) sawRunning();
            return;
          }
          if (event.agent.lifecycle === "error") {
            notify("errored");
            return;
          }
          if (event.agent.lifecycle === "idle" && hasSeenRunning) {
            notify("finished");
            return;
          }
          // Before a restored child's run resumes, closed is the restart's doing.
          if (event.agent.lifecycle === "closed" && (hasSeenRunning || !restored)) {
            notify("was closed");
          }
          return;
        }

        if (event.type === "timeline_replacement") return;

        if (event.event.type === "permission_requested") {
          // A permission pause is an intermediate checkpoint. Forget the run
          // observed before it so an idle state during follow-up startup cannot
          // masquerade as the final completion.
          hasSeenRunning = false;
          if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
            notifiedPermissionRequestIds.add(event.event.request.id);
            notify("needs permission", {
              terminal: false,
              permissionRequest: event.event.request,
            });
          }
          return;
        }

        if (event.event.type === "permission_resolved") {
          notifiedPermissionRequestIds.delete(event.event.requestId);
          const childAgent = agentManager.getAgent(childAgentId);
          if (childAgent?.pendingPermissions.size === 0) {
            hasSeenRunning = childAgent.lifecycle === "running";
          }
        }
      },
      { agentId: childAgentId, replayState: false },
    );

    const childSnapshot = agentManager.getAgent(childAgentId);
    if (restored) {
      if (childSnapshot?.lifecycle === "running") {
        hasSeenRunning = true;
        return;
      }
      graceTimer = setTimeout(() => notify(INTERRUPTED), resumeGraceMs);
      return;
    }
    // Check if the child is already running (catches the case where
    // the lifecycle flipped before our subscribe call was processed).
    // Do NOT treat an immediate "idle" as "finished" — the agent may
    // not have started yet (streamAgent sets a pending run before
    // transitioning to "running").
    if (!childSnapshot || childSnapshot.lifecycle === "closed") {
      watch.close();
      record({ event: "stopped", ...idsOf(armed), why: "child is not running" });
      return;
    }
    if (childSnapshot.lifecycle === "running") {
      hasSeenRunning = true;
    } else if (childSnapshot.lifecycle === "error") {
      notify("errored");
    }
  };

  return {
    arm(input) {
      const armed: ArmedEntry = {
        event: "armed",
        ts: new Date().toISOString(),
        watchId: randomUUID(),
        ...input,
      };
      record(armed);
      // Armed while shutting down: journaled, so the next process restores it.
      if (suspended) return;
      watchChild(armed, false);
    },

    async restore() {
      if (!journal) return { restored: 0 };
      const entries = await journal.read(
        (all) => new Set(pendingWatches(all).map((watch) => watch.armed.watchId)),
      );
      let restored = 0;
      for (const { armed, unsent } of pendingWatches(entries)) {
        const caller = await agentStorage.get(armed.callerAgentId).catch(() => null);
        if (!caller || caller.archivedAt) {
          record({ event: "gave_up", ...idsOf(armed), why: "caller agent is gone or archived" });
          continue;
        }
        if (!(await agentStorage.get(armed.childAgentId).catch(() => null))) {
          record({ event: "gave_up", ...idsOf(armed), why: "child agent is gone" });
          continue;
        }
        record({ event: "restored", ...idsOf(armed) });
        restored += 1;
        if (unsent) void deliver(armed, unsent, true);
        else watchChild(armed, true);
      }
      return { restored };
    },

    async suspend() {
      suspended = true;
      for (const watch of active.values()) {
        watch.close();
        record({ event: "suspended", ...idsOf(watch.armed) });
      }
      await journal?.flush();
    },
  };
}

const watchesByManager = new WeakMap<AgentManager, AgentFinishWatches>();

/** The daemon's journaled watches for this AgentManager; setupFinishNotification arms through them. */
export function attachAgentFinishWatches(options: AgentFinishWatchesOptions): AgentFinishWatches {
  const watches = createAgentFinishWatches(options);
  watchesByManager.set(options.agentManager, watches);
  return watches;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  let watches = watchesByManager.get(params.agentManager);
  if (!watches) {
    // No daemon attached a journal (tests, embedded managers): watches live in memory only.
    watches = createAgentFinishWatches(params);
    watchesByManager.set(params.agentManager, watches);
  }
  watches.arm({
    childAgentId: params.childAgentId,
    callerAgentId: params.callerAgentId,
    requireParentOwnership: params.requireParentOwnership ?? false,
  });
}
