import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { FleetAgentWaitResult } from "../agent/tools/fleet-control-tools.js";
import type { RemoteMcpClient } from "../persisted-config.js";
import type { ResolveSecret } from "../secrets/vault-secret.js";

/**
 * notifyOnFinish for remote MCP clients (/mcp/fleet). A client has no agent
 * thread to wake, so the daemon POSTs a JSON event to the webhook configured
 * for that client (daemon.mcp.remoteClients[].notify) when the run ends.
 *
 * Watchers live in memory: a daemon restart drops pending notifications.
 */
export type McpNotifyTarget = NonNullable<RemoteMcpClient["notify"]>;

export interface ArmMcpFinishNotification {
  client: string;
  target: McpNotifyTarget;
  agentId: string;
  /** Host hint for the agent; omitted → resolved through the fleet index. */
  host?: string;
  tool: string;
  context: string | null;
  /** One bounded wait; the watcher calls it repeatedly until the run ends. */
  waitForAgent: (input: {
    agentId: string;
    host?: string;
    timeoutMs: number;
  }) => Promise<FleetAgentWaitResult>;
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
}

export const MAX_NOTIFY_CONTEXT_LENGTH = 2000;
const LAST_MESSAGE_LIMIT = 4000;
const VAULT_REF = /aside:\/\/\S+/;

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

  const deliver = async (
    input: ArmMcpFinishNotification,
    reason: "finished" | "errored" | "closed" | "needs_permission",
    result: FleetAgentWaitResult,
    requestedAt: string,
  ) => {
    let lastMessage = result.lastMessage?.trim() || null;
    if (lastMessage && lastMessage.length > LAST_MESSAGE_LIMIT) {
      lastMessage = `${lastMessage.slice(0, LAST_MESSAGE_LIMIT)}\n[truncated ${lastMessage.length - LAST_MESSAGE_LIMIT} chars; use fleet_get_agent_activity for the full response]`;
    }
    const body = JSON.stringify({
      type: reason === "needs_permission" ? "paseo.agent.needs_permission" : "paseo.agent.finished",
      reason,
      client: input.client,
      context: input.context,
      agent: {
        id: input.agentId,
        host: result.host,
        title: result.title,
        status: result.status,
        bucket: result.bucket,
        finishedAt: new Date().toISOString(),
        lastMessage,
        error: result.error,
      },
      trigger: { tool: input.tool, requestedAt },
    });
    const headers = await resolveHeaders(input.target.headers);
    const log = { client: input.client, agentId: input.agentId, reason };
    for (let attempt = 0; ; attempt += 1) {
      let status: number | null = null;
      try {
        const response = await fetchImpl(input.target.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        if (response.ok) {
          logger.info({ ...log, status }, "mcp finish notification delivered");
          return;
        }
      } catch (error) {
        logger.warn(
          { ...log, err: error instanceof Error ? error.message : String(error) },
          "mcp finish notification attempt failed",
        );
      }
      const retryable = status === null || status === 429 || status >= 500;
      const delay = retryDelaysMs[attempt];
      if (!retryable || delay === undefined) {
        logger.error({ ...log, status, attempts: attempt + 1 }, "mcp finish notification dropped");
        return;
      }
      await sleep(delay);
    }
  };

  const watch = async (input: ArmMcpFinishNotification) => {
    const requestedAt = new Date().toISOString();
    const deadline = Date.now() + maxWatchMs;
    let permissionSent = false;
    while (Date.now() < deadline) {
      let result: FleetAgentWaitResult;
      try {
        result = await input.waitForAgent({
          agentId: input.agentId,
          ...(input.host ? { host: input.host } : {}),
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
      if (result.timedOut) continue;
      if (result.needsPermission) {
        if (!permissionSent) {
          permissionSent = true;
          await deliver(input, "needs_permission", result, requestedAt);
        }
        await sleep(pollMs);
        continue;
      }
      permissionSent = false;
      let reason: "finished" | "errored" | "closed" = "finished";
      if (result.status === "error") reason = "errored";
      else if (result.status === "closed") reason = "closed";
      await deliver(input, reason, result, requestedAt);
      return;
    }
    logger.warn(
      { client: input.client, agentId: input.agentId },
      "mcp finish watch gave up: agent still running at the watch deadline",
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
  };
}
