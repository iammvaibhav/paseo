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

export async function resolveTargetHost(
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

export function resolvePeerDaemonClient(
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
}
