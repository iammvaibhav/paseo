import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ensureValidJson } from "../../json-utils.js";
import type { AgentManager, WaitForAgentResult } from "../agent-manager.js";
import { SYSTEM_ERROR_PREFIX } from "../agent-sdk-types.js";
import {
  resolvePeerDaemonClient,
  resolveTargetHost,
  type RegisterFleetControlToolsOptions,
} from "./fleet-control-tools.js";
import { seedStoredTimeline } from "./fleet-transcript.js";
import type { PaseoToolExecutionContext } from "./types.js";

const FLEET_WAIT_DEFAULT_SECONDS = 600;
const FLEET_WAIT_MAX_SECONDS = 1800;
/** One peer wait call; the peer RPC times out at 60 s, so longer waits are chunked. */
const PEER_WAIT_CHUNK_SECONDS = 45;
const RUN_START_WAIT_MS = 15_000;
const PEER_TURN_POLL_MS = 250;

export interface FleetAgentWaitResult {
  ok: boolean;
  host: string;
  agentId: string;
  /**
   * Lifecycle after the wait ("idle", "error", "running", "closed", …);
   * "permission" when blocked on one; "pending" when the requested turn has
   * not started on the agent.
   */
  status: string;
  /** The bound turn ended (idle, error or closed). */
  finished: boolean;
  /** The agent is waiting on a permission decision. */
  needsPermission: boolean;
  timedOut: boolean;
  /** The turn this result is about; null when the agent had no run to bind to. */
  turnId: string | null;
  title: string | null;
  bucket: string | null;
  lastMessage: string | null;
  error: string | null;
  guidance?: string;
}

function waitResult(
  base: Pick<FleetAgentWaitResult, "host" | "agentId">,
  fields: Partial<FleetAgentWaitResult>,
): FleetAgentWaitResult {
  const status = fields.status ?? "unknown";
  return {
    ok: true,
    status,
    finished:
      status === "idle" || status === "error" || status === "closed" || status === "interrupted",
    needsPermission: status === "permission",
    timedOut: false,
    turnId: null,
    title: null,
    bucket: null,
    lastMessage: null,
    error: null,
    ...base,
    ...fields,
  };
}

export const FLEET_WAIT_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  host: z.string(),
  agentId: z.string(),
  status: z.string(),
  finished: z.boolean(),
  needsPermission: z.boolean(),
  timedOut: z.boolean(),
  turnId: z.string().nullable(),
  title: z.string().nullable(),
  bucket: z.string().nullable(),
  lastMessage: z.string().nullable(),
  error: z.string().nullable(),
  guidance: z.string().optional(),
});

function currentTurnId(agentManager: AgentManager, agentId: string): string | null {
  const live = agentManager.getAgent(agentId);
  return live?.activeTurnId ?? live?.activeForegroundTurnId ?? null;
}

function lastTimelineTurnId(agentManager: AgentManager, agentId: string): string | null {
  if (!agentManager.hasTimeline(agentId)) return null;
  const rows = agentManager.fetchTimeline(agentId, { direction: "tail", limit: 1 }).rows;
  return rows.at(-1)?.turnId ?? null;
}

/**
 * How a past turn ended, read from the agent's timeline; null when no row carries turnId.
 * A failed turn ends with the manager's "[System Error] …" assistant row (or an error item).
 * A turn the agent canceled (Stop, or a prompt that interrupted it) is "interrupted".
 */
function findTurnOutcome(
  agentManager: AgentManager,
  agentId: string,
  turnId: string,
): {
  status: "idle" | "error" | "interrupted";
  lastMessage: string | null;
  error: string | null;
} | null {
  const rows = agentManager
    .fetchTimeline(agentId, { direction: "tail", limit: 0 })
    .rows.filter((row) => row.turnId === turnId);
  if (rows.length === 0) return null;
  const lastAssistant = rows.findLast((row) => row.item.type === "assistant_message");
  const lastMessage =
    lastAssistant?.item.type === "assistant_message" ? lastAssistant.item.text : null;
  const errorItem = rows.findLast((row) => row.item.type === "error");
  let error: string | null = null;
  if (errorItem?.item.type === "error") {
    error = errorItem.item.message;
  } else if (lastMessage?.startsWith(SYSTEM_ERROR_PREFIX)) {
    error = lastMessage.slice(SYSTEM_ERROR_PREFIX.length).trim();
  }
  if (error !== null) return { status: "error", lastMessage, error };
  const end = agentManager.getAgent(agentId)?.finalizedForegroundTurnIds.get(turnId);
  return { status: end === "turn_canceled" ? "interrupted" : "idle", lastMessage, error };
}

interface WaitScope {
  base: Pick<FleetAgentWaitResult, "host" | "agentId">;
  deadline: number;
  timeout: AbortSignal;
  /** Group stop (fleet_wait_agents "any"): return the current state, not an error. */
  stop: AbortSignal | undefined;
  signal: AbortSignal;
  /** The turn the wait is bound to, published as soon as it is known. */
  bound: { turnId: string | null };
}

async function readBucket(
  deps: RegisterFleetControlToolsOptions,
  agentId: string,
): Promise<string | null> {
  return deps.missionControlService
    ? (await deps.missionControlService.getAgentStatusRecord(agentId)).bucket
    : null;
}

/** A turn that is not running: its outcome from the timeline, or "pending" when it never ran. */
function turnOutcomeResult(
  agentManager: AgentManager,
  scope: WaitScope,
  turnId: string,
  title: string | null,
): FleetAgentWaitResult {
  const outcome = findTurnOutcome(agentManager, scope.base.agentId, turnId);
  if (outcome) return waitResult(scope.base, { ...outcome, turnId, title });
  return waitResult(scope.base, {
    status: "pending",
    finished: false,
    turnId,
    title,
    guidance: `Turn ${turnId} has not started on this agent; call again to keep waiting.`,
  });
}

/** An agent with no live runtime: a bound turn reads from stored history, else its last state. */
async function waitForStoredAgent(
  deps: RegisterFleetControlToolsOptions,
  scope: WaitScope,
): Promise<FleetAgentWaitResult> {
  const { agentId } = scope.base;
  const stored = await deps.agentStorage.get(agentId);
  if (!stored) {
    return waitResult(scope.base, { ok: false, error: `Agent "${agentId}" not found` });
  }
  const title = stored.title ?? null;
  const bucket = await readBucket(deps, agentId);
  if (scope.bound.turnId) {
    await seedStoredTimeline({
      agentId,
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      logger: deps.logger,
    });
    return {
      ...turnOutcomeResult(deps.agentManager, scope, scope.bound.turnId, title),
      bucket,
    };
  }
  return waitResult(scope.base, {
    status: stored.lastStatus ?? "idle",
    title,
    bucket,
    error: stored.lastStatus === "error" ? (stored.lastError ?? null) : null,
    guidance: "No run in progress; this is the agent's last state.",
  });
}

async function waitForLocalAgent(
  deps: RegisterFleetControlToolsOptions,
  scope: WaitScope,
): Promise<FleetAgentWaitResult> {
  const { agentManager } = deps;
  const { agentId } = scope.base;
  if (!agentManager.getAgent(agentId)) return waitForStoredAgent(deps, scope);
  const title = (await deps.agentStorage.get(agentId))?.title ?? null;
  const requestedTurn = scope.bound.turnId;
  if (requestedTurn && currentTurnId(agentManager, agentId) !== requestedTurn) {
    return {
      ...turnOutcomeResult(agentManager, scope, requestedTurn, title),
      bucket: await readBucket(deps, agentId),
    };
  }
  scope.bound.turnId = requestedTurn ?? currentTurnId(agentManager, agentId);
  return waitForLiveRun(deps, scope, title);
}

/** The result of a live run's wait, once waitForAgentEvent returned. */
async function liveRunResult(
  deps: RegisterFleetControlToolsOptions,
  scope: WaitScope,
  title: string | null,
  result: WaitForAgentResult,
): Promise<FleetAgentWaitResult> {
  const { agentManager } = deps;
  const { agentId } = scope.base;
  const boundTurnId = scope.bound.turnId;
  // Another run replaced the bound turn (a user's prompt with interrupt):
  // report the bound turn's own outcome, not the run that superseded it. The
  // agent stays "running" across the swap, and between the bound turn's
  // cancel and the replacement's start no turn is active at all.
  const activeTurnId = currentTurnId(agentManager, agentId);
  const replaced =
    boundTurnId !== null &&
    !result.permission &&
    activeTurnId !== boundTurnId &&
    (activeTurnId !== null || result.status === "running");
  if (boundTurnId && replaced) {
    return {
      ...turnOutcomeResult(agentManager, scope, boundTurnId, title),
      bucket: await readBucket(deps, agentId),
    };
  }
  const errorText =
    result.status === "error" ? agentManager.getAgent(agentId)?.lastError : undefined;
  // A run that started after the wait was armed (pending at call time)
  // has no captured id; it is the newest turn on the timeline.
  const turnId = boundTurnId ?? activeTurnId ?? lastTimelineTurnId(agentManager, agentId);
  let status: string = result.status;
  if (result.permission) {
    status = "permission";
  } else if (
    turnId &&
    result.status === "idle" &&
    agentManager.getAgent(agentId)?.finalizedForegroundTurnIds.get(turnId) === "turn_canceled"
  ) {
    // Stopped: the agent is idle, but its turn was canceled, not finished.
    status = "interrupted";
  }
  return waitResult(scope.base, {
    status,
    turnId,
    title,
    bucket: await readBucket(deps, agentId),
    lastMessage: result.lastMessage,
    error: errorText ?? null,
    ...(turnId === null && status === "idle"
      ? { guidance: "No run in progress; this is the agent's last state." }
      : {}),
  });
}

/** Wait for the bound (or in-progress) run of a live agent to end. */
async function waitForLiveRun(
  deps: RegisterFleetControlToolsOptions,
  scope: WaitScope,
  title: string | null,
): Promise<FleetAgentWaitResult> {
  const { agentManager } = deps;
  const { agentId } = scope.base;
  try {
    const boundTurnId = scope.bound.turnId;
    const result = await agentManager.waitForAgentEvent(agentId, {
      signal: scope.signal,
      waitForActive: true,
      ...(boundTurnId ? { turnId: boundTurnId } : {}),
    });
    return await liveRunResult(deps, scope, title, result);
  } catch (error) {
    if (!scope.timeout.aborted && !scope.stop?.aborted) throw error;
    return waitResult(scope.base, {
      status: agentManager.getAgent(agentId)?.lifecycle ?? "running",
      finished: false,
      timedOut: scope.timeout.aborted,
      turnId: scope.bound.turnId ?? currentTurnId(agentManager, agentId),
      title,
      bucket: await readBucket(deps, agentId),
    });
  }
}

/** Execute a fleet tool on a peer daemon's own catalog (host "local" there). */
export async function executeFleetToolOnPeer(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<{ ok: true; structuredContent: unknown } | { ok: false; error: string }> {
  const response = await client.missionControlToolsExecute({
    name,
    args: { ...args, host: "local" },
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return response.ok
    ? { ok: true, structuredContent: response.structuredContent }
    : { ok: false, error: response.error ?? `${name} failed on the peer` };
}

async function waitForLegacyPeerAgent(
  client: DaemonClient,
  scope: WaitScope,
): Promise<FleetAgentWaitResult> {
  const result = await client.waitForFinish(scope.base.agentId, scope.deadline - Date.now());
  const timedOut = result.status === "timeout";
  return waitResult(scope.base, {
    status: timedOut ? (result.final?.status ?? "running") : result.status,
    ...(timedOut ? { finished: false, timedOut } : {}),
    title: result.final?.title ?? null,
    bucket: result.final?.bucket ?? null,
    lastMessage: timedOut ? null : result.lastMessage,
    error: result.error,
    guidance: "This host predates turn-bound waits; the result is not bound to a turn.",
  });
}

async function waitForPeerAgent(
  client: DaemonClient,
  scope: WaitScope,
): Promise<FleetAgentWaitResult> {
  // The peer RPC has no cancel; an abort only stops waiting here.
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  scope.signal.addEventListener("abort", () => reject(scope.signal.reason), { once: true });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const remainingSeconds = Math.ceil((scope.deadline - Date.now()) / 1000);
      const chunkSeconds = Math.max(1, Math.min(PEER_WAIT_CHUNK_SECONDS, remainingSeconds));
      const response = await Promise.race([
        executeFleetToolOnPeer(client, "fleet_wait_agent", {
          agentId: scope.base.agentId,
          timeoutSeconds: chunkSeconds,
          ...(scope.bound.turnId ? { turnId: scope.bound.turnId } : {}),
        }),
        aborted,
      ]);
      if (!response.ok) {
        // Peers deployed before turn-bound waits refuse fleet_wait_agent over tools.execute.
        if (
          response.error.includes("not on the Commander allowlist") ||
          response.error.includes("Unknown Paseo tool")
        ) {
          return await Promise.race([waitForLegacyPeerAgent(client, scope), aborted]);
        }
        return waitResult(scope.base, { ok: false, error: response.error });
      }
      const parsed = FLEET_WAIT_RESULT_SCHEMA.safeParse(response.structuredContent);
      if (!parsed.success) {
        return waitResult(scope.base, { ok: false, error: "Peer returned an invalid wait result" });
      }
      // Later chunks stay bound to the turn the first chunk captured.
      scope.bound.turnId = parsed.data.turnId ?? scope.bound.turnId;
      if (parsed.data.timedOut && Date.now() < scope.deadline - 1000) continue;
      return { ...parsed.data, host: scope.base.host, turnId: scope.bound.turnId };
    }
  } catch (error) {
    if (!scope.timeout.aborted && !scope.stop?.aborted) throw error;
    return waitResult(scope.base, {
      status: "running",
      finished: false,
      timedOut: scope.timeout.aborted,
      turnId: scope.bound.turnId,
    });
  }
}

/**
 * Block until an agent's turn ends anywhere in the fleet. With turnId the
 * wait is bound to that turn: an already-finished turn returns its outcome at
 * once, a turn that has not started returns status "pending", and an earlier
 * run's finish is never returned. Without turnId it binds to the run in
 * progress (or returns the idle agent's last state at once). Returns early
 * when the agent needs a permission decision, and with timedOut when the
 * deadline passes first.
 */
export async function waitForFleetAgent(
  deps: RegisterFleetControlToolsOptions,
  input: {
    agentId: string;
    host?: string;
    turnId?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    stop?: AbortSignal;
    bound?: { turnId: string | null };
  },
): Promise<FleetAgentWaitResult> {
  const resolved = await resolveTargetHost(input.agentId, input.host, deps);
  const base = { host: resolved.targetHostDisplay, agentId: resolved.agentId };
  if (resolved.error) {
    return waitResult(base, { ok: false, error: resolved.error, guidance: resolved.guidance });
  }
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const bound = input.bound ?? { turnId: null };
  bound.turnId = input.turnId ?? bound.turnId;
  const scope: WaitScope = {
    base,
    deadline: Date.now() + input.timeoutMs,
    timeout,
    stop: input.stop,
    signal: AbortSignal.any(
      [timeout, input.stop, input.signal].filter((s): s is AbortSignal => s !== undefined),
    ),
    bound,
  };
  if (resolved.isLocal) return waitForLocalAgent(deps, scope);
  const peer = resolvePeerDaemonClient(resolved.host, deps);
  if (!peer.client) {
    return waitResult(base, { ok: false, error: peer.error ?? null, guidance: peer.guidance });
  }
  return waitForPeerAgent(peer.client, scope);
}

/** The part of a peer's fleet_agent_status result readCurrentTurn needs. */
const PEER_STATUS_RUNNING_SCHEMA = z.object({
  running: z.object({ activeTurnId: z.string().nullable() }).nullable(),
});

/**
 * The turn an agent is on right now, and its newest turn on the timeline.
 * Null when a peer can answer neither question.
 */
export async function readCurrentTurn(input: {
  agentManager?: AgentManager;
  client?: DaemonClient;
  agentId: string;
}): Promise<{ active: string | null; last: string | null } | null> {
  if (input.client) {
    const [status, timeline] = await Promise.all([
      executeFleetToolOnPeer(input.client, "fleet_agent_status", {
        agentId: input.agentId,
      }).catch(() => null),
      input.client
        .fetchAgentTimeline(input.agentId, { direction: "tail", limit: 1 })
        .catch(() => null),
    ]);
    if (!status?.ok && !timeline) return null;
    const parsed = status?.ok
      ? PEER_STATUS_RUNNING_SCHEMA.safeParse(status.structuredContent)
      : null;
    return {
      active: parsed?.success ? (parsed.data.running?.activeTurnId ?? null) : null,
      last: timeline?.entries.at(-1)?.turnId ?? null,
    };
  }
  if (!input.agentManager) return null;
  return {
    active: currentTurnId(input.agentManager, input.agentId),
    last: lastTimelineTurnId(input.agentManager, input.agentId),
  };
}

/**
 * The turn a just-delivered prompt runs in, so wait/notify can bind to it.
 * A live steer joins the current turn; any other delivery starts a new turn:
 * the first turn id (active, or newest on the timeline for a run that already
 * finished) that differs from the one before the prompt. Bounded.
 */
export async function resolvePromptedTurn(input: {
  agentManager?: AgentManager;
  client?: DaemonClient;
  agentId: string;
  previousTurnId: string | null;
  joinsCurrentTurn: boolean;
}): Promise<{ started: boolean; turnId: string | null }> {
  if (input.joinsCurrentTurn && input.client) {
    return { started: false, turnId: (await readCurrentTurn(input))?.active ?? null };
  }
  if (input.joinsCurrentTurn) {
    const active = input.agentManager ? currentTurnId(input.agentManager, input.agentId) : null;
    return { started: false, turnId: active };
  }
  const newTurn = (turn: { active: string | null; last: string | null } | null) =>
    [turn?.active ?? null, turn?.last ?? null].find(
      (turnId) => turnId !== null && turnId !== input.previousTurnId,
    ) ?? null;
  if (!input.client) {
    if (!input.agentManager) return { started: false, turnId: null };
    // Settles once the prompted run starts, or at once when it already ended.
    await input.agentManager
      .waitForAgentRunStart(input.agentId, { signal: AbortSignal.timeout(RUN_START_WAIT_MS) })
      .catch(() => undefined);
    const turnId = newTurn(await readCurrentTurn(input));
    return { started: turnId !== null, turnId };
  }
  const deadline = Date.now() + RUN_START_WAIT_MS;
  for (;;) {
    const turn = await readCurrentTurn(input);
    // A peer that cannot report turns never will; do not hold the caller.
    if (!turn) return { started: false, turnId: null };
    const turnId = newTurn(turn);
    if (turnId) return { started: true, turnId };
    if (Date.now() >= deadline) return { started: false, turnId: null };
    await sleep(PEER_TURN_POLL_MS);
  }
}

const WAIT_AGENT_ID_SCHEMA = z
  .string()
  .min(1)
  .describe("Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed.");
const WAIT_HOST_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe("Optional host hint (peer name or 'local'). Omitted → resolved via the fleet index.");
const WAIT_TURN_ID_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Bind the wait to this turn (the turnId fleet_send_prompt/fleet_create_agent returned). " +
      "Omitted → the run in progress at call time.",
  );
const WAIT_TIMEOUT_SCHEMA = z
  .number()
  .int()
  .positive()
  .max(FLEET_WAIT_MAX_SECONDS)
  .optional()
  .describe(
    `Seconds to wait before returning timedOut=true (default ${FLEET_WAIT_DEFAULT_SECONDS}, max ${FLEET_WAIT_MAX_SECONDS}).`,
  );

export function registerFleetWaitTools(options: RegisterFleetControlToolsOptions): void {
  options.registerTool(
    "fleet_wait_agent",
    {
      title: "Wait for an agent to finish",
      description:
        "Block until an agent's turn ends, anywhere in the fleet, then return its final state, turnId and " +
        "last message. Pass the turnId fleet_send_prompt/fleet_create_agent returned so an earlier run's " +
        "finish is never returned. Without turnId: binds to the run in progress, or returns an idle " +
        "agent's last state at once. Returns early if the agent needs a permission decision, and with " +
        `timedOut=true after timeoutSeconds (default ${FLEET_WAIT_DEFAULT_SECONDS}, max ${FLEET_WAIT_MAX_SECONDS}); ` +
        "call again with the returned turnId to keep waiting. For several agents use fleet_wait_agents.",
      inputSchema: {
        agentId: WAIT_AGENT_ID_SCHEMA,
        host: WAIT_HOST_SCHEMA,
        turnId: WAIT_TURN_ID_SCHEMA,
        timeoutSeconds: WAIT_TIMEOUT_SCHEMA,
      },
      outputSchema: FLEET_WAIT_RESULT_SCHEMA.shape,
    },
    async (
      input: { agentId: string; host?: string; turnId?: string; timeoutSeconds?: number },
      context: PaseoToolExecutionContext,
    ) => {
      const result = await waitForFleetAgent(options, {
        agentId: input.agentId,
        ...(input.host ? { host: input.host } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        timeoutMs: (input.timeoutSeconds ?? FLEET_WAIT_DEFAULT_SECONDS) * 1000,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return { content: [], structuredContent: ensureValidJson(result) };
    },
  );

  options.registerTool(
    "fleet_wait_agents",
    {
      title: "Wait for several agents",
      description:
        "Wait on several agents at once, anywhere in the fleet, each bound to its turn so an earlier " +
        'finish is never returned. mode "any" returns on the first agent that finishes or needs a ' +
        'permission; "all" returns when every agent has. Each result carries the agent\'s turnId and ' +
        "status; an idle agent with no run counts as finished at once with turnId null. On timeout " +
        "the partial results come back with timedOut=true.",
      inputSchema: {
        agents: z
          .array(
            z.object({
              agentId: WAIT_AGENT_ID_SCHEMA,
              host: WAIT_HOST_SCHEMA,
              turnId: WAIT_TURN_ID_SCHEMA,
            }),
          )
          .optional()
          .describe("Agents to wait on, each optionally bound to a turnId."),
        agentIds: z
          .array(WAIT_AGENT_ID_SCHEMA)
          .optional()
          .describe("Shorthand for agents without a host or turnId."),
        mode: z.enum(["any", "all"]).describe("any: first finish; all: every agent finished."),
        timeoutSeconds: WAIT_TIMEOUT_SCHEMA,
      },
      outputSchema: {
        mode: z.enum(["any", "all"]),
        done: z.boolean(),
        timedOut: z.boolean(),
        results: z.array(FLEET_WAIT_RESULT_SCHEMA),
      },
    },
    async (
      input: {
        agents?: Array<{ agentId: string; host?: string; turnId?: string }>;
        agentIds?: string[];
        mode: "any" | "all";
        timeoutSeconds?: number;
      },
      context: PaseoToolExecutionContext,
    ) => {
      const targets = [
        ...(input.agents ?? []),
        ...(input.agentIds ?? []).map((agentId) => ({ agentId })),
      ];
      if (targets.length === 0) {
        throw new Error("Pass at least one agent in agents or agentIds");
      }
      const settled = (result: FleetAgentWaitResult) =>
        !result.ok || result.finished || result.needsPermission;
      const stop = new AbortController();
      const timeoutMs = (input.timeoutSeconds ?? FLEET_WAIT_DEFAULT_SECONDS) * 1000;
      const waits = targets.map((target) =>
        waitForFleetAgent(options, {
          ...target,
          timeoutMs,
          stop: stop.signal,
          ...(context.signal ? { signal: context.signal } : {}),
        }),
      );
      if (input.mode === "any") {
        // The first settled agent stops the rest, which report their current state.
        const { promise: firstSettled, resolve } = Promise.withResolvers<void>();
        for (const wait of waits) {
          void wait.then((result) => (settled(result) ? resolve() : undefined));
        }
        await Promise.race([firstSettled, Promise.allSettled(waits)]);
        stop.abort();
      }
      const results = await Promise.all(waits);
      const done =
        input.mode === "any" ? results.some(settled) : results.every((result) => settled(result));
      return {
        content: [],
        structuredContent: ensureValidJson({
          mode: input.mode,
          done,
          timedOut: !done && results.some((result) => result.timedOut),
          results,
        }),
      };
    },
  );
}
