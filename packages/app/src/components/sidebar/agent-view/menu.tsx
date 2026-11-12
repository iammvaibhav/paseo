import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PressableStateCallbackType } from "react-native";
import { Settings2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import {
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuSubTrigger,
  MenuSurface,
  MenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { resolveActiveProjectFilters } from "@/components/sidebar/sidebar-project-filter";
import { useSidebarAgentViewStore } from "@/stores/sidebar-agent-view-store";
import {
  HostFilterPage,
  ProjectFilterPage,
  menuTriggerStyles,
  MENU_WIDTH,
} from "@/components/sidebar/display-preferences/filter-pages";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedSettings2 = withUnistyles(Settings2);

export function SidebarAgentViewPreferencesMenu(): ReactElement {
  const { t } = useTranslation();
  const hostFilters = useSidebarAgentViewStore((state) => state.hostFilters);
  const projectFilters = useSidebarAgentViewStore((state) => state.projectFilters);
  const showDone = useSidebarAgentViewStore((state) => state.showDone);
  const toggleHostFilter = useSidebarAgentViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarAgentViewStore((state) => state.clearHostFilters);
  const toggleProjectFilter = useSidebarAgentViewStore((state) => state.toggleProjectFilter);
  const clearProjectFilters = useSidebarAgentViewStore((state) => state.clearProjectFilters);
  const setShowDone = useSidebarAgentViewStore((state) => state.setShowDone);

  const hosts = useHosts();
  const { allHostProjects } = useSidebarModel();

  const availableViewKeys = useMemo(
    () => new Set(allHostProjects.map((project) => project.viewKey)),
    [allHostProjects],
  );

  const resolvedProjectFilters = useMemo(
    () => resolveActiveProjectFilters(projectFilters, availableViewKeys),
    [projectFilters, availableViewKeys],
  );

  const showHostFilter = hosts.length > 1;
  const showProjectFilter = allHostProjects.length > 1;

  const pages = useMemo<MenuPageDefinition[]>(() => {
    const definitions: MenuPageDefinition[] = [];

    if (showHostFilter) {
      definitions.push({
        id: "hostFilter",
        title: t("sidebar.display.hostFilter.label"),
        content: (
          <HostFilterPage
            hosts={hosts}
            hostFilters={hostFilters}
            onToggleHost={toggleHostFilter}
            onClearHosts={clearHostFilters}
            testIDPrefix="sidebar-agent-view-host-filter"
          />
        ),
      });
    }

    if (showProjectFilter) {
      definitions.push({
        id: "projectFilter",
        title: t("sidebar.display.projectFilter.label"),
        content: (
          <ProjectFilterPage
            projects={allHostProjects}
            resolvedProjectFilters={resolvedProjectFilters}
            onToggleProject={toggleProjectFilter}
            onClearProjects={clearProjectFilters}
            testIDPrefix="sidebar-agent-view-project-filter"
          />
        ),
      });
    }

    return definitions;
  }, [
    showHostFilter,
    showProjectFilter,
    t,
    hosts,
    hostFilters,
    toggleHostFilter,
    clearHostFilters,
    allHostProjects,
    resolvedProjectFilters,
    toggleProjectFilter,
    clearProjectFilters,
  ]);

  const handleToggleShowDone = useCallback(() => {
    setShowDone(!showDone);
  }, [setShowDone, showDone]);

  const triggerStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      menuTriggerStyles.trigger,
      hovered && menuTriggerStyles.triggerHovered,
    ],
    [],
  );

  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.agentView.display.trigger")}
        testID="sidebar-agent-view-preferences-menu"
      >
        <ThemedSettings2 size={14} uniProps={mutedIconMapping} />
      </MenuTrigger>
      <MenuSurface
        align="end"
        width={MENU_WIDTH}
        pages={pages}
        sheetTitle={t("sidebar.agentView.display.heading")}
        testID="sidebar-agent-view-preferences-content"
      >
        <MenuItem
          selected={showDone}
          closeOnSelect={false}
          onSelect={handleToggleShowDone}
          testID="sidebar-agent-view-show-done"
        >
          {t("sidebar.agentView.display.showDone")}
        </MenuItem>
        {showHostFilter || showProjectFilter ? <MenuSeparator /> : null}
        {showHostFilter ? (
          <MenuSubTrigger
            id="hostFilter"
            indicator={hostFilters.length > 0}
            testID="sidebar-agent-view-host-filter"
          >
            {t("sidebar.display.hostFilter.label")}
          </MenuSubTrigger>
        ) : null}
        {showProjectFilter ? (
          <MenuSubTrigger
            id="projectFilter"
            indicator={resolvedProjectFilters.length > 0}
            testID="sidebar-agent-view-project-filter"
          >
            {t("sidebar.display.projectFilter.label")}
          </MenuSubTrigger>
        ) : null}
      </MenuSurface>
    </MenuRoot>
  );
}
