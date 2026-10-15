import { z } from "zod";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";
import { ensureValidJson } from "../../json-utils.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { unarchiveAgentState } from "../agent-prompt.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import {
  resolvePeerDaemonClient,
  resolveTargetHost,
  type RegisterFleetControlToolsOptions,
} from "./fleet-control-tools.js";
import { executeFleetToolOnPeer } from "./fleet-wait.js";
import type { PaseoToolResult } from "./types.js";

/** What restoring archived agents and workspaces needs from this daemon. */
export interface FleetUnarchiveDependencies {
  agentManager: Pick<AgentManager, "getAgent" | "notifyAgentState" | "unarchiveSnapshot">;
  agentStorage: AgentStorage;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  /**
   * Restore an archived workspace the way the app's Restore does: unarchive
   * its record and project, recreate a worktree Paseo removed, and publish it
   * to connected clients. Throws when the workspace cannot be restored.
   */
  restoreWorkspace: (workspaceId: string) => Promise<void>;
  /** Push a stored (not live) agent record to connected clients. */
  emitStoredAgentUpdate: (record: StoredAgentRecord) => Promise<void>;
}

/** Absent local pieces leave only the peer path: targets on this host get an error. */
export interface RegisterFleetUnarchiveToolsOptions extends RegisterFleetControlToolsOptions {
  workspaceRegistry?: FleetUnarchiveDependencies["workspaceRegistry"] | null;
  restoreWorkspace?: FleetUnarchiveDependencies["restoreWorkspace"] | null;
  emitStoredAgentUpdate?: FleetUnarchiveDependencies["emitStoredAgentUpdate"] | null;
}

/** The label History Ask search agents carry. */
const HISTORY_ASK_LABEL_KEY = "paseo.history-ask";

/** A peer restore can recreate a git worktree, which outlasts the RPC default. */
const PEER_UNARCHIVE_TIMEOUT_MS = 10 * 60_000;

const WORKSPACE_ID_PATTERN = /^wks_[0-9a-f]{16}$/;

/** A peer's tool result: the same structured fields this host returns. */
const PEER_RESULT_SCHEMA = z.record(z.string(), z.unknown());

const HOST_HINT_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
      "Omitted → resolved via the fleet index.",
  );

const UNARCHIVE_AGENT_INPUT_SCHEMA = {
  agentId: z
    .string()
    .min(1)
    .describe("Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed."),
  host: HOST_HINT_SCHEMA,
};

const UNARCHIVE_AGENT_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  host: z.string(),
  agentId: z.string(),
  // False when the agent was not archived.
  unarchived: z.boolean().optional(),
  // The agent's archived workspace, restored with it.
  restoredWorkspaceId: z.string().optional(),
  guidance: z.string().optional(),
  error: z.string().optional(),
};

const UNARCHIVE_WORKSPACE_INPUT_SCHEMA = {
  workspaceId: z
    .string()
    .regex(
      WORKSPACE_ID_PATTERN,
      "workspaceId must be a workspace id (wks_ + 16 hex), for example an agent's workspaceId",
    )
    .describe(
      "Workspace id (wks_…). Archived workspaces are not in fleet_list_inventory; take the id from " +
        "an agent's fleet_agent_status or fleet_list_agents data.",
    ),
  host: HOST_HINT_SCHEMA,
};

const UNARCHIVE_WORKSPACE_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  host: z.string(),
  workspaceId: z.string(),
  // True when the workspace itself was archived and is now restored.
  restoredWorkspace: z.boolean().optional(),
  unarchivedAgentIds: z.array(z.string()).optional(),
  failedAgents: z.array(z.object({ agentId: z.string(), error: z.string() })).optional(),
  guidance: z.string().optional(),
  error: z.string().optional(),
};

function result(structuredContent: Record<string, unknown>): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(structuredContent) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Clear an agent's archived flag. A live agent announces the change through
 * agent_state; a stored record has no event stream of its own, so it is
 * pushed to clients here. False when the agent was not archived.
 */
async function unarchiveAgentRecord(
  deps: FleetUnarchiveDependencies,
  agentId: string,
): Promise<boolean> {
  if (!(await unarchiveAgentState(deps.agentStorage, deps.agentManager, agentId))) {
    return false;
  }
  if (!deps.agentManager.getAgent(agentId)) {
    const record = await deps.agentStorage.get(agentId);
    if (record) {
      await deps.emitStoredAgentUpdate(record);
    }
  }
  return true;
}

export interface LocalAgentUnarchiveResult {
  unarchived: boolean;
  restoredWorkspaceId: string | null;
}

/**
 * Restore one archived agent on this daemon. Its workspace comes back with
 * it when that is archived too (an agent archived with its workspace has no
 * directory to run in otherwise); the workspace's other agents stay archived.
 */
export async function unarchiveAgentOnThisHost(
  deps: FleetUnarchiveDependencies,
  agentId: string,
): Promise<LocalAgentUnarchiveResult> {
  const record = await deps.agentStorage.get(agentId);
  if (!record) {
    throw new Error(`Agent ${agentId} not found on this host`);
  }
  let restoredWorkspaceId: string | null = null;
  if (record.workspaceId && (await deps.workspaceRegistry.get(record.workspaceId))?.archivedAt) {
    await deps.restoreWorkspace(record.workspaceId);
    restoredWorkspaceId = record.workspaceId;
  }
  const unarchived = await unarchiveAgentRecord(deps, agentId);
  return { unarchived, restoredWorkspaceId };
}

/** {@link unarchiveAgentOnThisHost} bound to this daemon, for the app's agent.unarchive RPC. */
export type UnarchiveAgent = (agentId: string) => Promise<LocalAgentUnarchiveResult>;

interface LocalWorkspaceUnarchiveResult {
  restoredWorkspace: boolean;
  unarchivedAgentIds: string[];
  failedAgents: Array<{ agentId: string; error: string }>;
}

/**
 * Restore an archived workspace on this daemon, then every archived agent in
 * it: the reverse of the archive cascade, which archives all of a
 * workspace's agents. Mission Control machinery (Commander, verifiers) and
 * History Ask agents are archived by their dispatchers once their job ends,
 * so they stay archived.
 */
async function unarchiveWorkspaceOnThisHost(
  deps: FleetUnarchiveDependencies,
  workspaceId: string,
): Promise<LocalWorkspaceUnarchiveResult> {
  const workspace = await deps.workspaceRegistry.get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found on this host`);
  }
  const restoredWorkspace = Boolean(workspace.archivedAt);
  if (restoredWorkspace) {
    await deps.restoreWorkspace(workspaceId);
  }
  const archivedAgents = (await deps.agentStorage.listByWorkspace(workspaceId)).filter(
    (record) =>
      record.archivedAt &&
      record.internal !== true &&
      !isSystemOwnedAgentLabels(record.labels) &&
      record.labels[HISTORY_ASK_LABEL_KEY] === undefined,
  );
  const outcomes = await Promise.allSettled(
    archivedAgents.map((record) => unarchiveAgentRecord(deps, record.id)),
  );
  const unarchivedAgentIds: string[] = [];
  const failedAgents: Array<{ agentId: string; error: string }> = [];
  outcomes.forEach((outcome, index) => {
    const agentId = archivedAgents[index]!.id;
    if (outcome.status === "rejected") {
      failedAgents.push({ agentId, error: errorMessage(outcome.reason) });
    } else if (outcome.value) {
      unarchivedAgentIds.push(agentId);
    }
  });
  return { restoredWorkspace, unarchivedAgentIds, failedAgents };
}

async function resolveWorkspaceHost(
  workspaceId: string,
  hostHint: string | undefined,
  options: RegisterFleetUnarchiveToolsOptions,
): Promise<{ host: string; isLocal: boolean; display: string } | { error: string }> {
  const resolution = await options.fleetIdIndex.resolveFleetId(workspaceId);
  if (hostHint) {
    if (resolution.kind !== "unknown" && !options.hostsMatch(hostHint, resolution.host)) {
      const actualHost = resolution.host === "local" ? options.hostLabel : resolution.host;
      return { error: `Workspace "${workspaceId}" is on host "${actualHost}", not "${hostHint}"` };
    }
    const isLocal = options.isFleetLocalTarget(hostHint);
    return { host: hostHint, isLocal, display: isLocal ? options.hostLabel : hostHint };
  }
  if (resolution.kind === "unknown") {
    return {
      error:
        `Workspace "${workspaceId}" is not on this host and no reachable host lists it. ` +
        "Archived workspaces on other hosts are not in the fleet index: pass host (the host of an " +
        "agent that worked in it, from fleet_search or fleet_agent_status).",
    };
  }
  const isLocal = options.isFleetLocalTarget(resolution.host);
  return {
    host: resolution.host,
    isLocal,
    display: isLocal ? options.hostLabel : resolution.host,
  };
}

/** Run an unarchive tool on the peer that owns the target, under the peer's own catalog. */
async function runOnPeer(
  options: RegisterFleetUnarchiveToolsOptions,
  host: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<
  { ok: true; structuredContent: Record<string, unknown> } | { ok: false; error: string }
> {
  const peer = resolvePeerDaemonClient(host, options);
  if (!peer.client) {
    return { ok: false, error: peer.error ?? `Host "${host}" is unreachable` };
  }
  try {
    const outcome = await executeFleetToolOnPeer(
      peer.client,
      toolName,
      args,
      PEER_UNARCHIVE_TIMEOUT_MS,
    );
    if (outcome.ok) {
      const parsed = PEER_RESULT_SCHEMA.safeParse(outcome.structuredContent);
      return { ok: true, structuredContent: parsed.success ? parsed.data : {} };
    }
    // Hosts that predate the tool refuse it by name.
    if (
      outcome.error.includes("not on the Commander allowlist") ||
      outcome.error.includes("Unknown Paseo tool")
    ) {
      return { ok: false, error: `Host "${host}" does not have ${toolName}; update Paseo there.` };
    }
    return { ok: false, error: outcome.error };
  } catch (error) {
    return { ok: false, error: `${toolName} failed on host "${host}": ${errorMessage(error)}` };
  }
}

const UNAVAILABLE_ERROR = "Restoring archived agents is not configured on this host";

export function registerFleetUnarchiveTools(options: RegisterFleetUnarchiveToolsOptions): void {
  const { registerTool, workspaceRegistry, restoreWorkspace, emitStoredAgentUpdate } = options;
  const unarchive: FleetUnarchiveDependencies | null =
    workspaceRegistry && restoreWorkspace && emitStoredAgentUpdate
      ? {
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          workspaceRegistry,
          restoreWorkspace,
          emitStoredAgentUpdate,
        }
      : null;

  registerTool(
    "fleet_unarchive_agent",
    {
      title: "Unarchive an agent",
      description:
        "Restore an archived agent anywhere in the fleet so it is active again; fleet_send_prompt then " +
        "resumes it. When its workspace is archived too, the workspace is restored with it (its other " +
        "agents stay archived). A non-archived agent is left as it is. agentId is fleet-wide; host is " +
        "optional and resolved via the fleet index. Never approval-gated.",
      inputSchema: UNARCHIVE_AGENT_INPUT_SCHEMA,
      outputSchema: UNARCHIVE_AGENT_OUTPUT_SCHEMA,
    },
    async ({ agentId: requestedAgentId, host: hostHint }: { agentId: string; host?: string }) => {
      const resolved = await resolveTargetHost(requestedAgentId, hostHint, options);
      const { agentId } = resolved;
      const base = { host: resolved.targetHostDisplay, agentId };
      if (resolved.error) {
        return result({ ok: false, ...base, error: resolved.error, guidance: resolved.guidance });
      }
      if (!resolved.isLocal) {
        const outcome = await runOnPeer(options, resolved.host, "fleet_unarchive_agent", {
          agentId,
        });
        return outcome.ok
          ? result({ ...outcome.structuredContent, ...base })
          : result({ ok: false, ...base, error: outcome.error });
      }
      if (!unarchive) {
        return result({ ok: false, ...base, error: UNAVAILABLE_ERROR });
      }
      try {
        const local = await unarchiveAgentOnThisHost(unarchive, agentId);
        let guidance = local.unarchived
          ? "Agent is active again; fleet_send_prompt resumes it."
          : "Agent was not archived; nothing changed.";
        if (local.restoredWorkspaceId) {
          guidance += ` Its archived workspace ${local.restoredWorkspaceId} was restored too.`;
        }
        return result({
          ok: true,
          ...base,
          unarchived: local.unarchived,
          ...(local.restoredWorkspaceId ? { restoredWorkspaceId: local.restoredWorkspaceId } : {}),
          guidance,
        });
      } catch (error) {
        options.logger.warn({ err: error, agentId }, "fleet_unarchive_agent failed");
        return result({ ok: false, ...base, error: errorMessage(error) });
      }
    },
  );

  registerTool(
    "fleet_unarchive_workspace",
    {
      title: "Unarchive a workspace",
      description:
        "Restore an archived workspace anywhere in the fleet together with its archived agents (the " +
        "reverse of fleet_archive_workspace). A worktree removed on archive is recreated from its " +
        "branch. Mission Control machinery (Commander, verifiers) and History Ask agents stay " +
        "archived. host is optional; archived workspaces on another host are not in the fleet " +
        "index, so pass host for those. Never approval-gated.",
      inputSchema: UNARCHIVE_WORKSPACE_INPUT_SCHEMA,
      outputSchema: UNARCHIVE_WORKSPACE_OUTPUT_SCHEMA,
    },
    async ({ workspaceId, host: hostHint }: { workspaceId: string; host?: string }) => {
      const resolved = await resolveWorkspaceHost(workspaceId, hostHint, options);
      if ("error" in resolved) {
        return result({
          ok: false,
          host: hostHint ?? options.hostLabel,
          workspaceId,
          error: resolved.error,
        });
      }
      const base = { host: resolved.display, workspaceId };
      if (!resolved.isLocal) {
        const outcome = await runOnPeer(options, resolved.host, "fleet_unarchive_workspace", {
          workspaceId,
        });
        return outcome.ok
          ? result({ ...outcome.structuredContent, ...base })
          : result({ ok: false, ...base, error: outcome.error });
      }
      if (!unarchive) {
        return result({ ok: false, ...base, error: UNAVAILABLE_ERROR });
      }
      try {
        const local = await unarchiveWorkspaceOnThisHost(unarchive, workspaceId);
        const restored = local.restoredWorkspace
          ? "Workspace restored"
          : "Workspace was not archived";
        return result({
          ok: local.failedAgents.length === 0,
          ...base,
          restoredWorkspace: local.restoredWorkspace,
          unarchivedAgentIds: local.unarchivedAgentIds,
          ...(local.failedAgents.length > 0 ? { failedAgents: local.failedAgents } : {}),
          guidance: `${restored}; ${local.unarchivedAgentIds.length} archived agent(s) unarchived.`,
          ...(local.failedAgents.length > 0
            ? { error: `${local.failedAgents.length} agent(s) could not be unarchived` }
            : {}),
        });
      } catch (error) {
        options.logger.warn({ err: error, workspaceId }, "fleet_unarchive_workspace failed");
        return result({ ok: false, ...base, error: errorMessage(error) });
      }
    },
  );
}
