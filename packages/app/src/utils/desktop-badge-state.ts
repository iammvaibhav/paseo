import {
  isSystemOwnedWorkspace,
  type WorkspaceAgentForSidebar,
} from "@/projects/workspace-structure";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { memoizeOnSessionMaps } from "./memoize-on-session-maps";

export type DesktopBadgeWorkspaceStatus = WorkspaceDescriptor["status"];

interface WorkspaceStatusSession {
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
  agents?: ReadonlyMap<string, WorkspaceAgentForSidebar>;
}

interface WorkspaceStatusSource {
  sessions: Record<string, WorkspaceStatusSession | undefined>;
}

export function isWorkspaceActionableForDesktopBadge(status: DesktopBadgeWorkspaceStatus): boolean {
  return status === "attention" || status === "needs_input" || status === "failed";
}

/**
 * The macOS dock badge only needs a count, so count here instead of materialising every
 * workspace status and comparing the whole list on every store write.
 */
export interface DockBadgeOptions {
  /** Count background workspaces too, as the sidebar shows them while Show background is on. */
  showBackground?: boolean;
  /**
   * Mission Control verbose is off: system-owned workspaces (the Commander's home and
   * machinery-only workspaces) stay out of the count, as they stay out of the sidebar.
   */
  hideSystemOwnedWorkspaces?: boolean;
}

export function selectMacDockBadgeCount(
  state: WorkspaceStatusSource,
  options: DockBadgeOptions = {},
): number | undefined {
  let actionableCount = 0;
  for (const session of Object.values(state.sessions)) {
    if (!session) continue;
    const agentsByWorkspaceId = options.hideSystemOwnedWorkspaces
      ? groupAgentsByWorkspace(session)
      : null;
    for (const workspace of session.workspaces.values()) {
      // A hidden background workspace would leave the badge pointing at nothing in the sidebar.
      if (workspace.background && !options.showBackground) continue;
      if (
        agentsByWorkspaceId &&
        isSystemOwnedWorkspace({
          agentsInWorkspace: agentsByWorkspaceId.get(workspace.id) ?? [],
          workspaceDirectory: workspace.workspaceDirectory,
        })
      ) {
        continue;
      }
      if (isWorkspaceActionableForDesktopBadge(workspace.status)) actionableCount += 1;
    }
  }
  return actionableCount > 0 ? actionableCount : undefined;
}

function groupAgentsByWorkspace(
  session: WorkspaceStatusSession,
): Map<string, WorkspaceAgentForSidebar[]> {
  const byWorkspace = new Map<string, WorkspaceAgentForSidebar[]>();
  for (const agent of session.agents?.values() ?? []) {
    if (!agent.workspaceId) continue;
    const existing = byWorkspace.get(agent.workspaceId);
    if (existing) existing.push(agent);
    else byWorkspace.set(agent.workspaceId, [agent]);
  }
  return byWorkspace;
}

/** A session-store selector for the dock badge count that recounts only when a workspace map changes. */
export function createMacDockBadgeCountSelector(
  options: DockBadgeOptions = {},
): (state: WorkspaceStatusSource) => number | undefined {
  return memoizeOnSessionMaps<WorkspaceStatusSession, WorkspaceStatusSource, number | undefined>(
    // Which workspaces are system-owned depends on their agents.
    (session) =>
      options.hideSystemOwnedWorkspaces
        ? [session.workspaces, session.agents]
        : [session.workspaces],
    (state) => selectMacDockBadgeCount(state, options),
  );
}
