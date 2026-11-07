import { useMemo } from "react";
import { queryClient } from "@/data/query-client";
import { useAppSettings } from "@/hooks/use-settings";
import { APP_SETTINGS_QUERY_KEY, type AppSettings } from "@/hooks/use-settings/storage";
import {
  getHostProjectSourceDirectory,
  hostProjectFromWorkspace,
  type HostProjectListItem,
  useHostProjects,
} from "@/projects/host-projects";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import {
  getLastWorkspaceSelection,
  useLastWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";

export interface NewAgentDefaultsSetting {
  projectMode: "last-used" | "fixed";
  fixedProjectKey?: string | null;
  serverId?: string | null;
  isolation?: "local" | "worktree" | null;
}

export interface NewAgentPrefill {
  id?: string;
  serverId?: string | null;
  workspaceId?: string | null;
  projectKey?: string | null;
  prompt?: string;
}

export interface ResolvedNewAgentDefaults {
  serverId: string | null;
  projectKey: string | null;
  projectName: string | null;
  sourceDirectory: string | null;
  workspaceId: string | null;
  isolation: "local" | "worktree" | null;
  project: HostProjectListItem | null;
}

export interface ResolveNewAgentDefaultsOptions {
  settings?: AppSettings | null;
  allHosts?: HostProfile[];
  projects?: readonly HostProjectListItem[];
  lastWorkspaceSelection?: ActiveWorkspaceSelection | null;
  lastWorkspace?: WorkspaceDescriptor | null;
  prefill?: NewAgentPrefill | null;
}

/**
 * Pure helper to extract the newAgentDefaults setting object from stored/current AppSettings.
 */
export function getNewAgentDefaultsSetting(
  settings: AppSettings | null | undefined,
): NewAgentDefaultsSetting | null {
  if (!settings || typeof settings !== "object" || !("newAgentDefaults" in settings)) {
    return null;
  }
  const raw: unknown = settings.newAgentDefaults;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rawRecord: Record<string, unknown> = raw as Record<string, unknown>;
  const projectMode = rawRecord.projectMode === "fixed" ? "fixed" : "last-used";
  const fixedProjectKey =
    typeof rawRecord.fixedProjectKey === "string" ? rawRecord.fixedProjectKey : null;
  const serverId = typeof rawRecord.serverId === "string" ? rawRecord.serverId : null;
  const isolation =
    rawRecord.isolation === "local" || rawRecord.isolation === "worktree"
      ? rawRecord.isolation
      : null;

  return {
    projectMode,
    fixedProjectKey,
    serverId,
    isolation,
  };
}

/**
 * Synchronously resolve default host, project, directory, and workspace for a new agent.
 *
 * 1. Checks `newAgentDefaults` in settings.
 * 2. If `projectMode === "fixed"` and `fixedProjectKey` is configured, targets that project.
 * 3. Otherwise (or as fallback), targets the last active project and host.
 * 4. Reuses the model default resolution path from workspace creation flow.
 */
// eslint-disable-next-line complexity -- multi-step defaults resolution with fallbacks
export function resolveNewAgentDefaults(
  options?: ResolveNewAgentDefaultsOptions,
): ResolvedNewAgentDefaults {
  const prefill = options?.prefill;
  const settings =
    options?.settings ?? queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ?? null;
  const newAgentDefaults = getNewAgentDefaultsSetting(settings);

  const hosts = options?.allHosts ?? getHostRuntimeStore().getHosts();
  const hostServerIds = new Set(hosts.map((h) => h.serverId));
  const primaryServerId = hosts[0]?.serverId ?? null;

  // Handle explicit prefill first
  const hasExplicitPrefill = Boolean(
    prefill && (prefill.serverId || prefill.projectKey || prefill.workspaceId),
  );
  if (hasExplicitPrefill && prefill) {
    const preferredServerId =
      newAgentDefaults?.serverId && hostServerIds.has(newAgentDefaults.serverId)
        ? newAgentDefaults.serverId
        : primaryServerId;

    const prefillServerId =
      prefill.serverId && hostServerIds.has(prefill.serverId) ? prefill.serverId : null;

    let prefillWorkspace: WorkspaceDescriptor | null = null;
    if (prefillServerId && prefill.workspaceId) {
      prefillWorkspace =
        useSessionStore.getState().sessions[prefillServerId]?.workspaces.get(prefill.workspaceId) ??
        null;
    }

    const prefillProject =
      prefillServerId && prefillWorkspace
        ? hostProjectFromWorkspace({ serverId: prefillServerId, workspace: prefillWorkspace })
        : null;

    const projects = options?.projects ?? [];
    const matchedProject =
      (prefill.projectKey ? projects.find((p) => p.projectKey === prefill.projectKey) : null) ??
      prefillProject;

    let resolvedServerId = prefillServerId;
    if (!resolvedServerId) {
      if (matchedProject) {
        const hasPreferred =
          preferredServerId && matchedProject.hosts.some((h) => h.serverId === preferredServerId);
        resolvedServerId = hasPreferred
          ? preferredServerId
          : (matchedProject.hosts[0]?.serverId ?? primaryServerId);
      } else {
        resolvedServerId = primaryServerId;
      }
    }

    let sourceDir: string | null = null;
    if (prefillWorkspace?.workspaceDirectory) {
      sourceDir = prefillWorkspace.workspaceDirectory;
    } else if (matchedProject && resolvedServerId) {
      sourceDir = getHostProjectSourceDirectory(matchedProject, resolvedServerId);
    }

    return {
      serverId: resolvedServerId,
      projectKey: prefill.projectKey ?? matchedProject?.projectKey ?? null,
      projectName: prefillWorkspace?.projectDisplayName ?? matchedProject?.projectName ?? null,
      sourceDirectory: sourceDir,
      workspaceId: prefill.workspaceId ?? null,
      isolation: newAgentDefaults?.isolation ?? null,
      project: matchedProject,
    };
  }

  // 1. Fixed project preference
  if (newAgentDefaults?.projectMode === "fixed" && newAgentDefaults.fixedProjectKey) {
    const fixedProjectKey = newAgentDefaults.fixedProjectKey;
    const preferredServerId =
      newAgentDefaults.serverId && hostServerIds.has(newAgentDefaults.serverId)
        ? newAgentDefaults.serverId
        : primaryServerId;

    const projects = options?.projects ?? [];
    const matchedProject = projects.find((p) => p.projectKey === fixedProjectKey) ?? null;

    if (matchedProject) {
      const serverId =
        preferredServerId && matchedProject.hosts.some((h) => h.serverId === preferredServerId)
          ? preferredServerId
          : (matchedProject.hosts[0]?.serverId ?? preferredServerId);

      const sourceDirectory = serverId
        ? getHostProjectSourceDirectory(matchedProject, serverId)
        : null;

      return {
        serverId,
        projectKey: fixedProjectKey,
        projectName: matchedProject.projectName,
        sourceDirectory,
        workspaceId: null,
        isolation: newAgentDefaults.isolation ?? null,
        project: matchedProject,
      };
    }
  }

  // 2. Fallback to last active project / host
  const lastSelection = options?.lastWorkspaceSelection ?? getLastWorkspaceSelection();

  const lastServerId =
    lastSelection && hostServerIds.has(lastSelection.serverId) ? lastSelection.serverId : null;

  const lastWorkspaceId = lastServerId ? (lastSelection?.workspaceId ?? null) : null;
  let lastWorkspace: WorkspaceDescriptor | null = null;
  if (options?.lastWorkspace !== undefined) {
    lastWorkspace = options.lastWorkspace;
  } else if (lastServerId && lastWorkspaceId) {
    lastWorkspace =
      useSessionStore.getState().sessions[lastServerId]?.workspaces.get(lastWorkspaceId) ?? null;
  }
  const lastActiveProject =
    lastServerId && lastWorkspace
      ? hostProjectFromWorkspace({ serverId: lastServerId, workspace: lastWorkspace })
      : null;

  if (lastServerId && lastActiveProject) {
    const sourceDirectory =
      lastWorkspace?.workspaceDirectory ||
      getHostProjectSourceDirectory(lastActiveProject, lastServerId);

    return {
      serverId: lastServerId,
      projectKey: lastActiveProject.projectKey,
      projectName: lastActiveProject.projectName,
      sourceDirectory,
      workspaceId: lastWorkspaceId,
      isolation: newAgentDefaults?.isolation ?? null,
      project: lastActiveProject,
    };
  }

  // 3. Fallback to first available host and project
  const projects = options?.projects ?? [];
  const firstProject = projects[0] ?? null;
  const defaultServerId = firstProject?.hosts[0]?.serverId ?? primaryServerId;
  const sourceDirectory =
    firstProject && defaultServerId
      ? getHostProjectSourceDirectory(firstProject, defaultServerId)
      : null;

  return {
    serverId: defaultServerId,
    projectKey: firstProject?.projectKey ?? null,
    projectName: firstProject?.projectName ?? null,
    sourceDirectory,
    workspaceId: null,
    isolation: newAgentDefaults?.isolation ?? null,
    project: firstProject,
  };
}

/**
 * React hook that dynamically resolves new agent defaults and tracks changes
 * in settings, active host, or last-used workspace.
 */
export function useNewAgentDefaults(prefill?: NewAgentPrefill | null): ResolvedNewAgentDefaults {
  const { settings } = useAppSettings();
  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const projects = useHostProjects(allServerIds);
  const lastSelection = useLastWorkspaceSelection();

  const lastServerId = useMemo(
    () =>
      lastSelection && allServerIds.includes(lastSelection.serverId)
        ? lastSelection.serverId
        : null,
    [allServerIds, lastSelection],
  );

  const lastWorkspaceId = lastServerId ? (lastSelection?.workspaceId ?? null) : null;
  const lastWorkspace = useWorkspace(lastServerId, lastWorkspaceId);

  return useMemo(
    () =>
      resolveNewAgentDefaults({
        settings,
        allHosts,
        projects,
        lastWorkspaceSelection: lastSelection,
        lastWorkspace,
        prefill,
      }),
    [allHosts, lastSelection, lastWorkspace, prefill, projects, settings],
  );
}
