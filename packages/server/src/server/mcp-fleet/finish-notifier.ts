import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-wait.js";
import type { RemoteMcpClient } from "../persisted-config.js";
import type { ResolveSecret } from "../secrets/vault-secret.js";

/**
 * notifyOnFinish for remote MCP clients (/mcp/fleet). A client has no agent
 * thread to wake, so the daemon POSTs a JSON event to the webhook configured
 * for that client (daemon.mcp.remoteClients[].notify) when the run ends.
 * Watches are bound to a turn: an earlier run's finish never fires them.
 *
 * Watchers live in memory: a daemon restart drops pending notifications.
 */
export type McpNotifyTarget = NonNullable<RemoteMcpClient["notify"]>;

/** One bounded, turn-bound wait (fleet_wait_agent); the watcher calls it until the turn ends. */
export type McpNotifyWaitForAgent = (input: {
  agentId: string;
  host?: string;
  turnId?: string;
  timeoutMs: number;
}) => Promise<FleetAgentWaitResult>;

export interface McpNotifyAgent {
  agentId: string;
  /** Host hint for the agent; omitted → resolved through the fleet index. */
  host?: string;
  /** Bind to this turn; omitted → the run in progress when the watch starts. */
  turnId?: string | null;
}

export interface ArmMcpFinishNotification extends McpNotifyAgent {
  client: string;
  target: McpNotifyTarget;
  tool: string;
  context: string | null;
  waitForAgent: McpNotifyWaitForAgent;
}

export interface ArmMcpGroupNotification {
  client: string;
  target: McpNotifyTarget;
  groupId: string;
  agents: McpNotifyAgent[];
  /** Also POST paseo.agent.finished for each agent as it finishes. */
  perAgent: boolean;
  tool: string;
  context: string | null;
  waitForAgent: McpNotifyWaitForAgent;
}

export interface McpFinishNotifierOptions {
  resolveSecret: ResolveSecret;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Give up watching an agent after this long. */
  maxWatchMs?: number;
  /** One wait call's length; the watcher re-waits until maxWatchMs. */
  waitChunkMs?: number;
  /** Pause between checks while blocked on a permission, and after a failed wait. */
  pollMs?: number;
  /** Delays before delivery retries. */
  retryDelaysMs?: readonly number[];
}

export interface McpFinishNotifier {
  /**
   * Start watching in the background. Callers do not await it; the promise
   * settles (never rejects) once the event is delivered or the watch gives up.
   */
  arm(input: ArmMcpFinishNotification): Promise<void>;
  /**
   * Watch a set of agents and POST one paseo.agents.group_finished once every
   * agent's bound turn has ended (plus per-agent events when perAgent is set).
   * needs_permission still POSTs per agent and does not complete the group.
   */
  armGroup(input: ArmMcpGroupNotification): Promise<void>;
}

export const MAX_NOTIFY_CONTEXT_LENGTH = 2000;
const LAST_MESSAGE_LIMIT = 4000;
const VAULT_REF = /aside:\/\/\S+/;

function finishReason(status: string): "finished" | "errored" | "closed" {
  if (status === "error") return "errored";
  if (status === "closed") return "closed";
  return "finished";
}

function truncateLastMessage(lastMessage: string | null): string | null {
  const trimmed = lastMessage?.trim() || null;
  if (!trimmed || trimmed.length <= LAST_MESSAGE_LIMIT) return trimmed;
  return `${trimmed.slice(0, LAST_MESSAGE_LIMIT)}\n[truncated ${trimmed.length - LAST_MESSAGE_LIMIT} chars; use fleet_get_transcript for the full response]`;
}

export function createMcpFinishNotifier(options: McpFinishNotifierOptions): McpFinishNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxWatchMs = options.maxWatchMs ?? 24 * 60 * 60_000;
  const waitChunkMs = options.waitChunkMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 15_000;
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000];
  const logger = options.logger.child({ module: "mcp-finish-notifier" });

  const resolveHeaders = async (headers: Record<string, string> | undefined) => {
    const resolved: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of Object.entries(headers ?? {})) {
      const ref = VAULT_REF.exec(value)?.[0];
      resolved[name] = ref ? value.replace(ref, (await options.resolveSecret(ref)) ?? "") : value;
    }
    return resolved;
  };

  const post = async (
    input: { client: string; target: McpNotifyTarget },
    body: Record<string, unknown>,
    log: Record<string, unknown>,
  ) => {
    const payload = JSON.stringify(body);
    const headers = await resolveHeaders(input.target.headers);
    const fields = { client: input.client, type: body.type, ...log };
    for (let attempt = 0; ; attempt += 1) {
      let status: number | null = null;
      try {
        const response = await fetchImpl(input.target.url, {
          method: "POST",
          headers,
          body: payload,
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        if (response.ok) {
          logger.info({ ...fields, status }, "mcp finish notification delivered");
          return;
        }
      } catch (error) {
        logger.warn(
          { ...fields, err: error instanceof Error ? error.message : String(error) },
          "mcp finish notification attempt failed",
        );
      }
      const retryable = status === null || status === 429 || status >= 500;
      const delay = retryDelaysMs[attempt];
      if (!retryable || delay === undefined) {
        logger.error(
          { ...fields, status, attempts: attempt + 1 },
          "mcp finish notification dropped",
        );
        return;
      }
      await sleep(delay);
    }
  };

  const agentPayload = (agentId: string, result: FleetAgentWaitResult) => ({
    id: agentId,
    host: result.host,
    turnId: result.turnId,
    title: result.title,
    status: result.status,
    bucket: result.bucket,
    finishedAt: new Date().toISOString(),
    lastMessage: truncateLastMessage(result.lastMessage),
    error: result.error,
  });

  const deliverAgentEvent = (
    input: ArmMcpFinishNotification,
    reason: "finished" | "errored" | "closed" | "needs_permission",
    result: FleetAgentWaitResult,
    requestedAt: string,
  ) =>
    post(
      input,
      {
        type:
          reason === "needs_permission" ? "paseo.agent.needs_permission" : "paseo.agent.finished",
        reason,
        client: input.client,
        context: input.context,
        agent: agentPayload(input.agentId, result),
        trigger: { tool: input.tool, requestedAt },
      },
      { agentId: input.agentId, reason },
    );

  /**
   * Re-wait until the bound turn ends; POSTs needs_permission once per
   * blocked stretch. Returns the final result, or null when the watch gives up.
   */
  const watchUntilEnd = async (
    input: ArmMcpFinishNotification,
    requestedAt: string,
  ): Promise<FleetAgentWaitResult | null> => {
    const deadline = Date.now() + maxWatchMs;
    let turnId = input.turnId ?? undefined;
    let permissionSent = false;
    while (Date.now() < deadline) {
      let result: FleetAgentWaitResult;
      try {
        result = await input.waitForAgent({
          agentId: input.agentId,
          ...(input.host ? { host: input.host } : {}),
          ...(turnId ? { turnId } : {}),
          timeoutMs: Math.min(waitChunkMs, deadline - Date.now()),
        });
      } catch (error) {
        logger.warn(
          { client: input.client, agentId: input.agentId, err: String(error) },
          "mcp finish watch: wait failed, retrying",
        );
        await sleep(pollMs);
        continue;
      }
      if (!result.ok) {
        logger.warn(
          { client: input.client, agentId: input.agentId, error: result.error },
          "mcp finish watch: agent unreachable, retrying",
        );
        await sleep(pollMs);
        continue;
      }
      // Later waits stay on the turn the first one bound to.
      turnId = result.turnId ?? turnId;
      if (result.timedOut || result.status === "pending") {
        if (result.status === "pending") await sleep(pollMs);
        continue;
      }
      if (result.needsPermission) {
        if (!permissionSent) {
          permissionSent = true;
          await deliverAgentEvent(input, "needs_permission", result, requestedAt);
        }
        await sleep(pollMs);
        continue;
      }
      return result;
    }
    logger.warn(
      { client: input.client, agentId: input.agentId },
      "mcp finish watch gave up: agent still running at the watch deadline",
    );
    return null;
  };

  const watch = async (input: ArmMcpFinishNotification) => {
    const requestedAt = new Date().toISOString();
    const result = await watchUntilEnd(input, requestedAt);
    if (result) await deliverAgentEvent(input, finishReason(result.status), result, requestedAt);
  };

  const watchGroup = async (input: ArmMcpGroupNotification) => {
    const requestedAt = new Date().toISOString();
    const results = await Promise.all(
      input.agents.map(async (agent) => {
        const agentInput: ArmMcpFinishNotification = {
          ...agent,
          client: input.client,
          target: input.target,
          tool: input.tool,
          context: input.context,
          waitForAgent: input.waitForAgent,
        };
        const result = await watchUntilEnd(agentInput, requestedAt);
        if (result && input.perAgent) {
          await deliverAgentEvent(agentInput, finishReason(result.status), result, requestedAt);
        }
        return result;
      }),
    );
    const finished = results.filter((result): result is FleetAgentWaitResult => result !== null);
    if (finished.length !== results.length) {
      logger.warn(
        { client: input.client, groupId: input.groupId },
        "mcp group watch gave up: an agent was still running at the watch deadline",
      );
      return;
    }
    await post(
      input,
      {
        type: "paseo.agents.group_finished",
        client: input.client,
        context: input.context,
        groupId: input.groupId,
        agents: finished.map((result, index) => agentPayload(input.agents[index]!.agentId, result)),
        trigger: { tool: input.tool, requestedAt },
      },
      { groupId: input.groupId },
    );
  };

  return {
    arm(input) {
      return watch(input).catch((error) => {
        logger.error(
          { client: input.client, agentId: input.agentId, err: String(error) },
          "mcp finish watch failed",
        );
      });
    },
    armGroup(input) {
      return watchGroup(input).catch((error) => {
        logger.error(
          { client: input.client, groupId: input.groupId, err: String(error) },
          "mcp group watch failed",
        );
      });
    },
  };
}
