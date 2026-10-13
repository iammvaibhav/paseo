import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-wait.js";
import type { RemoteMcpClient } from "../persisted-config.js";
import type { ResolveSecret } from "../secrets/vault-secret.js";
import { createWatchJournal } from "../watch-journal.js";

/**
 * notifyOnFinish for remote MCP clients (/mcp/fleet). A client has no agent
 * thread to wake, so the daemon POSTs a JSON event to the webhook configured
 * for that client (daemon.mcp.remoteClients[].notify) when the run ends.
 * Each watch is bound to a turn (the one the create/send started, else the
 * run in progress), so an earlier run's finish never fires it.
 *
 * Watches survive a daemon restart. Every watch transition (armed, fired,
 * delivered, failed, suspended, restored, resumed, gave_up) is appended to a
 * JSONL journal, which doubles as the queryable delivery record. On shutdown
 * the daemon suspends its watches before closing agents, so the shutdown's
 * "closed" state is never reported as the run's end; the next process
 * restores every watch the journal still shows pending. A restart interrupts
 * this daemon's own agents, so a restored watch on one of them waits for the
 * agent's resumed run (the deploy nudge restarts it), rebinds to that run's
 * turn, and reports its end, or reason "interrupted" when no run resumes
 * within resumeGraceMs. Delivery is at-least-once: an event fired but not
 * confirmed before the restart is sent again.
 *
 * Group watches (armGroup) are journaled the same way: the group, each
 * member's end as it lands, and the group event. A restored group keeps the
 * members that already ended and waits out the rest, so the group event is
 * sent once every member's run has ended, across restarts.
 */
export type McpNotifyTarget = NonNullable<RemoteMcpClient["notify"]>;

/** One bounded wait, bound to turnId when given; the watcher calls it repeatedly until the turn ends. */
export type McpFinishWaitForAgent = (input: {
  agentId: string;
  host?: string;
  turnId?: string;
  timeoutMs: number;
}) => Promise<FleetAgentWaitResult>;

/** How a watch reaches its client: the webhook, and the client's own view of the fleet. */
export interface McpClientBinding {
  target: McpNotifyTarget;
  waitForAgent: McpFinishWaitForAgent;
}

export interface McpNotifyAgent {
  agentId: string;
  /** Host hint for the agent; omitted → resolved through the fleet index. */
  host?: string;
  /** Bind to this turn; omitted → the run in progress when the watch is armed. */
  turnId?: string | null;
}

export interface ArmMcpFinishNotification extends McpClientBinding, McpNotifyAgent {
  client: string;
  tool: string;
  context: string | null;
}

export interface ArmMcpGroupNotification extends McpClientBinding {
  client: string;
  groupId: string;
  agents: McpNotifyAgent[];
  /** Also arm a journaled per-agent watch for each agent. */
  perAgent: boolean;
  tool: string;
  context: string | null;
}

/** A run starting on a watched agent; `local: false` when this daemon does not host it. */
export interface McpFinishRunStart {
  local: boolean;
  turnId: string | null;
}

/** The agents this daemon hosts: a restart interrupts their runs, unlike agents on peers. */
export interface McpFinishLocalAgents {
  /** The turn the agent runs now; null when idle or not hosted here. */
  activeTurnId(agentId: string): string | null;
  /**
   * Resolves once an agent hosted here starts a run (at once when it runs
   * now), with that run's turn id. Resolves `{ local: false }` for an agent
   * this daemon does not host. Rejects when the signal aborts.
   */
  waitForRunStart(agentId: string, signal: AbortSignal): Promise<McpFinishRunStart>;
}

export interface McpFinishNotifierOptions {
  resolveSecret: ResolveSecret;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Watch journal (JSONL). Absent → watches live in memory only and restore() finds none. */
  journalPath?: string;
  localAgents?: McpFinishLocalAgents;
  /** Give up watching an agent after this long, counted from arm, across restarts. */
  maxWatchMs?: number;
  /** One wait call's length; the watcher re-waits until maxWatchMs. */
  waitChunkMs?: number;
  /** Pause between checks while blocked on a permission, and after a failed wait. */
  pollMs?: number;
  /** Delays before delivery retries. */
  retryDelaysMs?: readonly number[];
  /** After a restart, how long a restored watch waits for its local agent's run to resume. */
  resumeGraceMs?: number;
}

export interface McpFinishNotifier {
  /**
   * Start watching in the background. Callers do not await it; the promise
   * settles (never rejects) once the event is delivered, the watch gives up,
   * or the watch is suspended for shutdown.
   */
  arm(input: ArmMcpFinishNotification): Promise<void>;
  /**
   * Watch a set of agents and POST one paseo.agents.group_finished once every
   * agent's bound turn has ended (plus journaled per-agent watches when
   * perAgent is set). needs_permission still POSTs per agent and does not
   * complete the group. Journaled: the group event survives a restart.
   */
  armGroup(input: ArmMcpGroupNotification): Promise<void>;
  /**
   * Re-arm the watches a previous daemon process left pending. Call once at
   * startup, before the server accepts prompts, so a restored watch sees its
   * agent's resumed run start. `settled` resolves when every restored watch
   * has settled.
   */
  restore(
    resolveClient: (client: string) => Promise<McpClientBinding | null>,
  ): Promise<{ restored: number; settled: Promise<void> }>;
  /**
   * Daemon shutdown: stop every watch without delivering and flush the
   * journal; the watches stay pending for restore(). Call before agents close.
   */
  suspend(): Promise<void>;
}

export const MAX_NOTIFY_CONTEXT_LENGTH = 2000;
const LAST_MESSAGE_LIMIT = 4000;
const RESPONSE_SNIPPET_LIMIT = 500;
const VAULT_REF = /aside:\/\/\S+/;

type FinalReason = "finished" | "errored" | "closed" | "interrupted";
type NotifyReason = FinalReason | "needs_permission";

interface ArmedEntry {
  event: "armed";
  ts: string;
  watchId: string;
  client: string;
  agentId: string;
  host: string | null;
  tool: string;
  context: string | null;
  /** The turn the watch is bound to: the create/send's turn, else the run in progress. */
  turnId: string | null;
  /** Epoch ms after which the watch gives up. */
  deadline: number;
}

type JournalEntry =
  | ArmedEntry
  | {
      event: "fired";
      ts: string;
      watchId: string;
      agentId: string;
      reason: NotifyReason;
      status: string;
      body: string;
    }
  | {
      event: "delivered";
      ts: string;
      watchId: string;
      agentId: string;
      reason: NotifyReason;
      status: number;
      attempts: number;
    }
  | {
      event: "failed";
      ts: string;
      watchId: string;
      agentId: string;
      reason: NotifyReason;
      status: number | null;
      attempts: number;
      error: string | null;
    }
  | { event: "suspended"; ts: string; watchId: string; agentId: string }
  | { event: "restored"; ts: string; watchId: string; agentId: string }
  | { event: "resumed"; ts: string; watchId: string; agentId: string; turnId: string | null }
  | { event: "gave_up"; ts: string; watchId: string; agentId: string; why: string }
  | GroupArmedEntry
  | {
      event: "member_ended";
      ts: string;
      /** The group id. */
      watchId: string;
      /** The member agent. */
      agentId: string;
      reason: FinalReason;
      /** The member's entry in the group event. */
      agent: GroupMemberPayload;
    };

/** Group entries reuse watchId (and agentId, outside member_ended) for the group id. */
interface GroupArmedEntry {
  event: "group_armed";
  ts: string;
  watchId: string;
  agentId: string;
  client: string;
  tool: string;
  context: string | null;
  perAgent: boolean;
  /** Epoch ms after which the group gives up. */
  deadline: number;
  /** Each member's bound turn, in the order the group event lists them. */
  agents: Array<{ agentId: string; host: string | null; turnId: string | null }>;
}

type GroupMemberPayload = Record<string, unknown> & { reason: FinalReason };

interface PendingWatch {
  armed: ArmedEntry;
  /** A final event fired but never confirmed delivered or failed. */
  unsent: { reason: NotifyReason; body: string } | null;
}

interface PendingGroup {
  armed: GroupArmedEntry;
  /** Members whose bound run has ended, by agent id. */
  ended: Map<string, GroupMemberPayload>;
  /** The group event fired but never confirmed delivered or failed. */
  unsent: string | null;
}

interface ActiveWatch {
  armed: ArmedEntry;
  binding: McpClientBinding;
  controller: AbortController;
  /** The bound turn; a restart rebinds it to the agent's resumed run. */
  turnId: string | null;
}

class WatchSuspendedError extends Error {}

/** Resolves like `promise`, or rejects once `signal` aborts (the promise is left to settle unobserved). */
async function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new WatchSuspendedError();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(new WatchSuspendedError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The watches and groups the journal shows armed and not yet settled, in arm order. */
function pendingFromJournal(entries: readonly JournalEntry[]): {
  watches: PendingWatch[];
  groups: PendingGroup[];
} {
  const watches = new Map<string, PendingWatch>();
  const groups = new Map<string, PendingGroup>();
  for (const entry of entries) {
    if (entry.event === "armed") {
      watches.set(entry.watchId, { armed: entry, unsent: null });
      continue;
    }
    if (entry.event === "group_armed") {
      groups.set(entry.watchId, { armed: entry, ended: new Map(), unsent: null });
      continue;
    }
    const group = groups.get(entry.watchId);
    if (group) {
      if (entry.event === "member_ended") {
        group.ended.set(entry.agentId, entry.agent);
      } else if (entry.event === "fired") {
        group.unsent = entry.body;
      } else if (
        entry.event === "delivered" ||
        entry.event === "failed" ||
        entry.event === "gave_up"
      ) {
        groups.delete(entry.watchId);
      }
      continue;
    }
    const watch = watches.get(entry.watchId);
    if (!watch) continue;
    if (entry.event === "gave_up") {
      watches.delete(entry.watchId);
    } else if (entry.event === "fired") {
      watch.unsent = entry.reason === "needs_permission" ? null : entry;
    } else if (entry.event === "delivered" || entry.event === "failed") {
      if (entry.reason === "needs_permission") continue;
      watches.delete(entry.watchId);
    }
  }
  return { watches: [...watches.values()], groups: [...groups.values()] };
}

export function createMcpFinishNotifier(options: McpFinishNotifierOptions): McpFinishNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxWatchMs = options.maxWatchMs ?? 24 * 60 * 60_000;
  const waitChunkMs = options.waitChunkMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 15_000;
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000];
  const resumeGraceMs = options.resumeGraceMs ?? 10 * 60_000;
  const logger = options.logger.child({ module: "mcp-finish-notifier" });
  const active = new Map<string, ActiveWatch>();
  const activeGroups = new Map<string, AbortController>();
  let suspended = false;
  const journal = options.journalPath
    ? createWatchJournal<JournalEntry>({ path: options.journalPath, logger })
    : null;

  // Logs the transition and appends it to the journal, in call order.
  const record = (entry: JournalEntry) => {
    const { body: _body, ...fields } = entry as JournalEntry & { body?: string };
    const level = entry.event === "failed" || entry.event === "gave_up" ? "warn" : "info";
    logger[level](fields, `mcp finish watch ${entry.event}`);
    journal?.append(entry);
  };

  const resolveHeaders = async (headers: Record<string, string> | undefined) => {
    const resolved: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of Object.entries(headers ?? {})) {
      const ref = VAULT_REF.exec(value)?.[0];
      resolved[name] = ref ? value.replace(ref, (await options.resolveSecret(ref)) ?? "") : value;
    }
    return resolved;
  };

  const agentPayload = (agentId: string, result: FleetAgentWaitResult, turnId: string | null) => {
    let lastMessage = result.lastMessage?.trim() || null;
    if (lastMessage && lastMessage.length > LAST_MESSAGE_LIMIT) {
      lastMessage = `${lastMessage.slice(0, LAST_MESSAGE_LIMIT)}\n[truncated ${lastMessage.length - LAST_MESSAGE_LIMIT} chars; use fleet_get_transcript for the full response]`;
    }
    return {
      id: agentId,
      host: result.host,
      turnId: result.turnId ?? turnId,
      title: result.title,
      status: result.status,
      bucket: result.bucket,
      finishedAt: new Date().toISOString(),
      lastMessage,
      error: result.error,
    };
  };

  const buildBody = (
    armed: ArmedEntry,
    reason: NotifyReason,
    result: FleetAgentWaitResult,
  ): string =>
    JSON.stringify({
      type: reason === "needs_permission" ? "paseo.agent.needs_permission" : "paseo.agent.finished",
      reason,
      client: armed.client,
      context: armed.context,
      agent: agentPayload(armed.agentId, result, armed.turnId),
      trigger: { tool: armed.tool, requestedAt: armed.ts },
    });

  // POSTs one event, retrying network errors, 429 and 5xx. A suspend during a
  // retry pause leaves the event fired-but-unsent, so restore() sends it again.
  const send = async (watch: ActiveWatch, reason: NotifyReason, body: string) => {
    const { armed, binding, controller } = watch;
    const headers = await resolveHeaders(binding.target.headers);
    const ids = { watchId: armed.watchId, agentId: armed.agentId, reason };
    for (let attempt = 0; ; attempt += 1) {
      let status: number | null = null;
      let error: string | null = null;
      try {
        const response = await fetchImpl(binding.target.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        if (response.ok) {
          record({
            event: "delivered",
            ts: new Date().toISOString(),
            ...ids,
            status,
            attempts: attempt + 1,
          });
          return;
        }
        error = (await response.text().catch(() => "")).slice(0, RESPONSE_SNIPPET_LIMIT) || null;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      logger.warn(
        { ...ids, client: armed.client, status, err: error, attempt: attempt + 1 },
        "mcp finish notification attempt failed",
      );
      const retryable = status === null || status === 429 || status >= 500;
      const delay = retryDelaysMs[attempt];
      if (!retryable || delay === undefined) {
        record({
          event: "failed",
          ts: new Date().toISOString(),
          ...ids,
          status,
          attempts: attempt + 1,
          error,
        });
        return;
      }
      await sleep(delay, undefined, { signal: controller.signal }).catch(() => {
        throw new WatchSuspendedError();
      });
    }
  };

  const fire = async (watch: ActiveWatch, reason: NotifyReason, result: FleetAgentWaitResult) => {
    const body = buildBody(watch.armed, reason, result);
    record({
      event: "fired",
      ts: new Date().toISOString(),
      watchId: watch.armed.watchId,
      agentId: watch.armed.agentId,
      reason,
      status: result.status,
      body,
    });
    await send(watch, reason, body);
  };

  const pause = (watch: ActiveWatch, ms: number) =>
    sleep(ms, undefined, { signal: watch.controller.signal }).catch(() => {
      throw new WatchSuspendedError();
    });

  // A restart closed the agent if this daemon hosts it. Wait for its resumed
  // run and rebind the watch to it. Returns null to keep watching, or the
  // agent's final state once the grace period passes without a resumed run.
  const awaitResume = async (watch: ActiveWatch): Promise<FleetAgentWaitResult | null> => {
    const localAgents = options.localAgents;
    if (!localAgents) return null;
    const { signal } = watch.controller;
    const grace = AbortSignal.timeout(Math.min(resumeGraceMs, watch.armed.deadline - Date.now()));
    try {
      const run = await localAgents.waitForRunStart(
        watch.armed.agentId,
        AbortSignal.any([signal, grace]),
      );
      if (run.local) {
        // The resumed run is a new turn: the watch reports that run's end.
        if (run.turnId) watch.turnId = run.turnId;
        record({
          event: "resumed",
          ts: new Date().toISOString(),
          watchId: watch.armed.watchId,
          agentId: watch.armed.agentId,
          turnId: run.turnId,
        });
      }
      return null;
    } catch (error) {
      if (signal.aborted) throw new WatchSuspendedError();
      if (!grace.aborted) throw error;
    }
    // The agent is not running, so this returns at once with its final state.
    return watch.binding.waitForAgent({
      agentId: watch.armed.agentId,
      ...(watch.armed.host ? { host: watch.armed.host } : {}),
      timeoutMs: 1_000,
    });
  };

  /**
   * Re-wait until the watch's bound turn ends. Returns the final result, or
   * null at the deadline. onPermission runs once per blocked stretch.
   */
  const waitForTurnEnd = async (
    watch: ActiveWatch,
    onPermission: (result: FleetAgentWaitResult) => Promise<void>,
  ): Promise<FleetAgentWaitResult | null> => {
    const { armed } = watch;
    let permissionSent = false;
    while (Date.now() < armed.deadline) {
      let result: FleetAgentWaitResult;
      try {
        result = await unlessAborted(
          watch.binding.waitForAgent({
            agentId: armed.agentId,
            ...(armed.host ? { host: armed.host } : {}),
            ...(watch.turnId ? { turnId: watch.turnId } : {}),
            timeoutMs: Math.min(waitChunkMs, armed.deadline - Date.now()),
          }),
          watch.controller.signal,
        );
      } catch (error) {
        if (error instanceof WatchSuspendedError) throw error;
        logger.warn(
          {
            watchId: armed.watchId,
            client: armed.client,
            agentId: armed.agentId,
            err: String(error),
          },
          "mcp finish watch: wait failed, retrying",
        );
        await pause(watch, pollMs);
        continue;
      }
      if (!result.ok) {
        logger.warn(
          {
            watchId: armed.watchId,
            client: armed.client,
            agentId: armed.agentId,
            error: result.error,
          },
          "mcp finish watch: agent unreachable, retrying",
        );
        await pause(watch, pollMs);
        continue;
      }
      // Later waits stay on the turn the first one bound to.
      watch.turnId = result.turnId ?? watch.turnId;
      if (result.timedOut) continue;
      if (result.status === "pending") {
        await pause(watch, pollMs);
        continue;
      }
      if (result.needsPermission) {
        if (!permissionSent) {
          permissionSent = true;
          await onPermission(result);
        }
        await pause(watch, pollMs);
        continue;
      }
      return result;
    }
    return null;
  };

  const finalReason = (status: string): FinalReason => {
    if (status === "error") return "errored";
    if (status === "closed") return "closed";
    return "finished";
  };

  const watchUntilFinished = async (watch: ActiveWatch) => {
    const result = await waitForTurnEnd(watch, (blocked) =>
      fire(watch, "needs_permission", blocked),
    );
    if (result) {
      await fire(watch, finalReason(result.status), result);
      return;
    }
    record({
      event: "gave_up",
      ts: new Date().toISOString(),
      watchId: watch.armed.watchId,
      agentId: watch.armed.agentId,
      why: "agent still running at the watch deadline",
    });
  };

  // A watch-shaped view of a group (or, given an agent, of one member), for the shared wait and send paths.
  const groupWatch = (
    armed: GroupArmedEntry,
    binding: McpClientBinding,
    controller: AbortController,
    member?: GroupArmedEntry["agents"][number],
  ): ActiveWatch => ({
    armed: {
      event: "armed",
      ts: armed.ts,
      watchId: member ? `${armed.watchId}:${member.agentId}` : armed.watchId,
      client: armed.client,
      agentId: member?.agentId ?? armed.agentId,
      host: member?.host ?? null,
      tool: armed.tool,
      context: armed.context,
      turnId: member?.turnId ?? null,
      deadline: armed.deadline,
    },
    binding,
    controller,
    turnId: member?.turnId ?? null,
  });

  /**
   * One wait per member that has not ended, then one group event once all
   * have. A restored group first waits for each local member's resumed run,
   * since the restart closed it.
   */
  const watchGroup = async (
    group: PendingGroup,
    binding: McpClientBinding,
    controller: AbortController,
    restored: boolean,
  ) => {
    const { armed, ended } = group;
    await Promise.all(
      armed.agents
        .filter((agent) => !ended.has(agent.agentId))
        .map(async (agent) => {
          const member = groupWatch(armed, binding, controller, agent);
          const interrupted = restored ? await awaitResume(member) : null;
          // Per-agent watches already POST needs_permission; without them the group does.
          const result =
            interrupted ??
            (await waitForTurnEnd(member, (blocked) =>
              armed.perAgent ? Promise.resolve() : fire(member, "needs_permission", blocked),
            ));
          if (!result) return;
          const reason = interrupted ? "interrupted" : finalReason(result.status);
          const payload = { ...agentPayload(agent.agentId, result, member.turnId), reason };
          ended.set(agent.agentId, payload);
          record({
            event: "member_ended",
            ts: new Date().toISOString(),
            watchId: armed.watchId,
            agentId: agent.agentId,
            reason,
            agent: payload,
          });
        }),
    );
    const groupIds = { watchId: armed.watchId, agentId: armed.agentId };
    if (ended.size !== armed.agents.length) {
      record({
        event: "gave_up",
        ts: new Date().toISOString(),
        ...groupIds,
        why: "an agent was still running at the group deadline",
      });
      return;
    }
    const body = JSON.stringify({
      type: "paseo.agents.group_finished",
      client: armed.client,
      context: armed.context,
      groupId: armed.watchId,
      agents: armed.agents.map((agent) => ended.get(agent.agentId)),
      trigger: { tool: armed.tool, requestedAt: armed.ts },
    });
    record({
      event: "fired",
      ts: new Date().toISOString(),
      ...groupIds,
      reason: "finished",
      status: "finished",
      body,
    });
    await send(groupWatch(armed, binding, controller), "finished", body);
  };

  const start = (
    armed: ArmedEntry,
    binding: McpClientBinding,
    run: (watch: ActiveWatch) => Promise<void>,
  ): Promise<void> => {
    const watch: ActiveWatch = {
      armed,
      binding,
      controller: new AbortController(),
      turnId: armed.turnId,
    };
    active.set(armed.watchId, watch);
    return run(watch)
      .catch((error) => {
        if (error instanceof WatchSuspendedError) return;
        logger.error(
          {
            watchId: armed.watchId,
            client: armed.client,
            agentId: armed.agentId,
            err: String(error),
          },
          "mcp finish watch failed",
        );
      })
      .finally(() => {
        active.delete(armed.watchId);
      })
      .then(() => journal?.flush());
  };

  const startGroup = (
    armed: GroupArmedEntry,
    run: (controller: AbortController) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController();
    activeGroups.set(armed.watchId, controller);
    return run(controller)
      .catch((error) => {
        if (error instanceof WatchSuspendedError) return;
        logger.error(
          { client: armed.client, groupId: armed.watchId, err: String(error) },
          "mcp group watch failed",
        );
      })
      .finally(() => {
        activeGroups.delete(armed.watchId);
      })
      .then(() => journal?.flush());
  };

  const arm = (input: ArmMcpFinishNotification): Promise<void> => {
    const now = new Date();
    const armed: ArmedEntry = {
      event: "armed",
      ts: now.toISOString(),
      watchId: randomUUID(),
      client: input.client,
      agentId: input.agentId,
      host: input.host ?? null,
      tool: input.tool,
      context: input.context,
      turnId: input.turnId ?? options.localAgents?.activeTurnId(input.agentId) ?? null,
      deadline: now.getTime() + maxWatchMs,
    };
    record(armed);
    // Armed while shutting down: journaled, so the next process restores it.
    if (suspended) return Promise.resolve();
    return start(armed, input, watchUntilFinished);
  };

  return {
    arm,

    armGroup(input) {
      if (input.perAgent) {
        for (const agent of input.agents) {
          void arm({
            ...agent,
            client: input.client,
            target: input.target,
            waitForAgent: input.waitForAgent,
            tool: input.tool,
            context: input.context,
          });
        }
      }
      const now = new Date();
      const armed: GroupArmedEntry = {
        event: "group_armed",
        ts: now.toISOString(),
        watchId: input.groupId,
        agentId: input.groupId,
        client: input.client,
        tool: input.tool,
        context: input.context,
        perAgent: input.perAgent,
        deadline: now.getTime() + maxWatchMs,
        agents: input.agents.map((agent) => ({
          agentId: agent.agentId,
          host: agent.host ?? null,
          turnId: agent.turnId ?? options.localAgents?.activeTurnId(agent.agentId) ?? null,
        })),
      };
      record(armed);
      // Armed while shutting down: journaled, so the next process restores it.
      if (suspended) return Promise.resolve();
      return startGroup(armed, (controller) =>
        watchGroup({ armed, ended: new Map(), unsent: null }, input, controller, false),
      );
    },

    async restore(resolveClient) {
      if (!journal) return { restored: 0, settled: Promise.resolve() };
      const entries = await journal.read((all) => {
        const { watches, groups } = pendingFromJournal(all);
        return new Set([...watches, ...groups].map((pending) => pending.armed.watchId));
      });
      const { watches, groups } = pendingFromJournal(entries);
      // Records why a pending watch or group is dropped, else that it is restored.
      const admit = async (armed: ArmedEntry | GroupArmedEntry) => {
        const ids = {
          ts: new Date().toISOString(),
          watchId: armed.watchId,
          agentId: armed.agentId,
        };
        if (Date.now() >= armed.deadline) {
          record({
            event: "gave_up",
            ...ids,
            why: "watch deadline passed while the daemon was down",
          });
          return null;
        }
        const binding = await resolveClient(armed.client).catch(() => null);
        if (!binding) {
          const why = `client "${armed.client}" has no notify webhook configured`;
          record({ event: "gave_up", ...ids, why });
          return null;
        }
        record({ event: "restored", ...ids });
        return binding;
      };
      const runs: Promise<void>[] = [];
      for (const { armed, unsent } of watches) {
        const binding = await admit(armed);
        if (!binding) continue;
        runs.push(
          start(armed, binding, async (watch) => {
            if (unsent) {
              await send(watch, unsent.reason, unsent.body);
              return;
            }
            const interrupted = await awaitResume(watch);
            if (interrupted) await fire(watch, "interrupted", interrupted);
            else await watchUntilFinished(watch);
          }),
        );
      }
      for (const group of groups) {
        const binding = await admit(group.armed);
        if (!binding) continue;
        runs.push(
          startGroup(group.armed, async (controller) => {
            if (group.unsent) {
              await send(groupWatch(group.armed, binding, controller), "finished", group.unsent);
              return;
            }
            await watchGroup(group, binding, controller, true);
          }),
        );
      }
      return { restored: runs.length, settled: Promise.all(runs).then(() => undefined) };
    },

    async suspend() {
      suspended = true;
      const ts = new Date().toISOString();
      for (const [groupId, controller] of activeGroups) {
        controller.abort();
        record({ event: "suspended", ts, watchId: groupId, agentId: groupId });
      }
      for (const watch of active.values()) {
        watch.controller.abort();
        record({
          event: "suspended",
          ts,
          watchId: watch.armed.watchId,
          agentId: watch.armed.agentId,
        });
      }
      await journal?.flush();
    },
  };
}

/** The agents an AgentManager hosts, as a restored watch needs them. */
export function createMcpFinishLocalAgents(deps: {
  agentManager: Pick<AgentManager, "getAgent" | "subscribe">;
  agentStorage: Pick<AgentStorage, "get">;
}): McpFinishLocalAgents {
  const { agentManager, agentStorage } = deps;
  return {
    activeTurnId: (agentId) => agentManager.getAgent(agentId)?.activeForegroundTurnId ?? null,
    waitForRunStart: (agentId, signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<McpFinishRunStart>();
      if (signal.aborted) {
        reject(signal.reason);
        return promise;
      }
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        signal.removeEventListener("abort", onAbort);
        finish();
      };
      const onAbort = () => settle(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      // The subscription replays the current state, so an agent already running resolves at once.
      const stop = agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_state" || event.agent.lifecycle !== "running") return;
          const turnId = event.agent.activeForegroundTurnId ?? null;
          settle(() => resolve({ local: true, turnId }));
        },
        { agentId, replayState: true },
      );
      if (settled) stop();
      else unsubscribe = stop;
      const settleUnlessHostedHere = async () => {
        const stored = await agentStorage.get(agentId).catch(() => null);
        if (!stored && !agentManager.getAgent(agentId)) {
          settle(() => resolve({ local: false, turnId: null }));
        }
      };
      void settleUnlessHostedHere();
      return promise;
    },
  };
}
