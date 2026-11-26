import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-wait.js";
import type { NotifyTargetConfig, NotifyTargetEvent } from "../persisted-config.js";
import type { ResolveSecret } from "../secrets/vault-secret.js";
import { createWatchJournal } from "../watch-journal.js";
import {
  createWebhookDeliveryLog,
  describeWebhookBody,
  type WebhookDeliveryAttempt,
  type WebhookDeliveryQuery,
  type WebhookDeliveryTotals,
} from "./webhook-delivery-log.js";

/**
 * Callbacks for agents started or prompted over /mcp/fleet. Every call names
 * the targets it wants (notifyTargets): named webhooks
 * (daemon.mcp.notifyTargets) and agents. A call that names none gets no
 * callback, and nothing carries over to later calls: each watch is bound to
 * one turn (the one the call started or joined, else the run in progress), so
 * a later turn reports only to the targets its own call named. Two callers
 * steering into one running turn both hear its end.
 *
 * The agent's own host runs the watch, so it follows its agent from local
 * events and can stream the agent's intermediate messages
 * (paseo.agent.message) to targets that ask for them.
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
 * Intermediate messages are not journaled: a restart mid-turn drops the ones
 * not yet sent.
 *
 * Each event carries a deliveryId (in the body and the X-Paseo-Delivery-Id
 * header) that every retry and every resend after a restart repeats, so the
 * receiver can drop duplicates. A failed POST is retried with exponential
 * backoff (the target's retryDelaysMs, else DEFAULT_RETRY_DELAYS_MS: 6
 * attempts over about 15 minutes) when it may succeed later: a network error,
 * 408, 425, 429, 5xx, or any 4xx whose body says the receiver is rate
 * limiting. Other 4xx fail at once. Messages retry for about a minute
 * (MESSAGE_RETRY_DELAYS_MS) and are then dropped, so one stuck message never
 * holds up the rest.
 *
 * An agent target gets the event as a prompt: it joins the agent's running
 * turn when the agent can live-steer, else it waits for that turn to end.
 *
 * Group watches (armGroup) are journaled the same way: the group, each
 * member's end as it lands, and the group event. A restored group keeps the
 * members that already ended and waits out the rest, so the group event is
 * sent once every member's run has ended, across restarts.
 *
 * A watch can still follow an agent on a peer (a caller's group of agents
 * across hosts, or a peer too old to run the watch itself). A peer's restart
 * (a deploy, a crash) closes the agents it hosts, so a wait on a peer agent
 * can end "closed" while its run has not finished, or, when the connection
 * drops before that close arrives, the restarted peer answers "pending" for a
 * turn it no longer knows. Neither is the run's end: the watch posts a
 * non-final paseo.agent.interrupted event, stays armed, follows the run the
 * peer resumes (the peer's deploy nudge starts it as a new turn), and posts
 * paseo.agent.finished when that run ends, or reason "interrupted" when no
 * run resumes within resumeGraceMs.
 * Only an agent this daemon hosts can be closed while its watch runs on
 * purpose (archive, kill), since this daemon's own shutdown suspends watches
 * first; that "closed" stays final.
 */
/** A named webhook (daemon.mcp.notifyTargets, without its name). */
export type McpWebhookTarget = Omit<NotifyTargetConfig, "name"> & { kind?: undefined };
/** An agent that gets each event as a prompt. */
export interface McpAgentTarget {
  kind: "agent";
  agentId: string;
}
/** Where a watch delivers. */
export type McpNotifyTarget = McpWebhookTarget | McpAgentTarget;

/** How a call names a target: a configured webhook by name, or an agent by id. */
export type McpNotifyTargetRef = { name: string } | { agent: string };

export function describeTargetRef(ref: McpNotifyTargetRef): string {
  return "name" in ref ? ref.name : `agent ${ref.agent}`;
}

/** One bounded wait, bound to turnId when given; the watcher calls it repeatedly until the turn ends. */
export type McpFinishWaitForAgent = (input: {
  agentId: string;
  host?: string;
  turnId?: string;
  timeoutMs: number;
}) => Promise<FleetAgentWaitResult>;

/** How a watch reaches its target: where it delivers, and how it follows the agent. */
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
  /** The target as the call named it; journaled so a restart can resolve it again. */
  targetRef: McpNotifyTargetRef;
  /**
   * The call's prompt waits for this turn to end (an agent that cannot
   * live-steer): bind to the first turn that starts after it instead.
   */
  nextTurnAfter?: string | null;
}

export interface ArmMcpGroupNotification extends McpClientBinding {
  client: string;
  groupId: string;
  agents: McpNotifyAgent[];
  /** Per-agent watches (armed separately) send needs_permission and interrupted; the group does not. */
  perAgent: boolean;
  tool: string;
  context: string | null;
  targetRef: McpNotifyTargetRef;
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

/** A block of assistant text the agent finished writing: the next item was not more text. */
export interface McpAssistantMessage {
  turnId: string | null;
  /** Timeline seq of the block's first row: increasing per agent, for ordering and dedupe. */
  seq: number;
  text: string;
  at: string;
}

/** The agents this daemon hosts: a restart interrupts their runs, unlike agents on peers. */
export interface McpFinishLocalAgents {
  /** The turn the agent runs now; null when idle or not hosted here. */
  activeTurnId(agentId: string): string | null;
  /**
   * Resolves once an agent hosted here starts a run (at once when it runs
   * now), with that run's turn id; a run of turn `notTurnId` does not count.
   * Resolves `{ local: false }` for an agent this daemon does not host.
   * Rejects when the signal aborts.
   */
  waitForRunStart(
    agentId: string,
    signal: AbortSignal,
    notTurnId?: string,
  ): Promise<McpFinishRunStart>;
  /** Whether this daemon hosts the agent (live or stored). */
  hosts(agentId: string): Promise<boolean>;
  /**
   * Calls onMessage with each assistant message block the agent completes
   * while subscribed. Returns the unsubscribe function.
   */
  subscribeAssistantMessages?(
    agentId: string,
    onMessage: (message: McpAssistantMessage) => void,
  ): () => void;
}

/** An event delivered to an agent target, as a prompt. */
export interface McpAgentDelivery {
  /** The agent that gets the prompt. */
  agentId: string;
  prompt: string;
  /** The agent the event is about. */
  aboutAgentId: string;
  aboutTitle: string | null;
  event: "finished" | "errored" | "permission-required" | "closed";
}

export interface McpFinishNotifierOptions {
  resolveSecret: ResolveSecret;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Watch journal (JSONL). Absent → watches live in memory only and restore() finds none. */
  journalPath?: string;
  /** Every webhook POST attempt (JSONL). Absent → attempts are only logged. */
  deliveryLogPath?: string;
  localAgents?: McpFinishLocalAgents;
  /** Give up watching an agent after this long, counted from arm, across restarts. */
  maxWatchMs?: number;
  /** One wait call's length; the watcher re-waits until maxWatchMs. */
  waitChunkMs?: number;
  /** Pause between checks while blocked on a permission, and after a failed wait. */
  pollMs?: number;
  /** Default delays before each delivery retry; its length + 1 is the attempt limit. */
  retryDelaysMs?: readonly number[];
  /** Delays before each intermediate-message retry. */
  messageRetryDelaysMs?: readonly number[];
  /** Hands an event to an agent target; throws when it could not be delivered. */
  deliverToAgent?: (delivery: McpAgentDelivery) => Promise<void>;
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
   * Watch a set of agents and deliver one paseo.agents.group_finished once
   * every agent's bound turn has ended. Without perAgent, the group also sends
   * each agent's needs_permission and interrupted events; they never complete
   * the group. Journaled: the group event survives a restart.
   */
  armGroup(input: ArmMcpGroupNotification): Promise<void>;
  /**
   * Watch for an agent's next report_status and POST paseo.agent.status_reported
   * to the caller's webhook. If 5 minutes pass or the turn ends first without a
   * report, POSTs with status: "no_report".
   */
  armStatusReport(input: ArmMcpStatusReportNotification): void;
  /**
   * POST one event that no watch owns (e.g. paseo.agent.reminder) to a target,
   * signed and retried like a finish event; every attempt is a delivery-log
   * row. Settles (never rejects) once delivered or given up on.
   */
  deliver(input: {
    client: string;
    target: McpNotifyTarget;
    /** Groups the delivery-log rows: the reminder or request id. */
    watchId: string;
    deliveryId: string;
    body: string;
  }): Promise<{
    delivered: boolean;
    status: number | null;
    attempts: number;
    error: string | null;
  }>;
  /** Recorded webhook POST attempts, newest first; empty without a delivery log. */
  listDeliveries(
    query: WebhookDeliveryQuery,
  ): Promise<{ totals: WebhookDeliveryTotals; deliveries: WebhookDeliveryAttempt[] }>;
  /**
   * Re-arm the watches a previous daemon process left pending. Call once at
   * startup, before the server accepts prompts, so a restored watch sees its
   * agent's resumed run start. `settled` resolves when every restored watch
   * has settled.
   */
  restore(
    resolveTarget: (client: string, ref: McpNotifyTargetRef) => Promise<McpClientBinding | null>,
  ): Promise<{ restored: number; settled: Promise<void> }>;
  /**
   * Daemon shutdown: stop every watch without delivering and flush the
   * journal; the watches stay pending for restore(). Call before agents close.
   */
  suspend(): Promise<void>;
}

export const MAX_NOTIFY_CONTEXT_LENGTH = 2000;
/** One probe for the turn a peer agent runs now; a running agent holds it this long. */
const RESUME_PROBE_MS = 1_000;
const RESPONSE_SNIPPET_LIMIT = 500;
const VAULT_REF = /aside:\/\/\S+/;
/** 6 attempts over about 15.5 minutes. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 120_000, 240_000, 480_000,
];
/** 4 attempts over about a minute: an intermediate message is only worth sending while it is fresh. */
export const MESSAGE_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 40_000];
const DEFAULT_MESSAGE_BATCH_MS = 2_000;
/** A 4xx body that says the receiver throttled the request (e.g. "Automation run rate limit exceeded"). */
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|throttl/i;

/** Whether a failed POST may succeed if sent again later. */
export function isRetryableWebhookFailure(status: number | null, response: string | null): boolean {
  if (status === null || status >= 500) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 400 && RATE_LIMIT_TEXT.test(response ?? "");
}

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
  /** Where the watch delivers. */
  targetRef: McpNotifyTargetRef;
  /** Bind to the first turn that starts after this one (the call's prompt waits for it to end). */
  nextTurnAfter?: string | null;
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
      /** The id the body carries; absent in older entries. */
      deliveryId?: string;
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
  /** The target does not take this event (its `events`); the watch is done. */
  | {
      event: "suppressed";
      ts: string;
      watchId: string;
      agentId: string;
      reason: "filtered";
    }
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
  targetRef: McpNotifyTargetRef;
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

/** How a watched run ended; the watch's final event. */
interface RunEnd {
  result: FleetAgentWaitResult;
  reason: FinalReason;
}

function sameTargetRef(a: McpNotifyTargetRef | undefined, b: McpNotifyTargetRef): boolean {
  if (!a) return false;
  return "name" in a ? "name" in b && a.name === b.name : "agent" in b && a.agent === b.agent;
}

interface PendingWatch {
  armed: ArmedEntry;
  /** A final event fired but never confirmed delivered or failed. */
  unsent: { reason: NotifyReason; body: string; deliveryId?: string } | null;
  run: RunBinding;
}

interface PendingGroup {
  armed: GroupArmedEntry;
  /** Members whose bound run has ended, by agent id. */
  ended: Map<string, GroupMemberPayload>;
  /** The group event fired but never confirmed delivered or failed. */
  unsent: { body: string; deliveryId?: string } | null;
  /** Members rebound or interrupted since the group was armed, by agent id. */
  runs: Map<string, RunBinding>;
}

interface ActiveWatch extends RunBinding {
  armed: ArmedEntry;
  binding: McpClientBinding;
  controller: AbortController;
  /** The state the peer reported when it closed the run; the terminal event's fallback. */
  interruptedResult: FleetAgentWaitResult | null;
  /** Intermediate messages streamed to the target; null when it does not take them. */
  messages: MessageStream | null;
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
        group.unsent = { body: entry.body, deliveryId: entry.deliveryId };
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
    if (entry.event === "gave_up" || entry.event === "suppressed") {
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

interface MessageStream {
  sentCount: number;
  /** The text of the last message delivered, trimmed. */
  lastSent: string | null;
  /** Stop listening, send what is pending, and settle once every send has. */
  stop(): Promise<void>;
}

interface Delivery {
  client: string;
  watchId: string;
  deliveryId: string;
  target: McpNotifyTarget;
  /** Resolved webhook headers; empty for an agent target. */
  headers: Record<string, string>;
  body: string;
  /** Delays before each retry; its length + 1 is the attempt limit. */
  delays: readonly number[];
}

interface AttemptResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  retryInMs: number | null;
}

/** The webhook name a watch reports as `notifyTarget`; null for an agent target. */
function targetName(armed: ArmedEntry | GroupArmedEntry): string | null {
  return "name" in armed.targetRef ? armed.targetRef.name : null;
}

function eventKind(reason: NotifyReason, final: boolean): NotifyTargetEvent {
  if (reason === "needs_permission") return "needs_permission";
  return final ? "finished" : "interrupted";
}

/** A webhook takes the events it lists (all when it lists none); an agent takes every one. */
function targetTakes(target: McpNotifyTarget, kind: NotifyTargetEvent): boolean {
  return target.kind === "agent" || !target.events || target.events.includes(kind);
}

type EventBody = Record<string, unknown> & {
  type?: string;
  reason?: string;
  context?: string | null;
  agent?: {
    id?: string;
    title?: string | null;
    lastMessage?: string | null;
    error?: string | null;
  };
};

/**
 * The prompt an agent target gets for an event body: what happened, the
 * caller's context, and the agent's final message.
 */
export function agentDeliveryFor(agentId: string, body: EventBody): McpAgentDelivery {
  const about = body.agent ?? {};
  const aboutAgentId = about.id ?? String(body.agentId ?? "unknown");
  const aboutTitle = about.title ?? (typeof body.title === "string" ? body.title : null);
  const name = aboutTitle ? `Agent ${aboutAgentId} (${aboutTitle})` : `Agent ${aboutAgentId}`;
  let event: McpAgentDelivery["event"] = "finished";
  let headline: string;
  switch (body.type) {
    case "paseo.agent.finished":
      if (body.reason === "errored") {
        event = "errored";
        headline = `${name} failed${about.error ? `: ${about.error}` : ""}.`;
      } else if (body.reason === "closed") {
        event = "closed";
        headline = `${name} was closed before its turn finished.`;
      } else if (body.reason === "interrupted") {
        headline = `${name} was interrupted before its turn finished.`;
      } else {
        headline = `${name} finished its turn.`;
      }
      break;
    case "paseo.agent.needs_permission":
      event = "permission-required";
      headline = `${name} is waiting for a permission decision (respond_to_permission).`;
      break;
    case "paseo.agent.interrupted":
      headline = `${name} was interrupted by a host restart; it reports again when its resumed run ends.`;
      break;
    case "paseo.agent.status_reported":
      headline = `${name} reported ${String(body.status)}: ${String(body.headline ?? "")}`.trim();
      break;
    default:
      headline = `Paseo event ${String(body.type)}:\n${JSON.stringify(body, null, 2)}`;
  }
  const sections = [headline];
  if (body.context) sections.push(`Your context: ${body.context}`);
  if (about.lastMessage) sections.push(`Its last message:\n${about.lastMessage}`);
  return { agentId, prompt: sections.join("\n\n"), aboutAgentId, aboutTitle, event };
}

export function createMcpFinishNotifier(options: McpFinishNotifierOptions): McpFinishNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxWatchMs = options.maxWatchMs ?? 24 * 60 * 60_000;
  const waitChunkMs = options.waitChunkMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 15_000;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const messageRetryDelaysMs = options.messageRetryDelaysMs ?? MESSAGE_RETRY_DELAYS_MS;
  const resumeGraceMs = options.resumeGraceMs ?? 10 * 60_000;
  const logger = options.logger.child({ module: "mcp-finish-notifier" });
  const active = new Map<string, ActiveWatch>();
  const activeGroups = new Map<string, AbortController>();
  const activeStatusWatches = new Map<string, () => void>();
  let suspended = false;
  const journal = options.journalPath
    ? createWatchJournal<JournalEntry>({ path: options.journalPath, logger })
    : null;
  const deliveryLog = options.deliveryLogPath
    ? createWebhookDeliveryLog({ path: options.deliveryLogPath, logger })
    : null;

  // Logs the transition and appends it to the journal, in call order.
  const record = (entry: JournalEntry) => {
    const { body: _body, ...fields } = entry as JournalEntry & { body?: string };
    const level = entry.event === "failed" || entry.event === "gave_up" ? "warn" : "info";
    logger[level](fields, `mcp finish watch ${entry.event}`);
    journal?.append(entry);
  };

  const resolveHeaders = async (target: McpWebhookTarget, body: string) => {
    const resolved: Record<string, string> = { "content-type": "application/json" };
    const resolveRefs = async (value: string) => {
      const ref = VAULT_REF.exec(value)?.[0];
      return ref ? value.replace(ref, (await options.resolveSecret(ref)) ?? "") : value;
    };
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      resolved[name] = await resolveRefs(value);
    }
    if (target.signingSecret) {
      const secret = await resolveRefs(target.signingSecret);
      // Never sign with an empty key: an unsigned POST fails the receiver's check visibly.
      if (secret) {
        const digest = createHmac("sha256", secret).update(body).digest("hex");
        resolved["x-paseo-signature-256"] = `sha256=${digest}`;
      } else {
        logger.warn({ url: target.url }, "notify target signing secret did not resolve");
      }
    }
    return resolved;
  };

  const agentPayload = (agentId: string, result: FleetAgentWaitResult, turnId: string | null) => ({
    id: agentId,
    host: result.host,
    turnId: result.turnId ?? turnId,
    title: result.title,
    status: result.status,
    bucket: result.bucket,
    finishedAt: new Date().toISOString(),
    lastMessage: result.lastMessage?.trim() || null,
    error: result.error,
  });

  // `final` is false for events that leave the watch armed: needs_permission,
  // and interrupted while the watch waits for the run a peer resumes.
  const buildBody = (
    watch: ActiveWatch,
    reason: NotifyReason,
    final: boolean,
    result: FleetAgentWaitResult,
    deliveryId: string,
  ): string => {
    const { armed, messages } = watch;
    let type = "paseo.agent.finished";
    if (reason === "needs_permission") type = "paseo.agent.needs_permission";
    else if (!final) type = "paseo.agent.interrupted";
    const agent = agentPayload(armed.agentId, result, armed.turnId);
    return JSON.stringify({
      type,
      deliveryId,
      reason,
      final,
      client: armed.client,
      notifyTarget: targetName(armed),
      context: armed.context,
      agent,
      // A target that streams messages may already have the final text.
      ...(messages && final
        ? {
            messagesSent: messages.sentCount,
            lastMessageSent: agent.lastMessage !== null && messages.lastSent === agent.lastMessage,
          }
        : {}),
      trigger: { tool: armed.tool, requestedAt: armed.ts },
    });
  };

  const retryDelaysFor = (target: McpNotifyTarget): readonly number[] =>
    (target.kind !== "agent" ? target.retryDelaysMs : undefined) ?? retryDelaysMs;

  const deliverToAgentTarget = async (target: McpAgentTarget, body: string) => {
    if (!options.deliverToAgent) throw new Error("this host cannot deliver to agent targets");
    await options.deliverToAgent(agentDeliveryFor(target.agentId, JSON.parse(body)));
  };

  // One delivery attempt, recorded as a delivery-log row: a POST to a webhook,
  // or a prompt to an agent target. A failed attempt is retried (retryInMs)
  // when it may succeed later and the delays have one left.
  const attemptDelivery = async (delivery: Delivery, attempt: number): Promise<AttemptResult> => {
    const started = Date.now();
    let status: number | null = null;
    let ok = false;
    let response: string | null = null;
    let retryable: boolean;
    if (delivery.target.kind === "agent") {
      try {
        await deliverToAgentTarget(delivery.target, delivery.body);
        ok = true;
      } catch (caught) {
        response = caught instanceof Error ? caught.message : String(caught);
      }
      retryable = !ok;
    } else {
      try {
        const reply = await fetchImpl(delivery.target.url, {
          method: "POST",
          headers: { ...delivery.headers, "x-paseo-delivery-id": delivery.deliveryId },
          body: delivery.body,
          signal: AbortSignal.timeout(15_000),
        });
        status = reply.status;
        ok = reply.ok;
        response = (await reply.text().catch(() => "")).slice(0, RESPONSE_SNIPPET_LIMIT) || null;
      } catch (caught) {
        response = caught instanceof Error ? caught.message : String(caught);
      }
      retryable = !ok && isRetryableWebhookFailure(status, response);
    }
    const retryInMs = retryable ? (delivery.delays[attempt] ?? null) : null;
    let outcome: WebhookDeliveryAttempt["outcome"] = "failed";
    if (ok) outcome = "delivered";
    else if (retryInMs !== null) outcome = "retrying";
    deliveryLog?.append({
      ts: new Date().toISOString(),
      client: delivery.client,
      deliveryId: delivery.deliveryId,
      watchId: delivery.watchId,
      ...describeWebhookBody(delivery.body),
      attempt: attempt + 1,
      status,
      outcome,
      ...(retryInMs !== null
        ? { nextAttemptAt: new Date(Date.now() + retryInMs).toISOString() }
        : {}),
      ...(outcome === "failed"
        ? { failure: retryable ? ("exhausted" as const) : ("not_retryable" as const) }
        : {}),
      response,
      durationMs: Date.now() - started,
    });
    return { ok, status, error: ok ? null : response, retryInMs };
  };

  const prepareDelivery = async (input: {
    client: string;
    watchId: string;
    deliveryId: string;
    target: McpNotifyTarget;
    body: string;
    delays: readonly number[];
  }): Promise<Delivery> => ({
    ...input,
    headers: input.target.kind === "agent" ? {} : await resolveHeaders(input.target, input.body),
  });

  // Delivers one event under its deliveryId, retrying with backoff. A suspend
  // during a retry pause leaves the event fired-but-unsent, so restore()
  // sends it again with the same deliveryId.
  const send = async (
    watch: ActiveWatch,
    reason: NotifyReason,
    final: boolean,
    body: string,
    deliveryId: string,
  ) => {
    const { armed, binding, controller } = watch;
    const delivery = await prepareDelivery({
      client: armed.client,
      watchId: armed.watchId,
      deliveryId,
      target: binding.target,
      body,
      delays: retryDelaysFor(binding.target),
    });
    const ids = { watchId: armed.watchId, agentId: armed.agentId, reason, final };
    for (let attempt = 0; ; attempt += 1) {
      const { ok, status, error, retryInMs } = await attemptDelivery(delivery, attempt);
      if (ok) {
        record({
          event: "delivered",
          ts: new Date().toISOString(),
          ...ids,
          status: status ?? 0,
          attempts: attempt + 1,
        });
        return;
      }
      logger.warn(
        { ...ids, client: armed.client, status, err: error, attempt: attempt + 1 },
        "mcp finish notification attempt failed",
      );
      if (retryInMs === null) {
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
      await sleep(retryInMs, undefined, { signal: controller.signal }).catch(() => {
        throw new WatchSuspendedError();
      });
    }
  };

  // Delivers one event that belongs to no watch (a status report, a reminder),
  // retrying with backoff. Every attempt lands in the delivery log.
  const deliverEvent: McpFinishNotifier["deliver"] = async (input) => {
    const delivery = await prepareDelivery({
      ...input,
      delays: retryDelaysFor(input.target),
    });
    const ids = { client: input.client, watchId: input.watchId, deliveryId: input.deliveryId };
    for (let attempt = 0; ; attempt += 1) {
      const { ok, status, error, retryInMs } = await attemptDelivery(delivery, attempt);
      if (ok) {
        logger.info({ ...ids, status, attempts: attempt + 1 }, "mcp event delivered");
        return { delivered: true, status, attempts: attempt + 1, error: null };
      }
      logger.warn({ ...ids, status, err: error, attempt: attempt + 1 }, "mcp event attempt failed");
      if (retryInMs === null) {
        logger.error({ ...ids, status, attempts: attempt + 1, error }, "mcp event delivery failed");
        return { delivered: false, status, attempts: attempt + 1, error };
      }
      await sleep(retryInMs).catch(() => undefined);
    }
  };

  const fire = async (
    watch: ActiveWatch,
    reason: NotifyReason,
    final: boolean,
    result: FleetAgentWaitResult,
  ) => {
    const deliveryId = randomUUID();
    const body = buildBody(watch, reason, final, result, deliveryId);
    if (!targetTakes(watch.binding.target, eventKind(reason, final))) {
      // A non-final event the target skips leaves the watch armed; nothing to record.
      if (!final) return;
      deliveryLog?.append({
        ts: new Date().toISOString(),
        client: watch.armed.client,
        deliveryId,
        watchId: watch.armed.watchId,
        ...describeWebhookBody(body),
        attempt: 0,
        status: null,
        outcome: "suppressed",
        suppressedReason: "filtered",
        response: null,
        durationMs: 0,
      });
      record({
        event: "suppressed",
        ts: new Date().toISOString(),
        watchId: watch.armed.watchId,
        agentId: watch.armed.agentId,
        reason: "filtered",
      });
      return;
    }
    record({
      event: "fired",
      ts: new Date().toISOString(),
      watchId: watch.armed.watchId,
      agentId: watch.armed.agentId,
      reason,
      final,
      status: result.status,
      body,
      deliveryId,
    });
    await send(watch, reason, final, body, deliveryId);
  };

  // Streams the agent's intermediate messages to a webhook that asked for
  // them (intermediateMessages), in order, batched by messageBatchMs. Only an
  // agent this daemon hosts can be streamed. Not journaled.
  const startMessages = (watch: ActiveWatch): MessageStream | null => {
    const { target } = watch.binding;
    const subscribe = options.localAgents?.subscribeAssistantMessages;
    if (target.kind === "agent" || !target.intermediateMessages || !subscribe) return null;
    const batchMs = target.messageBatchMs ?? DEFAULT_MESSAGE_BATCH_MS;
    const { armed } = watch;
    let pending: McpAssistantMessage[] = [];
    let timer: NodeJS.Timeout | undefined;
    let queue = Promise.resolve();
    const stream: MessageStream = { sentCount: 0, lastSent: null, stop: async () => {} };
    const post = async (batch: McpAssistantMessage[]) => {
      const deliveryId = randomUUID();
      const body = JSON.stringify({
        type: "paseo.agent.message",
        deliveryId,
        client: armed.client,
        notifyTarget: targetName(armed),
        context: armed.context,
        agent: { id: armed.agentId, turnId: batch.at(-1)?.turnId ?? watch.turnId },
        messages: batch.map(({ seq, text, at }) => ({ seq, text, at })),
      });
      const delivery = await prepareDelivery({
        client: armed.client,
        watchId: armed.watchId,
        deliveryId,
        target,
        body,
        delays: messageRetryDelaysMs,
      });
      for (let attempt = 0; ; attempt += 1) {
        const { ok, error, retryInMs } = await attemptDelivery(delivery, attempt);
        if (ok) {
          stream.sentCount += batch.length;
          stream.lastSent = batch.at(-1)?.text.trim() ?? stream.lastSent;
          return;
        }
        if (retryInMs === null) {
          logger.warn(
            { watchId: armed.watchId, agentId: armed.agentId, messages: batch.length, err: error },
            "mcp intermediate messages dropped",
          );
          return;
        }
        await sleep(retryInMs);
      }
    };
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      queue = queue.then(() => post(batch)).catch(() => undefined);
    };
    const unsubscribe = subscribe(armed.agentId, (message) => {
      // Messages of another turn (the one a queued prompt waits behind) are not this watch's.
      if (message.turnId && armed.nextTurnAfter && message.turnId === armed.nextTurnAfter) return;
      if (message.turnId && watch.turnId && message.turnId !== watch.turnId) return;
      pending.push(message);
      if (batchMs === 0) flush();
      else timer ??= setTimeout(flush, batchMs);
    });
    stream.stop = async () => {
      unsubscribe();
      flush();
      await queue;
    };
    return stream;
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
  ): Promise<RunEnd | null> => {
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

  /**
   * The call's prompt waits for the running turn to end (nextTurnAfter): bind
   * to the first turn that starts after it. Only an agent this daemon hosts
   * can be followed that way; a peer's watch keeps the run in progress.
   */
  const bindNextTurn = async (watch: ActiveWatch) => {
    const after = watch.armed.nextTurnAfter;
    const localAgents = options.localAgents;
    if (!after || !localAgents || (watch.turnId && watch.turnId !== after)) return;
    const deadline = AbortSignal.timeout(Math.max(0, watch.armed.deadline - Date.now()));
    const run = await localAgents
      .waitForRunStart(
        watch.armed.agentId,
        AbortSignal.any([watch.controller.signal, deadline]),
        after,
      )
      .catch((error: unknown) => {
        if (watch.controller.signal.aborted) throw new WatchSuspendedError();
        throw error;
      });
    if (!run.local || !run.turnId) return;
    watch.turnId = run.turnId;
    record({
      event: "resumed",
      ts: new Date().toISOString(),
      watchId: watch.armed.watchId,
      agentId: watch.armed.agentId,
      turnId: run.turnId,
    });
  };

  const watchUntilFinished = async (watch: ActiveWatch) => {
    await bindNextTurn(watch);
    watch.messages = startMessages(watch);
    let end: RunEnd | null;
    try {
      end = await waitForRunEnd(
        watch,
        (blocked) => fire(watch, "needs_permission", false, blocked),
        (closed) => fire(watch, "interrupted", false, closed),
      );
    } finally {
      // Every message the turn wrote goes out before its finish event.
      await watch.messages?.stop();
    }
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
      targetRef: armed.targetRef,
      turnId: member?.turnId ?? null,
      deadline: armed.deadline,
    },
    binding,
    controller,
    turnId: run?.turnId ?? member?.turnId ?? null,
    interrupted: run?.interrupted ?? false,
    interruptedResult: null,
    messages: null,
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
    const deliveryId = randomUUID();
    const body = JSON.stringify({
      type: "paseo.agents.group_finished",
      deliveryId,
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
      deliveryId,
    });
    await send(groupWatch(armed, binding, controller), "finished", true, body, deliveryId);
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
      messages: null,
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
    const turnId = input.nextTurnAfter
      ? null
      : (input.turnId ?? options.localAgents?.activeTurnId(input.agentId) ?? null);
    // A steer joins the run in progress, so a send can bind to the turn a
    // watch already follows; a second watch would deliver the same event twice.
    if (turnId) {
      for (const watch of active.values()) {
        if (
          watch.armed.agentId === input.agentId &&
          watch.armed.context === input.context &&
          sameTargetRef(watch.armed.targetRef, input.targetRef) &&
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
      targetRef: input.targetRef,
      ...(input.nextTurnAfter ? { nextTurnAfter: input.nextTurnAfter } : {}),
      turnId,
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
      const now = new Date();
      const armed: GroupArmedEntry = {
        event: "group_armed",
        ts: now.toISOString(),
        watchId: input.groupId,
        agentId: input.groupId,
        client: input.client,
        tool: input.tool,
        context: input.context,
        targetRef: input.targetRef,
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

        const deliveryId = randomUUID();
        const payload: Record<string, unknown> = {
          type: "paseo.agent.status_reported",
          deliveryId,
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

        await deliverEvent({
          client: input.client,
          target: input.target,
          watchId: input.requestId,
          body,
          deliveryId,
        });
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

    deliver: deliverEvent,

    async listDeliveries(query) {
      if (!deliveryLog) {
        return {
          totals: { events: 0, delivered: 0, failed: 0, suppressed: 0, attempts: 0, byStatus: {} },
          deliveries: [],
        };
      }
      return deliveryLog.list(query);
    },

    async restore(resolveTarget) {
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
        const binding = await resolveTarget(armed.client, armed.targetRef).catch(() => null);
        if (!binding) {
          record({
            event: "gave_up",
            ...ids,
            why: `notify target "${describeTargetRef(armed.targetRef)}" is not configured`,
          });
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
                // Entries from before deliveryIds had none in their body either.
                const deliveryId = unsent.deliveryId ?? randomUUID();
                await send(watch, unsent.reason, true, unsent.body, deliveryId);
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
                group.unsent.body,
                group.unsent.deliveryId ?? randomUUID(),
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
      await Promise.all([journal?.flush(), deliveryLog?.flush()]);
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
    waitForRunStart: (agentId, signal, notTurnId) => {
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
          if (notTurnId && turnId === notTurnId) return;
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
    subscribeAssistantMessages: (agentId, onMessage) => {
      // Assistant text streams in as many small rows; a block ends when the
      // next timeline item is something else. The block a turn ends on is not
      // emitted: it is the finish event's lastMessage.
      let block: McpAssistantMessage | null = null;
      return agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_stream") return;
          const stream = event.event;
          if (stream.type !== "timeline") {
            if (stream.type.startsWith("turn_")) block = null;
            return;
          }
          if (stream.item.type === "assistant_message") {
            block ??= {
              turnId: stream.turnId ?? null,
              seq: event.seq ?? 0,
              text: "",
              at: event.timestamp ?? new Date().toISOString(),
            };
            block.text += stream.item.text;
            return;
          }
          const done = block;
          block = null;
          if (done?.text.trim()) onMessage({ ...done, text: done.text.trim() });
        },
        { agentId },
      );
    },
  };
}
