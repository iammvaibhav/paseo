import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import {
  COMMANDER_HOME_DIR_SEGMENT,
  isSystemOwnedAgentLabels,
} from "@getpaseo/protocol/mission-control/system-owned";
import { isHistoryAskAgent } from "@/history-ask";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

export interface WorkspaceAgentForSidebar {
  workspaceId?: string | null;
  labels?: Record<string, string> | null;
}

/**
 * Known paseo-home directory names. The Commander home lives at
 * `<paseoHome>/commander` (docs): the standard home is `~/.paseo`, the dev
 * daemon's is `.dev/paseo-home`. Only these two layouts are matched, so a
 * user project merely named "commander" (`~/commander`,
 * `/Users/…/paseo/commander`, …) can never be mistaken for system-owned
 * infrastructure.
 */
const KNOWN_PASEO_HOME_DIR_NAMES = new Set([".paseo", "paseo-home"]);

/**
 * True when a workspace directory is the Commander's reserved home
 * (`<paseoHome>/commander` — the shared `COMMANDER_HOME_DIR_SEGMENT` as the
 * last path segment under a known paseo-home directory). The directory is the
 * workspace-level system-owned marker: no user project can claim that cwd, so
 * the match is unambiguous even for an orphaned home workspace with no live
 * agents.
 */
export function isCommanderHomeWorkspaceDirectory(
  workspaceDirectory: string | null | undefined,
): boolean {
  if (!workspaceDirectory) {
    return false;
  }
  const segments = workspaceDirectory.split("/");
  if (segments[segments.length - 1] !== COMMANDER_HOME_DIR_SEGMENT) {
    return false;
  }
  return KNOWN_PASEO_HOME_DIR_NAMES.has(segments[segments.length - 2]);
}

/**
 * True when a workspace is system-owned: the Commander's reserved home
 * directory, or a workspace whose agents are ALL system-owned
 * (`paseo.mission-control*` — Commander, verifiers, machinery). History Ask
 * workspaces are NOT system-owned (separate surface artifact); the sidebar
 * keeps hiding those in both modes via {@link isSidebarWorkspaceHidden}.
 */
export function isSystemOwnedWorkspace(input: {
  agentsInWorkspace: WorkspaceAgentForSidebar[];
  workspaceDirectory: string | null | undefined;
}): boolean {
  if (isCommanderHomeWorkspaceDirectory(input.workspaceDirectory)) {
    return true;
  }
  if (input.agentsInWorkspace.length === 0) {
    return false;
  }
  return input.agentsInWorkspace.every((agent) =>
    isSystemOwnedAgentLabels(agent.labels ?? undefined),
  );
}

export function isSidebarWorkspaceHidden(input: {
  agentsInWorkspace: WorkspaceAgentForSidebar[];
  workspaceDirectory?: string | null;
  /**
   * Mission Control verbose mode: when ON, system-owned workspaces (the
   * Commander's home + machinery-only workspaces) are shown in the sidebar so
   * machinery can be inspected on demand; when OFF they are hidden. History
   * Ask workspaces stay hidden in both modes.
   */
  hideSystemOwnedWorkspaces: boolean;
}): boolean {
  const { agentsInWorkspace, workspaceDirectory, hideSystemOwnedWorkspaces } = input;
  const hasMachineryOnlyAgents =
    agentsInWorkspace.length > 0 &&
    agentsInWorkspace.every(
      (agent) =>
        isHistoryAskAgent(agent.labels) || isSystemOwnedAgentLabels(agent.labels ?? undefined),
    );
  const isCommanderHome = isCommanderHomeWorkspaceDirectory(workspaceDirectory);
  if (!hasMachineryOnlyAgents && !isCommanderHome) {
    return false;
  }
  if (!hideSystemOwnedWorkspaces) {
    // Verbose ON: machinery workspaces with a system-owned agent, and the
    // Commander's home, show. History-Ask-only workspaces stay hidden in both modes.
    const hasSystemOwnedAgent = agentsInWorkspace.some((agent) =>
      isSystemOwnedAgentLabels(agent.labels ?? undefined),
    );
    if (hasSystemOwnedAgent || isCommanderHome) {
      return false;
    }
  }
  return true;
}

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  worktreeSupport: "supported" | "unsupported" | "unknown";
  customIconRevision?: string | null;
}

export interface WorkspaceStructureProject {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"] | "unknown";
  iconWorkingDir: string;
  hosts: WorkspaceStructureHostPlacement[];
  workspaceKeys: string[];
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
}

export interface WorkspaceStructureSession {
  serverId: string;
  projects: Iterable<ProjectDescriptor>;
  workspaces: Iterable<WorkspaceDescriptor>;
  agents?: Iterable<WorkspaceAgentForSidebar>;
}

interface ProjectDraft {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  hasCustomName: boolean;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  hosts: Map<string, WorkspaceStructureHostPlacement>;
  workspaces: Array<{ workspaceId: string; workspaceName: string; workspaceKey: string }>;
}

/** The single app boundary that turns host-local projects into grouped display projects. */
export function buildWorkspaceStructureProjects(input: {
  sessions: WorkspaceStructureSession[];
  /** Default hidden; Mission Control verbose mode passes false. */
  hideSystemOwnedWorkspaces?: boolean;
}): WorkspaceStructureProject[] {
  const { hideSystemOwnedWorkspaces = true } = input;
  const byProject = new Map<string, ProjectDraft>();
  const projectEntries: Array<{ serverId: string; project: ProjectDescriptor }> = [];
  const keyCountsByServer = new Map<string, Map<string, number>>();
  const viewKeyByServerProjectId = new Map<string, Map<string, string>>();

  for (const session of input.sessions) {
    for (const project of session.projects) {
      projectEntries.push({ serverId: session.serverId, project });
      const sharedKey = project.projectKey ?? null;
      if (sharedKey) {
        const counts = getOrCreate(keyCountsByServer, session.serverId, () => new Map());
        counts.set(sharedKey, (counts.get(sharedKey) ?? 0) + 1);
      }
    }
  }

  const allocatedViewKeys = new Set(
    projectEntries.flatMap(({ project }) => (project.projectKey ? [project.projectKey] : [])),
  );

  for (const { serverId, project } of projectEntries) {
    const viewKey = addProjectToView({
      byProject,
      keyCountsByServer,
      allocatedViewKeys,
      serverId,
      project,
    });
    getOrCreate(viewKeyByServerProjectId, serverId, () => new Map()).set(
      project.projectId,
      viewKey,
    );
  }

  for (const session of input.sessions) {
    const agentsByWorkspaceId = new Map<string, WorkspaceAgentForSidebar[]>();
    if (session.agents) {
      for (const agent of session.agents) {
        if (!agent.workspaceId) continue;
        const existing = agentsByWorkspaceId.get(agent.workspaceId);
        if (existing) {
          existing.push(agent);
        } else {
          agentsByWorkspaceId.set(agent.workspaceId, [agent]);
        }
      }
    }

    for (const workspace of session.workspaces) {
      const agentsInWorkspace = agentsByWorkspaceId.get(workspace.id) ?? [];
      if (
        isSidebarWorkspaceHidden({
          agentsInWorkspace,
          workspaceDirectory: workspace.workspaceDirectory,
          hideSystemOwnedWorkspaces,
        })
      ) {
        continue;
      }
      const viewKey = viewKeyByServerProjectId.get(session.serverId)?.get(workspace.projectId);
      if (!viewKey) continue;
      byProject.get(viewKey)?.workspaces.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKey: `${session.serverId}:${workspace.id}`,
      });
    }
  }

  return Array.from(byProject.values())
    .map((draft) => ({
      viewKey: draft.viewKey,
      projectKey: draft.projectKey,
      projectName: draft.projectName,
      projectKind: draft.projectKind,
      iconWorkingDir: draft.iconWorkingDir,
      hosts: Array.from(draft.hosts.values()),
      workspaceKeys: draft.workspaces
        .sort(compareWorkspaceStructureItems)
        .map((workspace) => workspace.workspaceKey),
    }))
    .sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) || left.viewKey.localeCompare(right.viewKey),
    );
}

export function createProjectViewKey(
  identity:
    | { kind: "equivalence"; projectKey: string }
    | { kind: "placement"; serverId: string; projectId: string },
): string {
  return identity.kind === "equivalence"
    ? identity.projectKey
    : JSON.stringify([identity.serverId, identity.projectId]);
}

function allocatePlacementViewKey(
  allocatedViewKeys: Set<string>,
  serverId: string,
  projectId: string,
): string {
  const legacyKey = createProjectViewKey({ kind: "placement", serverId, projectId });
  if (!allocatedViewKeys.has(legacyKey)) {
    allocatedViewKeys.add(legacyKey);
    return legacyKey;
  }

  for (let suffix = 0; ; suffix += 1) {
    const collisionKey = JSON.stringify(["placement", serverId, projectId, suffix]);
    if (allocatedViewKeys.has(collisionKey)) continue;
    allocatedViewKeys.add(collisionKey);
    return collisionKey;
  }
}

function addProjectToView(input: {
  byProject: Map<string, ProjectDraft>;
  keyCountsByServer: Map<string, Map<string, number>>;
  allocatedViewKeys: Set<string>;
  serverId: string;
  project: ProjectDescriptor;
}): string {
  const { byProject, keyCountsByServer, serverId, project } = input;
  const sharedKey = project.projectKey ?? null;
  const canUseSharedKey =
    sharedKey !== null && keyCountsByServer.get(serverId)?.get(sharedKey) === 1;
  const viewKey = canUseSharedKey
    ? createProjectViewKey({ kind: "equivalence", projectKey: sharedKey })
    : allocatePlacementViewKey(input.allocatedViewKeys, serverId, project.projectId);
  const placement: WorkspaceStructureHostPlacement = {
    serverId,
    projectId: project.projectId,
    iconWorkingDir: project.projectRootPath,
    worktreeSupport: project.projectKind === "git" ? "supported" : "unsupported",
    customIconRevision: project.projectCustomIconRevision,
  };
  const draft = byProject.get(viewKey);
  if (!draft) {
    byProject.set(viewKey, {
      viewKey,
      projectKey: sharedKey,
      projectName:
        project.projectCustomName ??
        project.projectDisplayName ??
        projectDisplayNameFromProjectId(project.projectId),
      hasCustomName: Boolean(project.projectCustomName),
      projectKind: project.projectKind,
      iconWorkingDir: project.projectRootPath,
      hosts: new Map([[serverId, placement]]),
      workspaces: [],
    });
  } else {
    if (project.projectCustomName && !draft.hasCustomName) {
      draft.projectName = project.projectCustomName;
      draft.hasCustomName = true;
    }
    draft.hosts.set(serverId, placement);
  }
  return viewKey;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function compareWorkspaceStructureItems(
  left: { workspaceId: string; workspaceName: string },
  right: { workspaceId: string; workspaceName: string },
): number {
  return (
    left.workspaceName.localeCompare(right.workspaceName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || left.workspaceId.localeCompare(right.workspaceId, undefined, { sensitivity: "base" })
  );
}
