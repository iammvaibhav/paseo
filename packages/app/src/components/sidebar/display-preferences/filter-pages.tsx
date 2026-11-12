import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MenuItem } from "@/components/ui/menu";
import { HostGlyph } from "@/components/host-glyph";
import { ProjectIconView } from "@/components/project-icon-view";
import { useProjectIcons } from "@/projects/icons";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export const MENU_WIDTH = 232;

/** Fits the item's 16pt leading slot with a hair of room, matching the trailing check. */
const OPTION_ICON_SIZE = 14;

export const menuTriggerStyles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
}));

export function HostFilterPage({
  hosts,
  hostFilters,
  onToggleHost,
  onClearHosts,
  testIDPrefix,
}: {
  hosts: readonly { serverId: string; label: string }[];
  hostFilters: readonly string[];
  onToggleHost: (serverId: string) => void;
  onClearHosts: () => void;
  testIDPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <MenuItem
        selected={hostFilters.length === 0}
        closeOnSelect={false}
        onSelect={onClearHosts}
        testID={`${testIDPrefix}-all`}
      >
        {t("sidebar.display.hostFilter.all")}
      </MenuItem>
      {hosts.map((host) => (
        <HostFilterItem
          key={host.serverId}
          serverId={host.serverId}
          label={host.label?.trim() || host.serverId}
          selected={hostFilters.includes(host.serverId)}
          onToggle={onToggleHost}
          testIDPrefix={testIDPrefix}
        />
      ))}
    </>
  );
}

/** The one option row whose mark is live state rather than an icon. */
export function HostFilterItem({
  serverId,
  label,
  selected,
  onToggle,
  testIDPrefix,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  onToggle: (serverId: string) => void;
  testIDPrefix: string;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(serverId), [onToggle, serverId]);
  const leading = useMemo(
    () => (
      <View testID={`${testIDPrefix}-status-${serverId}`}>
        <HostGlyph serverId={serverId} label={label} size={14} />
      </View>
    ),
    [label, serverId, testIDPrefix],
  );

  return (
    <MenuItem
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
      testID={`${testIDPrefix}-${serverId}`}
    >
      {label}
    </MenuItem>
  );
}

/**
 * Every project the sidebar could show, one row each.
 *
 * A workspace belongs to exactly one project, so this is a plain allowlist — the same shape as the
 * host page, and deliberately not the label page's tri-state.
 *
 * Selection reads `resolvedProjectFilters`, not the stored list. A stored key whose project is not
 * currently visible filters nothing, so showing it as checked here would contradict the sidebar.
 */
export function ProjectFilterPage({
  projects,
  resolvedProjectFilters,
  onToggleProject,
  onClearProjects,
  testIDPrefix,
}: {
  projects: readonly SidebarProjectEntry[];
  resolvedProjectFilters: readonly string[];
  onToggleProject: (viewKey: string) => void;
  onClearProjects: () => void;
  testIDPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  const iconTargets = useMemo(() => resolveSidebarProjectIconTargets(projects), [projects]);
  // Shares TanStack's cache with the sidebar's own call, so this subscribes rather than refetches.
  const iconByProjectViewKey = useProjectIcons({ projects: iconTargets });

  return (
    <>
      <MenuItem
        selected={resolvedProjectFilters.length === 0}
        closeOnSelect={false}
        onSelect={onClearProjects}
        testID={`${testIDPrefix}-all`}
      >
        {t("sidebar.display.projectFilter.all")}
      </MenuItem>
      {projects.map((project) => (
        <ProjectFilterItem
          key={project.viewKey}
          viewKey={project.viewKey}
          label={project.projectName}
          iconDataUri={iconByProjectViewKey.get(project.viewKey) ?? null}
          selected={resolvedProjectFilters.includes(project.viewKey)}
          onToggle={onToggleProject}
          testIDPrefix={testIDPrefix}
        />
      ))}
    </>
  );
}

export function ProjectFilterItem({
  viewKey,
  label,
  iconDataUri,
  selected,
  onToggle,
  testIDPrefix,
}: {
  viewKey: string;
  label: string;
  iconDataUri: string | null;
  selected: boolean;
  onToggle: (viewKey: string) => void;
  testIDPrefix: string;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(viewKey), [viewKey, onToggle]);
  const leading = useMemo(
    () => (
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={projectIconPlaceholderLabelFromDisplayName(label).charAt(0).toUpperCase()}
        projectViewKey={viewKey}
        size={OPTION_ICON_SIZE}
        textStyle={styles.projectIconText}
      />
    ),
    [iconDataUri, label, viewKey],
  );

  return (
    <MenuItem
      selected={selected}
      leading={leading}
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={`${testIDPrefix}-${viewKey}`}
    >
      {label}
    </MenuItem>
  );
}

const styles = StyleSheet.create({
  // The icon sits in a 14pt menu slot, so the fallback initial is sized down to match rather
  // than reusing the sidebar row's 16pt figure.
  projectIconText: {
    fontSize: 8,
  },
});
