import { useCallback, useEffect, useMemo } from "react";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { resolveActiveProjectFilters } from "@/components/sidebar/sidebar-project-filter";
import type { LifecycleRow } from "@/mission-control/lifecycle";
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

  const { allHostProjects, search } = useSidebarModel();

  // Every unarchived agent is a candidate: Done agents list at any age, like Ready, and closed
  // (dormant) agents reach the view when pinned or matched by a search. The model drops the rest.
  const { groups, isInitialLoad } = useMissionControlLifecycle({
    enabled,
    showAll: true,
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
  const pinnedAgentOrder = useSidebarAgentViewStore((state) => state.pinnedAgentOrder);
  const clearHostFilters = useSidebarAgentViewStore((state) => state.clearHostFilters);
  const clearProjectFilters = useSidebarAgentViewStore((state) => state.clearProjectFilters);

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
        pinnedAgentOrder,
        search: search.active ? search : null,
      }),
    [
      groups,
      hostFilters,
      resolvedProjectFilters,
      projectViewKeyByWorkspaceKey,
      pinnedAgentOrder,
      search,
    ],
  );

  return {
    sections,
    isInitialLoad,
    hasActiveFilter,
    clearFilters,
  };
}

const NO_PINNED_ROWS: LifecycleRow[] = [];

/** The agent view's Pinned rows, for views that show pinned agents above their own list. */
export function useSidebarPinnedAgentRows(options: { enabled: boolean }): LifecycleRow[] {
  const { sections } = useSidebarAgentView(options);
  return sections.find((section) => section.key === "pinned")?.rows ?? NO_PINNED_ROWS;
}
