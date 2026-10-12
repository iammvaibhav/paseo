import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Logger } from "pino";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ensureValidJson } from "../../json-utils.js";
import { normalizeLabels } from "../agent-projections.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import {
  cancelAgentRunCommand,
  closeAgentCommand,
  updateAgentCommand,
} from "../lifecycle-command.js";
import type { FleetIdIndex } from "../../mission-control/fleet-id-index.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export interface RegisterToolFn {
  <TInput>(
    name: string,
    config: PaseoToolConfig,
    handler: (input: TInput, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ): void;
}

export interface RegisterFleetControlToolsOptions {
  registerTool: RegisterToolFn;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  fleetIdIndex: FleetIdIndex;
  isFleetLocalTarget: (host: string) => boolean;
  hostsMatch: (hostA: string, hostB: string) => boolean;
  resolveFleetHost: (host: string) => DaemonClient | null;
  knownFleetHostsText: () => string;
  hostLabel: string;
  logger: Logger;
  /** Mission Control on this host; supplies the lifecycle bucket of local agents. */
  missionControlService?: {
    getAgentStatusRecord(agentId: string): Promise<{ bucket: string }>;
  } | null;
}

const FLEET_WAIT_DEFAULT_SECONDS = 600;
const FLEET_WAIT_MAX_SECONDS = 1800;

export interface FleetAgentWaitResult {
  ok: boolean;
  host: string;
  agentId: string;
  /** Lifecycle after the wait ("idle", "error", "running", "closed", …); "permission" when blocked on one. */
  status: string;
  /** The run ended (idle, error or closed). */
  finished: boolean;
  /** The agent is waiting on a permission decision. */
  needsPermission: boolean;
  timedOut: boolean;
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
    finished: status === "idle" || status === "error" || status === "closed",
    needsPermission: status === "permission",
    timedOut: false,
    title: null,
    bucket: null,
    lastMessage: null,
    error: null,
    ...base,
    ...fields,
  };
}

interface WaitScope {
  base: Pick<FleetAgentWaitResult, "host" | "agentId">;
  timeout: AbortSignal;
  signal: AbortSignal;
  timeoutMs: number;
}

async function waitForLocalAgent(
  deps: RegisterFleetControlToolsOptions,
  scope: WaitScope,
): Promise<FleetAgentWaitResult> {
  const { agentId } = scope.base;
  const stored = await deps.agentStorage.get(agentId);
  const title = stored?.title ?? null;
  const bucket = async () =>
    deps.missionControlService
      ? (await deps.missionControlService.getAgentStatusRecord(agentId)).bucket
      : null;
  if (!deps.agentManager.getAgent(agentId)) {
    if (!stored) {
      return waitResult(scope.base, { ok: false, error: `Agent "${agentId}" not found` });
    }
    return waitResult(scope.base, {
      status: stored.lastStatus ?? "idle",
      title,
      bucket: await bucket(),
      error: stored.lastStatus === "error" ? (stored.lastError ?? null) : null,
    });
  }
  try {
    const result = await deps.agentManager.waitForAgentEvent(agentId, {
      signal: scope.signal,
      waitForActive: true,
    });
    const errorText =
      result.status === "error" ? deps.agentManager.getAgent(agentId)?.lastError : undefined;
    return waitResult(scope.base, {
      status: result.permission ? "permission" : result.status,
      title,
      bucket: await bucket(),
      lastMessage: result.lastMessage,
      error: errorText ?? null,
    });
  } catch (error) {
    if (!scope.timeout.aborted) throw error;
    return waitResult(scope.base, {
      status: deps.agentManager.getAgent(agentId)?.lifecycle ?? "running",
      finished: false,
      timedOut: true,
      title,
      bucket: await bucket(),
    });
  }
}

async function waitForPeerAgent(
  client: DaemonClient,
  scope: WaitScope,
): Promise<FleetAgentWaitResult> {
  // The peer RPC has no cancel; the caller's abort only stops waiting here.
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  scope.signal.addEventListener("abort", () => reject(scope.signal.reason), { once: true });
  try {
    const result = await Promise.race([
      client.waitForFinish(scope.base.agentId, scope.timeoutMs),
      aborted,
    ]);
    const timedOut = result.status === "timeout";
    return waitResult(scope.base, {
      status: timedOut ? (result.final?.status ?? "running") : result.status,
      ...(timedOut ? { finished: false, timedOut } : {}),
      title: result.final?.title ?? null,
      bucket: result.final?.bucket ?? null,
      lastMessage: timedOut ? null : result.lastMessage,
      error: result.error,
    });
  } catch (error) {
    if (!scope.timeout.aborted) throw error;
    return waitResult(scope.base, { status: "running", finished: false, timedOut: true });
  }
}

const RUN_START_WAIT_MS = 15_000;
const PEER_RUN_START_POLL_MS = 250;

/**
 * Wait (bounded) until a just-prompted agent's new run has started. Without
 * it, a fleet_wait_agent issued right after fleet_send_prompt can see the
 * previous, already finished run and return its result. Only meaningful when
 * the agent was idle before the prompt; returns whether a start was seen.
 */
export async function waitForPromptedRunStart(input: {
  agentManager?: AgentManager;
  client?: DaemonClient;
  agentId: string;
}): Promise<boolean> {
  const deadline = Date.now() + RUN_START_WAIT_MS;
  if (input.client) {
    while (Date.now() < deadline) {
      const fetched = await Promise.resolve()
        .then(() => input.client!.fetchAgent(input.agentId))
        .catch(() => null);
      if (fetched?.agent.status === "running") return true;
      await sleep(PEER_RUN_START_POLL_MS);
    }
    return false;
  }
  if (!input.agentManager) return false;
  try {
    await input.agentManager.waitForAgentRunStart(input.agentId, {
      signal: AbortSignal.timeout(RUN_START_WAIT_MS),
    });
    return true;
  } catch {
    // No pending run (already finished, or queued) or the start timed out.
    return false;
  }
}

/**
 * Block until an agent's current run ends anywhere in the fleet. Returns at
 * once when the agent is not running, early when it needs a permission
 * decision, and with timedOut when the deadline passes first. Local agents
 * wait on agent-manager events; peer agents use the peer's
 * wait_for_finish RPC (also event-driven on the peer).
 */
export async function waitForFleetAgent(
  deps: RegisterFleetControlToolsOptions,
  input: { agentId: string; host?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<FleetAgentWaitResult> {
  const resolved = await resolveTargetHost(input.agentId, input.host, deps);
  const base = { host: resolved.targetHostDisplay, agentId: input.agentId };
  if (resolved.error) {
    return waitResult(base, { ok: false, error: resolved.error, guidance: resolved.guidance });
  }
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const scope: WaitScope = {
    base,
    timeout,
    signal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout,
    timeoutMs: input.timeoutMs,
  };
  if (resolved.isLocal) return waitForLocalAgent(deps, scope);
  const peer = resolvePeerDaemonClient(resolved.host, deps);
  if (!peer.client) {
    return waitResult(base, { ok: false, error: peer.error ?? null, guidance: peer.guidance });
  }
  return waitForPeerAgent(peer.client, scope);
}

const FLEET_CONTROL_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  host: z.string(),
  agentId: z.string(),
  guidance: z.string().optional(),
  error: z.string().optional(),
};

const FLEET_CANCEL_OUTPUT_SCHEMA = {
  ...FLEET_CONTROL_OUTPUT_SCHEMA,
  cancelled: z.boolean().optional(),
};

const FLEET_CANCEL_INPUT_SCHEMA = {
  agentId: z
    .string()
    .min(1)
    .describe("Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed."),
  host: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
        "Omitted → resolved via the fleet index.",
    ),
};

const FLEET_KILL_INPUT_SCHEMA = {
  agentId: z
    .string()
    .min(1)
    .describe("Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed."),
  host: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
        "Omitted → resolved via the fleet index.",
    ),
};

const FLEET_UPDATE_INPUT_SCHEMA = {
  agentId: z
    .string()
    .min(1)
    .describe("Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed."),
  host: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
        "Omitted → resolved via the fleet index.",
    ),
  title: z.string().min(1).optional().describe("New user-visible title for the agent."),
  labels: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .transform((v) => (v ? normalizeLabels(v) : undefined))
    .describe("Labels to set on the agent."),
  modeId: z
    .string()
    .min(1)
    .optional()
    .describe("Session mode to switch the agent to (e.g. 'plan', 'code', 'bypassPermissions')."),
  model: z
    .string()
    .nullable()
    .optional()
    .describe("Model id to set on the agent, or null to reset to default."),
  thinkingOptionId: z
    .string()
    .nullable()
    .optional()
    .describe("Thinking option id to set on the agent, or null to reset."),
  features: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Runtime feature flags to set on the agent."),
};

interface ResolvedTargetHost {
  host: string;
  isLocal: boolean;
  targetHostDisplay: string;
  error?: string;
  guidance?: string;
}

async function resolveTargetHost(
  agentId: string,
  hostHint: string | undefined,
  deps: RegisterFleetControlToolsOptions,
): Promise<ResolvedTargetHost> {
  if (hostHint) {
    const resolution = await deps.fleetIdIndex.resolveFleetId(agentId);
    if (resolution.kind !== "unknown" && !deps.hostsMatch(hostHint, resolution.host)) {
      const actualHost = resolution.host === "local" ? deps.hostLabel : resolution.host;
      return {
        host: actualHost,
        isLocal: deps.isFleetLocalTarget(actualHost),
        targetHostDisplay: actualHost,
        error: `Agent "${agentId}" is on host "${actualHost}", not "${hostHint}"`,
        guidance: `Target host "${actualHost}" instead or omit the host hint to auto-resolve.`,
      };
    }
    const isLocal = deps.isFleetLocalTarget(hostHint);
    return {
      host: hostHint,
      isLocal,
      targetHostDisplay: isLocal ? deps.hostLabel : hostHint,
    };
  }

  const resolution = await deps.fleetIdIndex.resolveFleetId(agentId);
  if (resolution.kind === "unknown") {
    return {
      host: "unknown",
      isLocal: false,
      targetHostDisplay: "unknown",
      error: `Agent "${agentId}" not found on any reachable host`,
      guidance: resolution.guidance,
    };
  }

  const isLocal = deps.isFleetLocalTarget(resolution.host);
  return {
    host: resolution.host,
    isLocal,
    targetHostDisplay: isLocal ? deps.hostLabel : resolution.host,
  };
}

interface ResolvedPeerClient {
  client?: DaemonClient;
  error?: string;
  guidance?: string;
}

function resolvePeerDaemonClient(
  targetHost: string,
  deps: RegisterFleetControlToolsOptions,
): ResolvedPeerClient {
  let client: DaemonClient | null;
  try {
    client = deps.resolveFleetHost(targetHost);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: message,
      guidance: "Check peer status with fleet_list_inventory.",
    };
  }
  if (!client) {
    return {
      error: `Host "${targetHost}" is not a configured peer; this daemon knows: ${deps.knownFleetHostsText()}`,
      guidance: `Use one of the known hosts: ${deps.knownFleetHostsText()}.`,
    };
  }
  return { client };
}

export function registerFleetControlTools(options: RegisterFleetControlToolsOptions): void {
  const { registerTool } = options;

  registerTool(
    "fleet_cancel_agent",
    {
      title: "Cancel agent across the fleet",
      description:
        "Abort an agent's current run across the fleet but keep the agent alive for future tasks. " +
        "agentId is fleet-wide; host is optional and resolved automatically via the fleet index.",
      inputSchema: FLEET_CANCEL_INPUT_SCHEMA,
      outputSchema: FLEET_CANCEL_OUTPUT_SCHEMA,
    },
    async ({ agentId, host: hostHint }: { agentId: string; host?: string }) => {
      const resolved = await resolveTargetHost(agentId, hostHint, options);
      if (resolved.error) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: resolved.error,
            guidance: resolved.guidance,
          }),
        };
      }

      if (resolved.isLocal) {
        try {
          const { cancelled } = await cancelAgentRunCommand(
            {
              agentManager: options.agentManager,
              agentStorage: options.agentStorage,
              logger: options.logger,
            },
            agentId,
          );
          return {
            content: [],
            structuredContent: ensureValidJson({
              ok: true,
              host: resolved.targetHostDisplay,
              agentId,
              cancelled,
              ...(cancelled ? {} : { guidance: "Agent was not running" }),
            }),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [],
            structuredContent: ensureValidJson({
              ok: false,
              host: resolved.targetHostDisplay,
              agentId,
              error: message,
              guidance: `Failed to cancel agent: ${message}`,
            }),
          };
        }
      }

      const peer = resolvePeerDaemonClient(resolved.host, options);
      if (!peer.client) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: peer.error,
            guidance: peer.guidance,
          }),
        };
      }

      try {
        await peer.client.cancelAgent(agentId);
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: true,
            host: resolved.targetHostDisplay,
            agentId,
          }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: message,
            guidance: `Failed to cancel agent on peer host "${resolved.targetHostDisplay}": ${message}`,
          }),
        };
      }
    },
  );

  registerTool(
    "fleet_kill_agent",
    {
      title: "Kill agent across the fleet",
      description:
        "Terminate an agent session permanently across the fleet. " +
        "agentId is fleet-wide; host is optional and resolved automatically via the fleet index.",
      inputSchema: FLEET_KILL_INPUT_SCHEMA,
      outputSchema: FLEET_CONTROL_OUTPUT_SCHEMA,
    },
    async ({ agentId, host: hostHint }: { agentId: string; host?: string }) => {
      const resolved = await resolveTargetHost(agentId, hostHint, options);
      if (resolved.error) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: resolved.error,
            guidance: resolved.guidance,
          }),
        };
      }

      if (resolved.isLocal) {
        try {
          await closeAgentCommand({ agentManager: options.agentManager }, agentId);
          return {
            content: [],
            structuredContent: ensureValidJson({
              ok: true,
              host: resolved.targetHostDisplay,
              agentId,
            }),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [],
            structuredContent: ensureValidJson({
              ok: false,
              host: resolved.targetHostDisplay,
              agentId,
              error: message,
              guidance: `Failed to terminate agent: ${message}`,
            }),
          };
        }
      }

      const peer = resolvePeerDaemonClient(resolved.host, options);
      if (!peer.client) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: peer.error,
            guidance: peer.guidance,
          }),
        };
      }

      try {
        await peer.client.deleteAgent(agentId);
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: true,
            host: resolved.targetHostDisplay,
            agentId,
          }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: message,
            guidance: `Failed to terminate agent on peer host "${resolved.targetHostDisplay}": ${message}`,
          }),
        };
      }
    },
  );

  interface AgentUpdatePayload {
    title?: string;
    labels?: Record<string, string>;
    modeId?: string;
    model?: string | null;
    thinkingOptionId?: string | null;
    features?: Record<string, unknown>;
  }

  function hasAnyUpdateField(updates: AgentUpdatePayload): boolean {
    return (
      updates.title !== undefined ||
      updates.labels !== undefined ||
      updates.modeId !== undefined ||
      updates.model !== undefined ||
      updates.thinkingOptionId !== undefined ||
      updates.features !== undefined
    );
  }

  async function applyLocalAgentUpdate(
    agentId: string,
    updates: AgentUpdatePayload,
    agentManager: AgentManager,
  ): Promise<{ ok: true } | { ok: false; error: string; guidance?: string }> {
    try {
      if (updates.modeId !== undefined && typeof agentManager.setAgentMode === "function") {
        await agentManager.setAgentMode(agentId, updates.modeId);
      }
      if (updates.model !== undefined && typeof agentManager.setAgentModel === "function") {
        await agentManager.setAgentModel(agentId, updates.model);
      }
      if (
        updates.thinkingOptionId !== undefined &&
        typeof agentManager.setAgentThinkingOption === "function"
      ) {
        await agentManager.setAgentThinkingOption(agentId, updates.thinkingOptionId);
      }
      if (updates.features !== undefined && typeof agentManager.setAgentFeature === "function") {
        for (const [featureId, value] of Object.entries(updates.features)) {
          await agentManager.setAgentFeature(agentId, featureId, value);
        }
      }
      if (updates.title !== undefined || updates.labels !== undefined) {
        const updateResult = await updateAgentCommand(
          { agentManager },
          { agentId, title: updates.title, labels: updates.labels },
        );
        if (!updateResult.accepted) {
          return {
            ok: false,
            error: updateResult.error ?? "Failed to update agent metadata",
            guidance: "Check provided title and labels.",
          };
        }
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        guidance: `Failed to update agent: ${message}`,
      };
    }
  }

  async function applyPeerAgentUpdate(
    agentId: string,
    updates: AgentUpdatePayload,
    client: DaemonClient,
    targetHostDisplay: string,
  ): Promise<{ ok: true } | { ok: false; error: string; guidance?: string }> {
    try {
      if (updates.modeId !== undefined) {
        await client.setAgentMode(agentId, updates.modeId);
      }
      if (updates.model !== undefined) {
        await client.setAgentModel(agentId, updates.model);
      }
      if (updates.thinkingOptionId !== undefined) {
        await client.setAgentThinkingOption(agentId, updates.thinkingOptionId);
      }
      if (updates.features !== undefined) {
        for (const [featureId, value] of Object.entries(updates.features)) {
          await client.setAgentFeature(agentId, featureId, value);
        }
      }
      if (updates.title !== undefined || updates.labels !== undefined) {
        await client.updateAgent(agentId, {
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.labels !== undefined ? { labels: updates.labels } : {}),
        });
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        guidance: `Failed to update agent on peer host "${targetHostDisplay}": ${message}`,
      };
    }
  }

  registerTool(
    "fleet_update_agent",
    {
      title: "Update agent across the fleet",
      description:
        "Update an agent's title, labels, session mode, model, thinking option, or features across the fleet. " +
        "agentId is fleet-wide; host is optional and resolved automatically via the fleet index.",
      inputSchema: FLEET_UPDATE_INPUT_SCHEMA,
      outputSchema: FLEET_CONTROL_OUTPUT_SCHEMA,
    },
    async ({
      agentId,
      host: hostHint,
      ...updates
    }: {
      agentId: string;
      host?: string;
    } & AgentUpdatePayload) => {
      if (!hasAnyUpdateField(updates)) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: hostHint ?? options.hostLabel,
            agentId,
            error: "No updates provided",
            guidance:
              "Provide at least one of: title, labels, modeId, model, thinkingOptionId, features.",
          }),
        };
      }

      const resolved = await resolveTargetHost(agentId, hostHint, options);
      if (resolved.error) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: resolved.error,
            guidance: resolved.guidance,
          }),
        };
      }

      if (resolved.isLocal) {
        const updateResult = await applyLocalAgentUpdate(agentId, updates, options.agentManager);
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: updateResult.ok,
            host: resolved.targetHostDisplay,
            agentId,
            ...(!updateResult.ok
              ? { error: updateResult.error, guidance: updateResult.guidance }
              : {}),
          }),
        };
      }

      const peer = resolvePeerDaemonClient(resolved.host, options);
      if (!peer.client) {
        return {
          content: [],
          structuredContent: ensureValidJson({
            ok: false,
            host: resolved.targetHostDisplay,
            agentId,
            error: peer.error,
            guidance: peer.guidance,
          }),
        };
      }

      const updateResult = await applyPeerAgentUpdate(
        agentId,
        updates,
        peer.client,
        resolved.targetHostDisplay,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          ok: updateResult.ok,
          host: resolved.targetHostDisplay,
          agentId,
          ...(!updateResult.ok
            ? { error: updateResult.error, guidance: updateResult.guidance }
            : {}),
        }),
      };
    },
  );

  registerTool(
    "fleet_wait_agent",
    {
      title: "Wait for an agent to finish",
      description:
        "Block until an agent's current run ends, anywhere in the fleet, then return its final state and " +
        "last message. Returns at once if the agent is not running, early if it needs a permission decision, " +
        "and with timedOut=true after timeoutSeconds (default 600, max 1800); call again to keep waiting. " +
        "Wait on several agents by calling this once per agent in parallel.",
      inputSchema: {
        agentId: FLEET_CANCEL_INPUT_SCHEMA.agentId,
        host: FLEET_CANCEL_INPUT_SCHEMA.host,
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(FLEET_WAIT_MAX_SECONDS)
          .optional()
          .describe(
            `Seconds to wait before returning timedOut=true (default ${FLEET_WAIT_DEFAULT_SECONDS}, max ${FLEET_WAIT_MAX_SECONDS}).`,
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        host: z.string(),
        agentId: z.string(),
        status: z.string(),
        finished: z.boolean(),
        needsPermission: z.boolean(),
        timedOut: z.boolean(),
        title: z.string().nullable(),
        bucket: z.string().nullable(),
        lastMessage: z.string().nullable(),
        error: z.string().nullable(),
        guidance: z.string().optional(),
      },
    },
    async (
      input: { agentId: string; host?: string; timeoutSeconds?: number },
      context: PaseoToolExecutionContext,
    ) => {
      const result = await waitForFleetAgent(options, {
        agentId: input.agentId,
        ...(input.host ? { host: input.host } : {}),
        timeoutMs: (input.timeoutSeconds ?? FLEET_WAIT_DEFAULT_SECONDS) * 1000,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return { content: [], structuredContent: ensureValidJson(result) };
    },
  );
}
