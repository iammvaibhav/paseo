import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
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
 * Every per-agent arm also records a subscription: the client wants to hear
 * about this agent's runs. /mcp/fleet arms follow-up sends to a subscribed
 * agent by default, so a client that asked once at create time keeps
 * hearing about the runs its later prompts start. A send with
 * notifyOnFinish: false unsubscribes. Subscriptions are rebuilt from the
 * journal's armed/unsubscribed entries and lapse SUBSCRIPTION_TTL_MS after
 * the client's last arm on the agent.
 *
 * Watches survive a daemon restart. Every watch transition (armed, fired,
 * delivered, failed, suspended, restored, interrupted, resumed, gave_up) is
 * appended to a JSONL journal, which doubles as the queryable delivery
 * record. On shutdown the daemon suspends its watches before closing agents,
 * so the shutdown's "closed" state is never reported as the run's end; the
 * next process restores every watch the journal still shows pending. A
 * restart interrupts this daemon's own agents, so a restored watch on one of
 * them waits for the agent's resumed run (the deploy nudge restarts it),
 * rebinds to that run's turn, and reports its end, or reason "interrupted"
 * when no run resumes within resumeGraceMs. Delivery of final events is
 * at-least-once: one fired but not confirmed before the restart is sent again.
 *
 * Group watches (armGroup) are journaled the same way: the group, each
 * member's end as it lands, and the group event. A restored group keeps the
 * members that already ended and waits out the rest, so the group event is
 * sent once every member's run has ended, across restarts.
 *
 * A peer's restart (a deploy, a crash) closes the agents it hosts, so a wait
 * on a peer agent can end "closed" while its run has not finished, or, when
 * the connection drops before that close arrives, the restarted peer answers
 * "pending" for a turn it no longer knows. Neither is the run's end: the
 * watch posts a non-final paseo.agent.interrupted event, stays armed,
 * follows the run the peer resumes (the peer's deploy nudge starts it as a
 * new turn), and posts paseo.agent.finished when that run ends, or reason
 * "interrupted" when no run resumes within resumeGraceMs.
 * Only an agent this daemon hosts can be closed while its watch runs on
 * purpose (archive, kill), since this daemon's own shutdown suspends watches
 * first; that "closed" stays final.
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

export interface ArmMcpStatusReportNotification {
  client: string;
  target: McpNotifyTarget;
  requestId: string;
  agentId: string;
  host: string;
  title: string | null;
  turnId?: string | null;
  context?: string | null;
  waitForAgent: McpFinishWaitForAgent;
  subscribeSelfReports?: (listener: (event: MissionControlEvent) => void) => () => void;
  peerClient?: DaemonClient | null;
  timeoutMs?: number;
}

export function eventToReportStatus(
  event: MissionControlEvent,
): "working" | "completed" | "inconclusive" | "blocked" {
  if (event.reportStatus) return event.reportStatus;
  if (event.kind === "finished") return "completed";
  if (event.kind === "blocked") return "blocked";
  if (event.kind === "diverged") return "inconclusive";
  return "working";
}

/** A run starting on a watched agent; `local: false` when this daemon does not host it. */
export interface McpFinishRunStart {
  local: boolean;
  turnId: string | null;
}

export interface McpFinishSubscription {
  /** The notifyContext of the client's latest arm on the agent. */
  context: string | null;
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
  /** Whether this daemon hosts the agent (live or stored). */
  hosts(agentId: string): Promise<boolean>;
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
  /**
   * How long a watch waits for an interrupted run to resume: a local agent's
   * run after this daemon restarts, or a peer agent's run after its host closed it.
   */
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
   * Watch for an agent's next report_status and POST paseo.agent.status_reported
   * to the caller's webhook. If 5 minutes pass or the turn ends first without a
   * report, POSTs with status: "no_report".
   */
  armStatusReport(input: ArmMcpStatusReportNotification): void;
  /**
   * The client's standing request to hear about an agent's runs: set by every
   * per-agent arm, so a follow-up send to the agent arms by default. Null when
   * the client never armed a watch on the agent, unsubscribed, or last armed
   * one more than SUBSCRIPTION_TTL_MS ago.
   */
  subscription(client: string, agentId: string): McpFinishSubscription | null;
  /** Drop the client's standing request for the agent (a send with notifyOnFinish: false). */
  unsubscribe(client: string, agentId: string): void;
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
/** A subscription lapses this long after the client last armed a watch on the agent. */
export const SUBSCRIPTION_TTL_MS = 30 * 24 * 60 * 60_000;
const LAST_MESSAGE_LIMIT = 4000;
/** One probe for the turn a peer agent runs now; a running agent holds it this long. */
const RESUME_PROBE_MS = 1_000;
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
      /** False for events that leave the watch armed; absent in older entries (needs_permission was the only one). */
      final?: boolean;
      status: string;
      body: string;
    }
  | {
      event: "delivered";
      ts: string;
      watchId: string;
      agentId: string;
      reason: NotifyReason;
      final?: boolean;
      status: number;
      attempts: number;
    }
  | {
      event: "failed";
      ts: string;
      watchId: string;
      agentId: string;
      reason: NotifyReason;
      final?: boolean;
      status: number | null;
      attempts: number;
      error: string | null;
    }
  | { event: "suspended"; ts: string; watchId: string; agentId: string }
  | { event: "restored"; ts: string; watchId: string; agentId: string }
  | { event: "resumed"; ts: string; watchId: string; agentId: string; turnId: string | null }
  /** A peer closed the agent mid-run; the watch now waits for the run it resumes. */
  | { event: "interrupted"; ts: string; watchId: string; agentId: string; turnId: string | null }
  | { event: "gave_up"; ts: string; watchId: string; agentId: string; why: string }
  /** The client asked to stop hearing about the agent's later runs. */
  | { event: "unsubscribed"; ts: string; watchId: string; agentId: string; client: string }
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

/** Where a watch's run stands: the turn it is bound to, and whether a peer closed that turn mid-run. */
interface RunBinding {
  turnId: string | null;
  /** The peer closed the bound turn; the watch awaits the run the peer resumes. */
  interrupted: boolean;
}

interface PendingWatch {
  armed: ArmedEntry;
  /** A final event fired but never confirmed delivered or failed. */
  unsent: { reason: NotifyReason; body: string } | null;
  run: RunBinding;
}

interface PendingGroup {
  armed: GroupArmedEntry;
  /** Members whose bound run has ended, by agent id. */
  ended: Map<string, GroupMemberPayload>;
  /** The group event fired but never confirmed delivered or failed. */
  unsent: string | null;
  /** Members rebound or interrupted since the group was armed, by agent id. */
  runs: Map<string, RunBinding>;
}

interface ActiveWatch extends RunBinding {
  armed: ArmedEntry;
  binding: McpClientBinding;
  controller: AbortController;
  /** The state the peer reported when it closed the run; the terminal event's fallback. */
  interruptedResult: FleetAgentWaitResult | null;
}

/** Older journal entries carry no `final`; needs_permission was the only non-final event then. */
function isFinal(entry: { reason: NotifyReason; final?: boolean }): boolean {
  return entry.final ?? entry.reason !== "needs_permission";
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

/** Applies a journaled interruption or resume to a run binding. */
function replayRunEntry(run: RunBinding, entry: JournalEntry): void {
  if (entry.event === "interrupted") run.interrupted = true;
  if (entry.event === "resumed") {
    run.turnId = entry.turnId ?? run.turnId;
    run.interrupted = false;
  }
}

/**
 * A group member's own entries carry "<groupId>:<agentId>"; applies one to
 * that member's run binding. Returns false when the entry is not a member's.
 */
function replayMemberEntry(groups: Map<string, PendingGroup>, entry: JournalEntry): boolean {
  const memberSuffix = `:${entry.agentId}`;
  if (!entry.watchId.endsWith(memberSuffix)) return false;
  const group = groups.get(entry.watchId.slice(0, -memberSuffix.length));
  const member = group?.armed.agents.find((agent) => agent.agentId === entry.agentId);
  if (!group || !member) return false;
  const run = group.runs.get(entry.agentId) ?? { turnId: member.turnId, interrupted: false };
  replayRunEntry(run, entry);
  group.runs.set(entry.agentId, run);
  return true;
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
      watches.set(entry.watchId, {
        armed: entry,
        unsent: null,
        run: { turnId: entry.turnId, interrupted: false },
      });
      continue;
    }
    if (entry.event === "group_armed") {
      groups.set(entry.watchId, { armed: entry, ended: new Map(), unsent: null, runs: new Map() });
      continue;
    }
    if (replayMemberEntry(groups, entry)) continue;
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
      watch.unsent = isFinal(entry) ? entry : null;
    } else if (entry.event === "delivered" || entry.event === "failed") {
      if (isFinal(entry)) watches.delete(entry.watchId);
    } else {
      replayRunEntry(watch.run, entry);
    }
  }
  return { watches: [...watches.values()], groups: [...groups.values()] };
}

/** A client's standing request for an agent: its latest arm on the agent. */
interface SubscriptionRecord extends McpFinishSubscription {
  armedAt: number;
  /** The latest arm's watch; compaction keeps its entries, so the subscription survives it. */
  watchId: string;
}

const subscriptionKey = (client: string, agentId: string) => `${client}\u0000${agentId}`;

/** The subscriptions the journal shows live at `now`: armed, not since unsubscribed, not lapsed. */
function subscriptionsFromJournal(
  entries: readonly JournalEntry[],
  now: number,
): Map<string, SubscriptionRecord> {
  const subscriptions = new Map<string, SubscriptionRecord>();
  for (const entry of entries) {
    if (entry.event === "armed") {
      subscriptions.set(subscriptionKey(entry.client, entry.agentId), {
        context: entry.context,
        armedAt: Date.parse(entry.ts),
        watchId: entry.watchId,
      });
    } else if (entry.event === "unsubscribed") {
      subscriptions.delete(subscriptionKey(entry.client, entry.agentId));
    }
  }
  for (const [key, subscription] of subscriptions) {
    if (now - subscription.armedAt >= SUBSCRIPTION_TTL_MS) subscriptions.delete(key);
  }
  return subscriptions;
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
  const activeStatusWatches = new Map<string, () => void>();
  let suspended = false;
  const subscriptions = new Map<string, SubscriptionRecord>();
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

  // `final` is false for events that leave the watch armed: needs_permission,
  // and interrupted while the watch waits for the run a peer resumes.
  const buildBody = (
    armed: ArmedEntry,
    reason: NotifyReason,
    final: boolean,
    result: FleetAgentWaitResult,
  ): string => {
    let type = "paseo.agent.finished";
    if (reason === "needs_permission") type = "paseo.agent.needs_permission";
    else if (!final) type = "paseo.agent.interrupted";
    return JSON.stringify({
      type,
      reason,
      final,
      client: armed.client,
      context: armed.context,
      agent: agentPayload(armed.agentId, result, armed.turnId),
      trigger: { tool: armed.tool, requestedAt: armed.ts },
    });
  };

  // POSTs one event, retrying network errors, 429 and 5xx. A suspend during a
  // retry pause leaves the event fired-but-unsent, so restore() sends it again.
  const send = async (watch: ActiveWatch, reason: NotifyReason, final: boolean, body: string) => {
    const { armed, binding, controller } = watch;
    const headers = await resolveHeaders(binding.target.headers);
    const ids = { watchId: armed.watchId, agentId: armed.agentId, reason, final };
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

  const sendStatusReport = async (
    client: string,
    target: McpNotifyTarget,
    requestId: string,
    body: string,
  ) => {
    const headers = await resolveHeaders(target.headers);
    for (let attempt = 0; ; attempt += 1) {
      let status: number | null = null;
      let error: string | null = null;
      try {
        const response = await fetchImpl(target.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        if (response.ok) {
          logger.info(
            { client, requestId, status, attempts: attempt + 1 },
            "mcp status report notification delivered",
          );
          return;
        }
        error = (await response.text().catch(() => "")).slice(0, RESPONSE_SNIPPET_LIMIT) || null;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      logger.warn(
        { client, requestId, status, err: error, attempt: attempt + 1 },
        "mcp status report notification attempt failed",
      );
      const retryable = status === null || status === 429 || status >= 500;
      const delay = retryDelaysMs[attempt];
      if (!retryable || delay === undefined) {
        logger.error(
          { client, requestId, status, attempts: attempt + 1, error },
          "mcp status report notification failed permanently",
        );
        return;
      }
      await sleep(delay).catch(() => undefined);
    }
  };

  const fire = async (
    watch: ActiveWatch,
    reason: NotifyReason,
    final: boolean,
    result: FleetAgentWaitResult,
  ) => {
    const body = buildBody(watch.armed, reason, final, result);
    record({
      event: "fired",
      ts: new Date().toISOString(),
      watchId: watch.armed.watchId,
      agentId: watch.armed.agentId,
      reason,
      final,
      status: result.status,
      body,
    });
    await send(watch, reason, final, body);
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
   * null at the deadline. onPermission runs once per blocked stretch. A
   * "pending" turn is waited out, unless the host was unreachable since the
   * watch started: a host that restarted before its close reached us has
   * lost the turn, so "pending" is returned for the caller to treat as an
   * interruption.
   */
  const waitForTurnEnd = async (
    watch: ActiveWatch,
    onPermission: (result: FleetAgentWaitResult) => Promise<void>,
  ): Promise<FleetAgentWaitResult | null> => {
    const { armed } = watch;
    let permissionSent = false;
    let contactLost = false;
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
        contactLost = true;
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
        contactLost = true;
        await pause(watch, pollMs);
        continue;
      }
      // Later waits stay on the turn the first one bound to.
      watch.turnId = result.turnId ?? watch.turnId;
      if (result.timedOut) continue;
      if (result.status === "pending") {
        if (contactLost) return result;
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
    if (status === "interrupted") return "interrupted";
    return "finished";
  };

  /**
   * Probe the peer for a run newer than the interrupted turn until one
   * appears or resumeGraceMs passes. A probe carries no turnId, so it binds to
   * the run in progress (or reports the newest turn when idle). Returns the
   * resumed turn, or null at the grace deadline.
   */
  const awaitPeerResume = async (watch: ActiveWatch): Promise<string | null> => {
    const { armed } = watch;
    const graceEnd = Math.min(Date.now() + resumeGraceMs, armed.deadline);
    while (Date.now() < graceEnd) {
      const probe = await unlessAborted(
        watch.binding.waitForAgent({
          agentId: armed.agentId,
          ...(armed.host ? { host: armed.host } : {}),
          timeoutMs: RESUME_PROBE_MS,
        }),
        watch.controller.signal,
      ).catch((error: unknown) => {
        if (error instanceof WatchSuspendedError) throw error;
        return null;
      });
      // While the peer restarts, probes fail or report the closed turn.
      if (probe?.ok && probe.turnId && probe.turnId !== watch.turnId) return probe.turnId;
      await pause(watch, pollMs);
    }
    return null;
  };

  /**
   * Wait until the watch's run really ends. A peer agent whose turn ends
   * "closed", or a turn the host lost across a restart ("pending" after the
   * host was unreachable), was stopped by its host, not finished:
   * onInterrupted runs, the watch rebinds to the run the peer resumes, and
   * waiting goes on. Returns the end with its reason ("interrupted" when no
   * run resumed in time), or null at the watch deadline.
   */
  const waitForRunEnd = async (
    watch: ActiveWatch,
    onPermission: (result: FleetAgentWaitResult) => Promise<void>,
    onInterrupted: (result: FleetAgentWaitResult) => Promise<void>,
  ): Promise<{ result: FleetAgentWaitResult; reason: FinalReason } | null> => {
    const ids = { watchId: watch.armed.watchId, agentId: watch.armed.agentId };
    for (;;) {
      if (!watch.interrupted) {
        const result = await waitForTurnEnd(watch, onPermission);
        if (!result) return null;
        const closedByPeer =
          result.status === "closed" &&
          !((await options.localAgents?.hosts(watch.armed.agentId)) ?? false);
        if (result.status !== "pending" && !closedByPeer) {
          return { result, reason: finalReason(result.status) };
        }
        watch.interrupted = true;
        watch.interruptedResult = result;
        record({
          event: "interrupted",
          ts: new Date().toISOString(),
          ...ids,
          turnId: watch.turnId,
        });
        await onInterrupted(result);
      }
      const resumedTurnId = await awaitPeerResume(watch);
      if (!resumedTurnId) {
        const result =
          watch.interruptedResult ??
          (await watch.binding.waitForAgent({
            agentId: watch.armed.agentId,
            ...(watch.armed.host ? { host: watch.armed.host } : {}),
            timeoutMs: RESUME_PROBE_MS,
          }));
        return { result, reason: "interrupted" };
      }
      watch.turnId = resumedTurnId;
      watch.interrupted = false;
      watch.interruptedResult = null;
      record({ event: "resumed", ts: new Date().toISOString(), ...ids, turnId: resumedTurnId });
    }
  };

  const watchUntilFinished = async (watch: ActiveWatch) => {
    const end = await waitForRunEnd(
      watch,
      (blocked) => fire(watch, "needs_permission", false, blocked),
      (closed) => fire(watch, "interrupted", false, closed),
    );
    if (end) {
      await fire(watch, end.reason, true, end.result);
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
    run?: RunBinding,
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
    turnId: run?.turnId ?? member?.turnId ?? null,
    interrupted: run?.interrupted ?? false,
    interruptedResult: null,
  });

  /**
   * One wait per member that has not ended, then one group event once all
   * have. A restored group first waits for each local member's resumed run,
   * since the restart closed it. A peer closing a member mid-run does not end
   * it: the member follows the run the peer resumes.
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
          const run = group.runs.get(agent.agentId);
          const member = groupWatch(armed, binding, controller, agent, run);
          const interrupted = restored && !member.interrupted ? await awaitResume(member) : null;
          // Per-agent watches already POST needs_permission and interrupted; without them the group does.
          const end = interrupted
            ? { result: interrupted, reason: "interrupted" as const }
            : await waitForRunEnd(
                member,
                (blocked) =>
                  armed.perAgent
                    ? Promise.resolve()
                    : fire(member, "needs_permission", false, blocked),
                (closed) =>
                  armed.perAgent ? Promise.resolve() : fire(member, "interrupted", false, closed),
              );
          if (!end) return;
          const { result, reason } = end;
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
      final: true,
      status: "finished",
      body,
    });
    await send(groupWatch(armed, binding, controller), "finished", true, body);
  };

  const start = (
    armed: ArmedEntry,
    binding: McpClientBinding,
    run: (watch: ActiveWatch) => Promise<void>,
    binds: RunBinding = { turnId: armed.turnId, interrupted: false },
  ): Promise<void> => {
    const watch: ActiveWatch = {
      armed,
      binding,
      controller: new AbortController(),
      ...binds,
      interruptedResult: null,
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
    const turnId = input.turnId ?? options.localAgents?.activeTurnId(input.agentId) ?? null;
    // A steer joins the run in progress, so a send can bind to the turn a
    // watch already follows; a second watch would POST the same event twice.
    if (turnId) {
      for (const watch of active.values()) {
        if (
          watch.armed.client === input.client &&
          watch.armed.agentId === input.agentId &&
          watch.armed.context === input.context &&
          watch.turnId === turnId
        ) {
          logger.info(
            { watchId: watch.armed.watchId, agentId: input.agentId, turnId, tool: input.tool },
            "mcp finish watch already armed for this turn",
          );
          return Promise.resolve();
        }
      }
    }
    const armed: ArmedEntry = {
      event: "armed",
      ts: now.toISOString(),
      watchId: randomUUID(),
      client: input.client,
      agentId: input.agentId,
      host: input.host ?? null,
      tool: input.tool,
      context: input.context,
      turnId,
      deadline: now.getTime() + maxWatchMs,
    };
    record(armed);
    subscriptions.set(subscriptionKey(input.client, input.agentId), {
      context: input.context,
      armedAt: now.getTime(),
      watchId: armed.watchId,
    });
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
        watchGroup(
          { armed, ended: new Map(), unsent: null, runs: new Map() },
          input,
          controller,
          false,
        ),
      );
    },

    armStatusReport(input) {
      if (suspended) return;
      const timeoutMs = input.timeoutMs ?? 5 * 60_000;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribeSelf: (() => void) | null = null;
      let peerObservation: { release: () => void } | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (unsubscribeSelf) {
          unsubscribeSelf();
          unsubscribeSelf = null;
        }
        if (peerObservation) {
          peerObservation.release();
          peerObservation = null;
        }
        activeStatusWatches.delete(input.requestId);
      };

      const settleAndSend = async (params: {
        status: "working" | "completed" | "inconclusive" | "blocked" | "no_report";
        headline: string;
        reportedAt: string;
        title?: string | null;
      }) => {
        if (settled) return;
        settled = true;
        cleanup();

        const payload: Record<string, unknown> = {
          type: "paseo.agent.status_reported",
          requestId: input.requestId,
          agentId: input.agentId,
          title: params.title ?? input.title,
          host: input.host,
          status: params.status,
          headline: params.headline,
          reportedAt: params.reportedAt,
        };
        if (input.context !== null && input.context !== undefined) {
          payload.context = input.context;
        }
        const body = JSON.stringify(payload);

        await sendStatusReport(input.client, input.target, input.requestId, body);
      };

      activeStatusWatches.set(input.requestId, cleanup);

      // 1. Local self-reports
      if (input.subscribeSelfReports) {
        unsubscribeSelf = input.subscribeSelfReports((event) => {
          if (event.agentId === input.agentId && event.source === "self") {
            void settleAndSend({
              status: eventToReportStatus(event),
              headline: event.headline,
              reportedAt: event.ts,
              title: event.agentTitle ?? input.title,
            });
          }
        });
      }

      // 2. Peer mission_control_event
      if (input.peerClient) {
        const observation = input.peerClient.observeEvents(["mission_control_event"]);
        peerObservation = observation;
        observation.subscribe({
          snapshot: () => undefined,
          update: (msg: unknown) => {
            const m = msg as { type?: string; event?: MissionControlEvent };
            if (
              m.type === "mission_control_event" &&
              m.event &&
              m.event.source === "self" &&
              m.event.agentId === input.agentId
            ) {
              void settleAndSend({
                status: eventToReportStatus(m.event),
                headline: m.event.headline,
                reportedAt: m.event.ts,
                title: m.event.agentTitle ?? input.title,
              });
            }
          },
        });
      }

      // 3. 5-minute timeout
      timer = setTimeout(() => {
        void settleAndSend({
          status: "no_report",
          headline: "",
          reportedAt: new Date().toISOString(),
        });
      }, timeoutMs);
      timer.unref?.();

      // 4. Turn-end listener (if turn ends first without report)
      void (async () => {
        try {
          if (input.turnId) {
            const result = await input.waitForAgent({
              agentId: input.agentId,
              host: input.host,
              turnId: input.turnId,
              timeoutMs,
            });
            if (!result.timedOut && !settled) {
              void settleAndSend({
                status: "no_report",
                headline: "",
                reportedAt: new Date().toISOString(),
                title: result.title ?? input.title,
              });
            }
          } else {
            await sleep(1500).catch(() => undefined);
            if (settled) return;
            const result = await input.waitForAgent({
              agentId: input.agentId,
              host: input.host,
              timeoutMs,
            });
            if (!result.timedOut && !settled) {
              void settleAndSend({
                status: "no_report",
                headline: "",
                reportedAt: new Date().toISOString(),
                title: result.title ?? input.title,
              });
            }
          }
        } catch {
          // Timeout covers any unexpected error
        }
      })();
    },

    subscription(client, agentId) {
      const subscription = subscriptions.get(subscriptionKey(client, agentId));
      if (!subscription || Date.now() - subscription.armedAt >= SUBSCRIPTION_TTL_MS) return null;
      return { context: subscription.context };
    },

    unsubscribe(client, agentId) {
      if (!subscriptions.delete(subscriptionKey(client, agentId))) return;
      record({
        event: "unsubscribed",
        ts: new Date().toISOString(),
        watchId: `unsubscribe:${randomUUID()}`,
        agentId,
        client,
      });
    },

    async restore(resolveClient) {
      if (!journal) return { restored: 0, settled: Promise.resolve() };
      const entries = await journal.read((all) => {
        const { watches, groups } = pendingFromJournal(all);
        const live = subscriptionsFromJournal(all, Date.now());
        return new Set([
          ...[...watches, ...groups].map((pending) => pending.armed.watchId),
          ...[...live.values()].map((subscription) => subscription.watchId),
        ]);
      });
      for (const [key, subscription] of subscriptionsFromJournal(entries, Date.now())) {
        // An arm made since startup is newer than anything the journal held.
        if (!subscriptions.has(key)) subscriptions.set(key, subscription);
      }
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
      for (const { armed, unsent, run } of watches) {
        const binding = await admit(armed);
        if (!binding) continue;
        runs.push(
          start(
            armed,
            binding,
            async (watch) => {
              if (unsent) {
                await send(watch, unsent.reason, true, unsent.body);
                return;
              }
              // A watch waiting on a peer's resume picks that wait back up.
              const interrupted = watch.interrupted ? null : await awaitResume(watch);
              if (interrupted) await fire(watch, "interrupted", true, interrupted);
              else await watchUntilFinished(watch);
            },
            run,
          ),
        );
      }
      for (const group of groups) {
        const binding = await admit(group.armed);
        if (!binding) continue;
        runs.push(
          startGroup(group.armed, async (controller) => {
            if (group.unsent) {
              await send(
                groupWatch(group.armed, binding, controller),
                "finished",
                true,
                group.unsent,
              );
              return;
            }
            await watchGroup(group, binding, controller, true);
          }),
        );
      }
      return { restored: runs.length, settled: Promise.all(runs).then(() => undefined) };
    },

    async suspend() {
      for (const cleanup of activeStatusWatches.values()) {
        cleanup();
      }
      activeStatusWatches.clear();
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
  const hosts = async (agentId: string) =>
    Boolean(agentManager.getAgent(agentId)) ||
    Boolean(await agentStorage.get(agentId).catch(() => null));
  return {
    hosts,
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
        if (!(await hosts(agentId))) settle(() => resolve({ local: false, turnId: null }));
      };
      void settleUnlessHostedHere();
      return promise;
    },
  };
}
