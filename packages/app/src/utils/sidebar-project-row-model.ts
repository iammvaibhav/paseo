import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";

export interface SidebarProjectHostTarget {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}

/** A resolved project + host + workspace: the project's own root checkout (ADR 0001). */
export interface SidebarProjectBaseWorkspaceTarget {
  serverId: string;
  workspaceId: string;
}

export type SidebarProjectTrailingAction =
  | { kind: "new_workspace"; target: SidebarProjectHostTarget }
  | { kind: "none" };

export interface SidebarProjectSectionRowModel {
  kind: "project_section";
  chevron: "expand" | "collapse";
  trailingAction: SidebarProjectTrailingAction;
  // Null when the feature flag is off on every host, or no host has created a base workspace
  // for this project yet — callers fall back to today's toggle-collapse behavior.
  baseWorkspaceTarget: SidebarProjectBaseWorkspaceTarget | null;
}

export type SidebarProjectRowModel = SidebarProjectSectionRowModel;

const EMPTY_MULTIPLICITY_MAP: ReadonlyMap<string, boolean> = new Map();
function hostTarget(input: {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}): SidebarProjectHostTarget | null {
  const iconWorkingDir = input.iconWorkingDir.trim();
  if (!input.serverId || !iconWorkingDir) {
    return null;
  }
  return {
    serverId: input.serverId,
    projectId: input.projectId,
    iconWorkingDir,
    customIconRevision: input.customIconRevision,
    iconRevision: input.iconRevision,
  };
}

export function resolveSidebarProjectIconTarget(
  project: SidebarProjectEntry,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    const target = hostTarget(host);
    if (target) {
      return target;
    }
  }
  return null;
}

export type SidebarProjectIconTarget = ProjectIconTarget;

export function resolveSidebarProjectIconTargets(
  projects: readonly SidebarProjectEntry[],
): SidebarProjectIconTarget[] {
  return projects.flatMap((project) => {
    const target = resolveSidebarProjectIconTarget(project);
    const iconTarget = target
      ? createProjectIconTarget({ projectViewKey: project.viewKey, placement: target })
      : null;
    return iconTarget ? [iconTarget] : [];
  });
}

export function resolveSidebarProjectLocalPath(
  project: SidebarProjectEntry,
  localServerId: string | null,
): string {
  if (!localServerId) return "";
  return project.hosts.find((host) => host.serverId === localServerId)?.iconWorkingDir.trim() ?? "";
}

// A project can host a brand-new workspace on a host when that host can create a
// git worktree (git projects) OR the host supports running multiple independent
// workspaces per directory (`workspaceMultiplicity`), which is what lets non-git
// directories add a second workspace. Mirrors the gate used by the global "New
// workspace" affordances (use-global-new-workspace-action.ts and left-sidebar's
// SidebarNewWorkspaceHeaderRow): `canCreateWorktree || supportsMultiplicity`.
function resolveNewWorkspaceTarget(
  project: SidebarProjectEntry,
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    if (
      host.worktreeSupport === "unsupported" &&
      !supportsMultiplicityByServerId.get(host.serverId)
    ) {
      continue;
    }
    const target = hostTarget(host);
    if (target) return target;
  }
  return null;
}

function projectTrailingAction(
  project: SidebarProjectEntry,
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>,
): SidebarProjectTrailingAction {
  const target = resolveNewWorkspaceTarget(project, supportsMultiplicityByServerId);
  return target ? { kind: "new_workspace", target } : { kind: "none" };
}

const EMPTY_BASE_WORKSPACE_MAP: ReadonlyMap<string, boolean> = new Map();

// A project can span hosts (ADR 0001: multi-host projects each grow their own base
// checkout). The sticky last-used host wins when it is still eligible (feature on, host
// still has a base workspace); otherwise the project's only host, or its first placement,
// wins — same fallback shape as `resolveNewWorkspaceTarget`.
export function resolveSidebarProjectBaseWorkspaceTarget(
  project: SidebarProjectEntry,
  baseWorkspaceByServerId: ReadonlyMap<string, boolean>,
  preferredHostServerId?: string | null,
): SidebarProjectBaseWorkspaceTarget | null {
  const eligibleHosts = project.hosts.filter(
    (host): host is typeof host & { baseWorkspaceId: string } =>
      Boolean(host.baseWorkspaceId) && baseWorkspaceByServerId.get(host.serverId) === true,
  );
  if (eligibleHosts.length === 0) {
    return null;
  }
  const preferred = preferredHostServerId
    ? eligibleHosts.find((host) => host.serverId === preferredHostServerId)
    : undefined;
  const host = preferred ?? eligibleHosts[0];
  return { serverId: host.serverId, workspaceId: host.baseWorkspaceId };
}

export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry;
  collapsed: boolean;
  supportsMultiplicityByServerId?: ReadonlyMap<string, boolean>;
  baseWorkspaceByServerId?: ReadonlyMap<string, boolean>;
  preferredHostServerId?: string | null;
}): SidebarProjectRowModel {
  return {
    kind: "project_section",
    chevron: input.collapsed ? "expand" : "collapse",
    trailingAction: projectTrailingAction(
      input.project,
      input.supportsMultiplicityByServerId ?? EMPTY_MULTIPLICITY_MAP,
    ),
    baseWorkspaceTarget: resolveSidebarProjectBaseWorkspaceTarget(
      input.project,
      input.baseWorkspaceByServerId ?? EMPTY_BASE_WORKSPACE_MAP,
      input.preferredHostServerId,
    ),
  };
}
