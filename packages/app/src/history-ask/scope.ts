import type { HistoryAskScopeKind } from "./labels";

export interface HistoryAskWorkspaceInput {
  id: string;
  cwd: string;
  displayName?: string | null;
  projectId?: string | null;
  /** When true, excluded from project scope shortlists. */
  archived?: boolean;
}

export interface HistoryAskScope {
  kind: HistoryAskScopeKind;
  serverId: string;
  projectId?: string;
  workspaceId?: string;
  displayName: string;
  /** Concrete cwds in scope. Empty for host-wide = all cwds on that host. */
  cwds: string[];
  workspaceIds: string[];
}

export function resolveWorkspaceScope(input: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  displayName?: string | null;
  projectId?: string | null;
}): HistoryAskScope {
  const cwd = input.cwd.trim();
  if (!cwd) {
    throw new Error("Workspace scope requires a cwd");
  }
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) {
    throw new Error("Workspace scope requires a workspaceId");
  }
  const displayName = input.displayName?.trim() || workspaceId;
  const projectId = input.projectId?.trim() || undefined;

  return {
    kind: "workspace",
    serverId: input.serverId,
    workspaceId,
    projectId,
    displayName,
    cwds: [cwd],
    workspaceIds: [workspaceId],
  };
}

/**
 * Project scope: all non-archived workspaces for `projectId` on the host.
 * Pass only workspaces that belong to this project and host.
 */
export function resolveProjectScope(input: {
  serverId: string;
  projectId: string;
  displayName?: string | null;
  workspaces: readonly HistoryAskWorkspaceInput[];
}): HistoryAskScope {
  const projectId = input.projectId.trim();
  if (!projectId) {
    throw new Error("Project scope requires a projectId");
  }

  const active = input.workspaces.filter((workspace) => {
    if (workspace.archived) {
      return false;
    }
    const cwd = workspace.cwd.trim();
    const id = workspace.id.trim();
    if (!cwd || !id) {
      return false;
    }
    const workspaceProjectId = workspace.projectId?.trim();
    if (workspaceProjectId && workspaceProjectId !== projectId) {
      return false;
    }
    return true;
  });

  const cwds: string[] = [];
  const workspaceIds: string[] = [];
  const seenCwd = new Set<string>();
  const seenId = new Set<string>();

  for (const workspace of active) {
    const cwd = workspace.cwd.trim();
    const id = workspace.id.trim();
    if (!seenCwd.has(cwd)) {
      seenCwd.add(cwd);
      cwds.push(cwd);
    }
    if (!seenId.has(id)) {
      seenId.add(id);
      workspaceIds.push(id);
    }
  }

  return {
    kind: "project",
    serverId: input.serverId,
    projectId,
    displayName: input.displayName?.trim() || projectId,
    cwds,
    workspaceIds,
  };
}

/**
 * Host-wide scope. Empty `cwds` means search all agents on the host
 * (list_agents without cwd filter). Launch still needs a primary cwd from
 * elsewhere when the agent process starts.
 */
export function resolveHostScope(input: {
  serverId: string;
  displayName?: string | null;
}): HistoryAskScope {
  const serverId = input.serverId.trim();
  if (!serverId) {
    throw new Error("Host scope requires a serverId");
  }
  return {
    kind: "host",
    serverId,
    displayName: input.displayName?.trim() || serverId,
    cwds: [],
    workspaceIds: [],
  };
}
