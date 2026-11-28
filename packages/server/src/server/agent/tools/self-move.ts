import type { Logger } from "pino";

import type { FleetIdResolution } from "../../mission-control/fleet-id-index.js";
import {
  moveAgentWhenRunSettles,
  type MoveAgentResult,
  type MoveAgentWhenRunSettlesDependencies,
} from "../../mission-control/meta-actions.js";
import type { AgentManager } from "../agent-manager.js";

export interface AgentSelfMoveDependencies extends MoveAgentWhenRunSettlesDependencies {
  agentManager: MoveAgentWhenRunSettlesDependencies["agentManager"] &
    Pick<AgentManager, "appendTimelineItem">;
  resolveFleetId: (id: string) => Promise<FleetIdResolution>;
  emitWorkspaceUpdates?: (workspaceIds: Iterable<string>) => Promise<void>;
  logger: Logger;
}

/**
 * fleet_move_agent called by an agent on itself. The caller is mid-turn and a
 * move refuses running agents, so the target is validated now and the move
 * applies once this turn settles. The outcome lands in the agent's timeline:
 * nothing else is listening once the turn has ended.
 *
 * Returns the guidance for the tool result; throws when the target is invalid.
 */
export async function scheduleAgentSelfMove(
  deps: AgentSelfMoveDependencies,
  input: { agentId: string; workspaceId: string },
): Promise<string> {
  const { agentId } = input;
  const workspaceId = input.workspaceId.trim();
  const localWorkspace = await deps.workspaceRegistry.get(workspaceId);
  let targetHost: string | undefined;
  if (localWorkspace) {
    if (localWorkspace.archivedAt) {
      throw new Error(`Workspace ${workspaceId} is archived`);
    }
  } else {
    const resolution = await deps.resolveFleetId(workspaceId);
    if (resolution.kind === "unknown") {
      throw new Error(resolution.guidance);
    }
    if (resolution.kind !== "workspace" || resolution.host === "local") {
      throw new Error(
        `Workspace ${workspaceId} not found. Call fleet_list_inventory to resolve a workspace id.`,
      );
    }
    targetHost = resolution.host;
  }

  void moveAgentWhenRunSettles(
    {
      ...deps,
      emitWorkspaceUpdate: (id) => deps.emitWorkspaceUpdates?.([id]),
    },
    { agentId, workspaceId, ...(targetHost ? { targetHost } : {}) },
  ).then(
    (result) => reportSelfMoveApplied(deps, result),
    (error: unknown) => reportSelfMoveFailed(deps, agentId, workspaceId, error),
  );

  const where = targetHost
    ? `workspace ${workspaceId} on ${targetHost}`
    : `workspace ${workspaceId}`;
  return (
    `Move to ${where} is scheduled. It applies when this turn ends: finish your reply now. ` +
    "Your next turn runs in the new workspace directory."
  );
}

async function reportSelfMoveApplied(
  deps: AgentSelfMoveDependencies,
  result: MoveAgentResult,
): Promise<void> {
  deps.logger.info(
    {
      agentId: result.agentId,
      fromWorkspaceId: result.fromWorkspaceId,
      toWorkspaceId: result.toWorkspaceId,
      targetServerId: result.targetServerId,
    },
    "agent.self_move.applied",
  );
  if (result.targetServerId) {
    // Cross-host: the source workspace lost the agent; the peer announces the
    // agent in its new home.
    return;
  }
  const workspaceIds = [result.fromWorkspaceId, result.toWorkspaceId].filter((id): id is string =>
    Boolean(id),
  );
  try {
    await deps.emitWorkspaceUpdates?.(workspaceIds);
  } catch (error) {
    deps.logger.warn({ err: error, agentId: result.agentId }, "agent.self_move.emit_failed");
  }
}

async function reportSelfMoveFailed(
  deps: AgentSelfMoveDependencies,
  agentId: string,
  workspaceId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  deps.logger.warn({ err: error, agentId, workspaceId }, "agent.self_move.failed");
  try {
    await deps.agentManager.appendTimelineItem(agentId, {
      type: "notification",
      level: "error",
      message: `Moving to workspace ${workspaceId} failed: ${message}`,
    });
  } catch (appendError) {
    deps.logger.warn({ err: appendError, agentId }, "agent.self_move.notice_failed");
  }
}
