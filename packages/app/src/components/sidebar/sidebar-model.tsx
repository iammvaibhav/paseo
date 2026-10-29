import { useTranslation } from "react-i18next";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  buildSidebarProjectsFromHostProjects,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useHosts } from "@/runtime/host-runtime";
import { useWorkspaceDirectoryServerIds } from "@/stores/session-store-hooks";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import { useHostProjects } from "@/projects/host-projects";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import {
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";
import { matchesAgentSearchWords } from "@getpaseo/protocol/agent-search";
import { useSidebarSearch, type SidebarSearch } from "./sidebar-search";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /**
   * Every project across all hosts, unconstrained by workspace host filter.
   * Sourced from structure for already-loaded hosts without acquiring new directory demand.
   */
  allHostProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  hasProjectsBeforeFilter: boolean;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
  /** The search bar's matches; `active` false while the query is blank. */
  search: SidebarSearch;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);

export function SidebarModelProvider({
  active,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const list = useSidebarWorkspacesList({ enabled: active });
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const storeHostFilters = useSidebarViewStore((state) => state.hostFilters);
  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const allDirectoryServerIds = useWorkspaceDirectoryServerIds(allServerIds);
  const [missionControlVerbose] = useMissionControlVerbose();
  const allHostProjectsData = useHostProjects(allDirectoryServerIds, {
    hideSystemOwnedWorkspaces: !missionControlVerbose,
  });
  const allHostProjects = useMemo(() => {
    if (storeHostFilters.length === 0) {
      return list.projects;
    }
    return buildSidebarProjectsFromHostProjects({ projects: allHostProjectsData });
  }, [allHostProjectsData, list.projects, storeHostFilters.length]);
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const search = useSidebarSearch();
  // A collapsed project would hide its matches.
  const effectiveCollapsedProjectKeys = useMemo(
    () => (search.active ? new Set<string>() : collapsedProjectKeys),
    [collapsedProjectKeys, search.active],
  );
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(list.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, list.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter || search.active;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false || needsWorkspaceEntries,
  );
  // Search narrows to workspaces holding a matching agent or whose own name or title matches.
  const searchWorkspaceKeys = useMemo(() => {
    if (!search.active) return null;
    const keys = new Set(search.workspaceKeys);
    for (const workspace of list.workspacePlacements) {
      const title = workspaceEntriesByKey.get(workspace.workspaceKey)?.title;
      if (matchesAgentSearchWords(search.words, [workspace.name, title])) {
        keys.add(workspace.workspaceKey);
      }
    }
    return keys;
  }, [list.workspacePlacements, search, workspaceEntriesByKey]);
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...workspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const byLabel = filterWorkspacesByLabels({
      workspaces: byProject.filter((workspace) => showBackground || !workspace.background),
      ...labelFilter,
    });
    const filtered = searchWorkspaceKeys
      ? byLabel.filter((workspace) => searchWorkspaceKeys.has(workspace.workspaceKey))
      : byLabel;
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [
    showBackground,
    labelFilter,
    resolvedProjectFilters,
    searchWorkspaceKeys,
    workspaceEntriesByKey,
  ]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = list.projects;
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (hasActiveLabelFilter || !showBackground) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 || (!hasActiveLabelFilter && project.workspaces.length === 0)
          ? [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }]
          : [];
      });
    }
    if (searchWorkspaceKeys) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          searchWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 ? [{ ...project, workspaces }] : [];
      });
    }
    return projects;
  }, [
    showBackground,
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    resolvedProjectFilters,
    list.projects,
    searchWorkspaceKeys,
    visibleWorkspaceKeys,
  ]);
  const pinnedKeys = usePinnedSidebarKeys(filteredProjects);
  const projectionInput = useMemo(
    () => ({
      projects: filteredProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey: list.projectNamesByViewKey,
      groupMode,
      pinnedCollapsed,
      collapsedProjectKeys: effectiveCollapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      t,
    }),
    [
      effectiveCollapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      groupMode,
      list.projectNamesByViewKey,
      filteredProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      projects: filteredProjects,
      allProjects: list.projects,
      allHostProjects,
      resolvedProjectFilters,
      hasProjectsBeforeFilter: list.projects.length > 0,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys: effectiveCollapsedProjectKeys,
      toggleProjectCollapsed,
      search,
      shortcutModel: projection.shortcutModel,
    }),
    [
      resolvedProjectFilters,
      effectiveCollapsedProjectKeys,
      search,
      groupMode,
      list,
      filteredProjects,
      projection,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
      allHostProjects,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
