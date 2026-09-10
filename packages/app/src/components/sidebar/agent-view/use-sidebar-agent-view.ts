import { useCallback, useEffect, useMemo } from "react";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { resolveActiveProjectFilters } from "@/components/sidebar/sidebar-project-filter";
import { useMissionControlLifecycle } from "@/mission-control/use-mission-control-lifecycle";
import { useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useSidebarAgentViewStore } from "@/stores/sidebar-agent-view-store";
import {
  agentWorkspaceKey,
  buildSidebarAgentViewSections,
  type SidebarAgentViewSection,
} from "./model";

export interface SidebarAgentViewModel {
  sections: SidebarAgentViewSection[];
  isInitialLoad: boolean;
  hasActiveFilter: boolean;
  clearFilters: () => void;
}

export function useSidebarAgentView(options: { enabled: boolean }): SidebarAgentViewModel {
  const { enabled } = options;

  const { groups, isInitialLoad } = useMissionControlLifecycle({
    enabled,
  });

  const allHosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const allServerIds = useMemo(() => allHosts.map((host) => host.serverId), [allHosts]);

  const reconcileHostFilters = useSidebarAgentViewStore((state) => state.reconcileHostFilters);

  useEffect(() => {
    if (!hostRegistryLoaded) {
      return;
    }
    reconcileHostFilters(allServerIds);
  }, [allServerIds, hostRegistryLoaded, reconcileHostFilters]);

  const hostFilters = useSidebarAgentViewStore((state) => state.hostFilters);
  const projectFilters = useSidebarAgentViewStore((state) => state.projectFilters);
  const showDone = useSidebarAgentViewStore((state) => state.showDone);
  const clearHostFilters = useSidebarAgentViewStore((state) => state.clearHostFilters);
  const clearProjectFilters = useSidebarAgentViewStore((state) => state.clearProjectFilters);

  const { allHostProjects } = useSidebarModel();

  const projectViewKeyByWorkspaceKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of allHostProjects) {
      for (const workspace of project.workspaces) {
        map.set(agentWorkspaceKey(workspace.serverId, workspace.workspaceId), project.viewKey);
      }
    }
    return map;
  }, [allHostProjects]);

  const availableViewKeys = useMemo(
    () => new Set(allHostProjects.map((project) => project.viewKey)),
    [allHostProjects],
  );

  const resolvedProjectFilters = useMemo(
    () => resolveActiveProjectFilters(projectFilters, availableViewKeys),
    [projectFilters, availableViewKeys],
  );

  const hasActiveFilter = hostFilters.length > 0 || resolvedProjectFilters.length > 0;

  const clearFilters = useCallback(() => {
    clearHostFilters();
    clearProjectFilters();
  }, [clearHostFilters, clearProjectFilters]);

  const sections = useMemo(
    () =>
      buildSidebarAgentViewSections({
        groups,
        hostFilters,
        projectFilters: resolvedProjectFilters,
        projectViewKeyByWorkspaceKey,
        showDone,
      }),
    [groups, hostFilters, resolvedProjectFilters, projectViewKeyByWorkspaceKey, showDone],
  );

  return {
    sections,
    isInitialLoad,
    hasActiveFilter,
    clearFilters,
  };
}
