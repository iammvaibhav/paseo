import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-wait.js";
import { writeFileAtomic } from "../atomic-file.js";
import type { RemoteMcpClient } from "../persisted-config.js";
import type { ResolveSecret } from "../secrets/vault-secret.js";

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
 * Group watches (armGroup) live in memory only: a restart drops the group
 * event, while the per-agent watches it armed are journaled as usual.
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
   * complete the group. In memory only: a restart drops the group event.
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
// The journal is rewritten down to its pending watches past this size.
const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;
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
  | { event: "gave_up"; ts: string; watchId: string; agentId: string; why: string };

interface PendingWatch {
  armed: ArmedEntry;
  /** A final event fired but never confirmed delivered or failed. */
  unsent: { reason: NotifyReason; body: string } | null;
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
    if (entry.event === "gave_up") {
      pending.delete(entry.watchId);
    } else if (entry.event === "fired") {
      watch.unsent = entry.reason === "needs_permission" ? null : entry;
    } else if (entry.event === "delivered" || entry.event === "failed") {
      if (entry.reason === "needs_permission") continue;
      pending.delete(entry.watchId);
    }
  }
  return [...pending.values()];
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
  let suspended = false;
  let journalWrites: Promise<void> = Promise.resolve();
  let journalDirReady = false;

  const appendToJournal = async (journalPath: string, entry: JournalEntry) => {
    try {
      if (!journalDirReady) {
        await fs.mkdir(path.dirname(journalPath), { recursive: true });
        journalDirReady = true;
      }
      await fs.appendFile(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      logger.error(
        { err: String(error), watchId: entry.watchId },
        "mcp finish journal write failed",
      );
    }
  };

  // Logs the transition and appends it to the journal, in call order.
  const record = (entry: JournalEntry) => {
    const { body: _body, ...fields } = entry as JournalEntry & { body?: string };
    const level = entry.event === "failed" || entry.event === "gave_up" ? "warn" : "info";
    logger[level](fields, `mcp finish watch ${entry.event}`);
    const journalPath = options.journalPath;
    if (!journalPath) return;
    journalWrites = journalWrites.then(() => appendToJournal(journalPath, entry));
  };

  const readJournal = async (journalPath: string): Promise<JournalEntry[]> => {
    let raw: string;
    try {
      raw = await fs.readFile(journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A torn final line from a crash mid-append; the rest of the journal stands.
      }
    }
    if (Buffer.byteLength(raw) > JOURNAL_COMPACT_BYTES) {
      const keep = new Set(pendingWatches(entries).map((watch) => watch.armed.watchId));
      const kept = entries.filter((entry) => keep.has(entry.watchId));
      await writeFileAtomic(
        journalPath,
        kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
    }
    return entries;
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
  // run, or report the interruption once the grace period passes without one.
  // Returns false when the watch is settled here.
  const awaitResume = async (watch: ActiveWatch): Promise<boolean> => {
    const localAgents = options.localAgents;
    if (!localAgents) return true;
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
      return true;
    } catch (error) {
      if (signal.aborted) throw new WatchSuspendedError();
      if (!grace.aborted) throw error;
    }
    // The agent is not running, so this returns at once with its final state.
    const result = await watch.binding.waitForAgent({
      agentId: watch.armed.agentId,
      ...(watch.armed.host ? { host: watch.armed.host } : {}),
      timeoutMs: 1_000,
    });
    await fire(watch, "interrupted", result);
    return false;
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

  const groupControllers = new Set<AbortController>();

  /** The in-memory group watch: one wait per agent, one group event once all have ended. */
  const watchGroup = async (input: ArmMcpGroupNotification, controller: AbortController) => {
    const now = new Date();
    const members: ActiveWatch[] = input.agents.map((agent) => {
      const turnId = agent.turnId ?? options.localAgents?.activeTurnId(agent.agentId) ?? null;
      return {
        // Not journaled: the group is in memory only, so a restart never restores a member.
        armed: {
          event: "armed",
          ts: now.toISOString(),
          watchId: `${input.groupId}:${agent.agentId}`,
          client: input.client,
          agentId: agent.agentId,
          host: agent.host ?? null,
          tool: input.tool,
          context: input.context,
          turnId,
          deadline: now.getTime() + maxWatchMs,
        },
        binding: input,
        controller,
        turnId,
      };
    });
    // Per-agent watches already POST needs_permission; without them the group does.
    const results = await Promise.all(
      members.map((member) =>
        waitForTurnEnd(member, (blocked) =>
          input.perAgent ? Promise.resolve() : fire(member, "needs_permission", blocked),
        ),
      ),
    );
    const finished = results.filter((result): result is FleetAgentWaitResult => result !== null);
    if (finished.length !== results.length) {
      logger.warn(
        { client: input.client, groupId: input.groupId },
        "mcp group watch gave up: an agent was still running at the watch deadline",
      );
      return;
    }
    const groupWatch: ActiveWatch = {
      armed: { ...members[0]!.armed, watchId: input.groupId, agentId: input.groupId },
      binding: input,
      controller,
      turnId: null,
    };
    const body = JSON.stringify({
      type: "paseo.agents.group_finished",
      client: input.client,
      context: input.context,
      groupId: input.groupId,
      agents: finished.map((result, index) =>
        agentPayload(members[index]!.armed.agentId, result, members[index]!.turnId),
      ),
      trigger: { tool: input.tool, requestedAt: now.toISOString() },
    });
    await send(groupWatch, "finished", body);
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
      .then(() => journalWrites);
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
      if (suspended) return Promise.resolve();
      const controller = new AbortController();
      groupControllers.add(controller);
      return watchGroup(input, controller)
        .catch((error) => {
          if (error instanceof WatchSuspendedError) return;
          logger.error(
            { client: input.client, groupId: input.groupId, err: String(error) },
            "mcp group watch failed",
          );
        })
        .finally(() => {
          groupControllers.delete(controller);
        });
    },

    async restore(resolveClient) {
      if (!options.journalPath) return { restored: 0, settled: Promise.resolve() };
      const runs: Promise<void>[] = [];
      for (const { armed, unsent } of pendingWatches(await readJournal(options.journalPath))) {
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
          continue;
        }
        const binding = await resolveClient(armed.client).catch(() => null);
        if (!binding) {
          const why = `client "${armed.client}" has no notify webhook configured`;
          record({ event: "gave_up", ...ids, why });
          continue;
        }
        record({ event: "restored", ...ids });
        runs.push(
          start(armed, binding, async (watch) => {
            if (unsent) {
              await send(watch, unsent.reason, unsent.body);
              return;
            }
            if (await awaitResume(watch)) await watchUntilFinished(watch);
          }),
        );
      }
      return { restored: runs.length, settled: Promise.all(runs).then(() => undefined) };
    },

    async suspend() {
      suspended = true;
      // Group watches are in memory only: a restart drops them.
      for (const controller of groupControllers) controller.abort();
      for (const watch of active.values()) {
        watch.controller.abort();
        record({
          event: "suspended",
          ts: new Date().toISOString(),
          watchId: watch.armed.watchId,
          agentId: watch.armed.agentId,
        });
      }
      await journalWrites;
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
