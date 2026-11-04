import { useAddHost } from "@/hosts/add-host";
import { router, usePathname } from "expo-router";
import {
  ChartColumn,
  CircleGauge,
  FolderPlus,
  GitBranch,
  LayoutGrid,
  Server,
  Settings,
  SquareKanban,
  Webhook,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, ScrollView as GHScrollView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import {
  resolveDesktopSidebarInsetLeft,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";
import { useWindowLayout, resolveDesktopDivisionLayout } from "@/window-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { HostPicker } from "@/components/hosts/host-picker";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarAgentViewPreferencesMenu } from "@/components/sidebar/agent-view/menu";
import { SidebarViewToggle } from "@/components/sidebar/sidebar-view-toggle";
import { SidebarSearchPanel, SidebarSearchToggle } from "@/components/sidebar/sidebar-search-bar";
import { SidebarAgentViewList } from "@/components/sidebar/agent-view/list";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarFooterIconHighlight } from "@/components/sidebar/sidebar-footer-icon-highlight";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { SidebarProviderUsageMenu } from "@/provider-usage/sidebar-menu";
import { DensityIcon } from "@/components/ui/density-icon";
import { SyncedLoader } from "@/components/synced-loader";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron, isNative as platformIsNative } from "@/constants/platform";
import { useOpenFleetStats } from "@/desktop/fleet-stats";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { density, densityIconSize } from "@/styles/density";
import type { Theme } from "@/styles/theme";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import {
  type SidebarGroupMode,
  type SidebarViewMode,
  useSidebarViewStore,
} from "@/stores/sidebar-view-store";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { useLeftPanelWidth } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import {
  buildItsaplanRoute,
  buildMissionControlRoute,
  buildSettingsRoute,
  buildWebhooksRoute,
} from "@/utils/host-routes";
import { openHostOverview } from "@/navigation/settings-navigation";
import { UsageSidebarItem, UsageSidebarRoot, useUsageSummary, useOpenSidebarUsage } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const busyLoaderMapping = (theme: Theme, rt: { breakpoint?: string }) => ({
  size: densityIconSize(rt, "md"),
  color: theme.colors.foreground,
});

interface SidebarSharedProps {
  theme: SidebarTheme;
  viewMode: SidebarViewMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleImportSession: () => void;
  handleSettings: () => void;
  labels: SidebarLabels;
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  handleViewWebhooks: () => void;
  handleViewItsaplan: () => void;
  handleViewMissionControl: () => void;
  /** Any connected host advertises features.missionControl — gates the row. */
  hasMissionControl: boolean;
}

interface SidebarLabels {
  addProject: string;
  hosts: string;
  settings: string;
  searchHosts: string;
  usage: string;
  itsaplan: string;
  agentGrid: string;
  webhooks: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  active: boolean;
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
  overlay: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({
  active,
  desktopOverlay,
}: {
  active: boolean;
  desktopOverlay: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    hasProjectsBeforeFilter,
    resolvedProjectFilters,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();
  const { open: openImportSession, sheet: importSessionSheet } = useImportSession();

  // Each destination closes the navigation overlay first. Closing is idempotent, so a docked
  // sidebar runs the same handler.
  const handleOpenProject = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettings = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleAddHost = useAddHost();

  const handleOpenHostSettings = useCallback(
    (serverId: string) => {
      showMobileAgent();
      openHostOverview(serverId);
    },
    [showMobileAgent],
  );

  const handleViewWebhooks = useCallback(() => {
    showMobileAgent();
    router.push(buildWebhooksRoute());
  }, [showMobileAgent]);

  const handleViewItsaplan = useCallback(() => {
    showMobileAgent();
    router.push(buildItsaplanRoute());
  }, [showMobileAgent]);

  const handleViewMissionControl = useCallback(() => {
    showMobileAgent();
    // The sidebar entry is the Agent grid; the board stays one toggle away.
    useAgentGridStore.getState().setView("grid");
    router.push(buildMissionControlRoute());
  }, [showMobileAgent]);

  const hosts = useHosts();
  const hostServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const missionControlFeatureMap = useHostFeatureMap(hostServerIds, "missionControl");
  const hostConnectionStatuses = useHostRuntimeConnectionStatuses(hostServerIds);
  const hasMissionControl = useMemo(
    () =>
      hosts.some(
        (host) =>
          hostConnectionStatuses.get(host.serverId) === "online" &&
          missionControlFeatureMap.get(host.serverId) === true,
      ),
    [hostConnectionStatuses, hosts, missionControlFeatureMap],
  );

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      hosts: t("sidebar.actions.hosts"),
      settings: t("sidebar.actions.settings"),
      searchHosts: t("sidebar.host.searchPlaceholder"),
      usage: t(builtinSidebarNavLabelKey("usage")),
      itsaplan: t("sidebar.sections.itsaplan"),
      agentGrid: t("sidebar.sections.agentGrid"),
      webhooks: t("sidebar.sections.webhooks"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const viewMode = useSidebarViewStore((state) => state.viewMode);

  const sharedProps = {
    theme,
    viewMode,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    projects,
    hasProjectsBeforeFilter,
    hasActiveProjectFilter: resolvedProjectFilters.length > 0,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    labels,
    hasMissionControl,
  };

  const handlers = {
    handleOpenProject,
    handleImportSession: openImportSession,
    handleSettings,
    handleAddHost,
    handleOpenHostSettings,
    handleViewWebhooks,
    handleViewItsaplan,
    handleViewMissionControl,
  };

  return (
    <>
      <RetainedPanelActivity active={active}>
        {isCompactLayout ? (
          <MobileSidebar
            {...sharedProps}
            {...handlers}
            active={active}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
          />
        ) : (
          <DesktopSidebar
            {...sharedProps}
            {...handlers}
            insetsTop={insets.top}
            active={active}
            overlay={desktopOverlay}
          />
        )}
      </RetainedPanelActivity>
      {importSessionSheet}
    </>
  );
});

function sidebarHostOptionTestID(serverId: string): string {
  return `sidebar-host-row-${serverId}`;
}

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
  isBusy,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: LucideIcon;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
  /** Swaps the icon for a spinner and swallows presses while an action runs. */
  isBusy?: boolean;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
          disabled={isBusy}
        >
          {({ hovered, pressed }) =>
            isBusy ? (
              <ThemedSyncedLoader uniProps={busyLoaderMapping} />
            ) : (
              <>
                <SidebarFooterIconHighlight visible={pressed} />
                <DensityIcon
                  icon={icon}
                  size="md"
                  sizeAdjustment={iconSizeAdjustment}
                  color={hovered ? "foreground" : "foregroundMuted"}
                />
              </>
            )
          }
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarHostPicker({
  label,
  onAddHost,
  onOpenHostSettings,
}: {
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const hosts = useHosts();
  const triggerRef = useRef<View | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = useCallback(
    (id: string) => {
      onOpenHostSettings(id);
    },
    [onOpenHostSettings],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);

  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      showActiveConnection
      onOpenHostSettings={onOpenHostSettings}
      searchable
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="sidebar-host-add"
      hostOptionTestID={sidebarHostOptionTestID}
    >
      <FooterIconButton
        buttonRef={triggerRef}
        onPress={handleOpen}
        testID="sidebar-hosts-trigger"
        label={label}
        icon={Server}
        // Server's two boxes fill more of the square than the other glyphs.
        iconSizeAdjustment={-1}
      />
    </HostPicker>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

/**
 * Fork-only, Electron-only: collects omp stats across every host and shows the
 * merged dashboard in its own desktop window (docs/omp-fleet-stats.md).
 */
function SidebarFleetStatsButton() {
  const { t } = useTranslation();
  const { open, isOpening } = useOpenFleetStats();

  if (!getIsElectron()) {
    return null;
  }
  return (
    <FooterIconButton
      onPress={open}
      testID="sidebar-fleet-stats"
      label={isOpening ? t("sidebar.fleetStats.collecting") : t("sidebar.fleetStats.label")}
      icon={ChartColumn}
      isBusy={isOpening}
    />
  );
}

function SidebarFooter({
  handleOpenProject,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  onBeforeNavigate,
}: {
  handleOpenProject: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    hosts: string;
    settings: string;
    searchHosts: string;
    usage: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  onBeforeNavigate?: () => void;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");

  // One line of icons: Add project, Usage, Hosts, then Help and Settings at the end.
  return (
    <UsageSidebarRoot>
      <View style={styles.footerContainer} testID="sidebar-footer">
        <SidebarFooterRows onBeforeNavigate={onBeforeNavigate} />
        <View style={styles.sidebarFooter} testID="sidebar-footer-bottom-line">
          <FooterIconButton
            onPress={handleOpenProject}
            testID="sidebar-add-project"
            label={labels.addProject}
            icon={FolderPlus}
            shortcutKeys={newAgentKeys}
          />
          <SidebarUsageIcon label={labels.usage} />
          <SidebarHostPicker
            label={labels.hosts}
            onAddHost={handleAddHost}
            onOpenHostSettings={handleOpenHostSettings}
          />
          <SidebarFleetStatsButton />
          <SidebarProviderUsageMenu />
          <View style={styles.footerSpacer} />
          <SidebarHelpMenu />
          <FooterIconButton
            onPress={handleSettings}
            testID="sidebar-settings"
            label={labels.settings}
            icon={Settings}
            shortcutKeys={settingsKeys}
          />
        </View>
      </View>
    </UsageSidebarRoot>
  );
}

function SidebarUsageIcon({ label }: { label: string }) {
  const openUsage = useOpenSidebarUsage();
  return (
    <FooterIconButton
      onPress={openUsage}
      testID="sidebar-usage-icon"
      label={label}
      icon={CircleGauge}
    />
  );
}

/**
 * The footer rows in the user's `sidebarFooterItems` order: the Usage item and plugin rows. The
 * Usage item is left out while it has no summary to show.
 */
function SidebarFooterRows({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { items } = useSidebarNavItems("footer");
  const usageSummary = useUsageSummary();
  const rowsRef = useRef<View | null>(null);
  const visibleItems = items.filter(
    (item) => item.visible && (item.kind === "plugin" || usageSummary.length > 0),
  );
  if (visibleItems.length === 0) return null;
  return (
    <>
      <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
        {visibleItems.map((item) =>
          item.kind === "plugin" ? (
            <PluginSidebarItem
              key={item.key}
              group={item.group}
              section="footer"
              fallbackAnchorRef={rowsRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          ) : (
            <UsageSidebarItem key={item.key} sources={usageSummary} />
          ),
        )}
      </View>
      <SidebarSeparator testID="sidebar-footer-separator" />
    </>
  );
}

function MobileSidebar({
  active,
  viewMode,
  theme,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  insetsBottom,
  closeSidebar,
  hasMissionControl,
  handleViewWebhooks,
  handleViewItsaplan,
  handleViewMissionControl,
}: MobileSidebarProps) {
  const insets = useSafeAreaInsets();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const showWorkspaceSkeleton = isInitialLoad && !hasActiveHostFilter;
  const pathname = usePathname();
  const isWebhooksActive = pathname.includes("/webhooks");
  const isItsaplanActive = pathname.includes("/itsaplan");
  const isMissionControlActive = pathname.includes("/mission-control");
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const closeButton = useMemo(
    () => (
      <SidebarCloseButton
        label={labels.closeSidebar}
        onPress={closeSidebar}
        testID="sidebar-close"
        nativeID="sidebar-close"
        style={styles.mobileCloseButton(insets.right)}
      />
    ),
    [labels.closeSidebar, closeSidebar, insets.right],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  const navRows = (
    <>
      <SidebarNavRows
        style={styles.mobileNavRowsGroup}
        onBeforeNavigate={closeSidebar}
        firstRowTrailing={closeButton}
      />
      <SidebarSeparator />
      <View style={styles.mobileNavRowsGroup}>
        <SidebarHeaderRow
          icon={SquareKanban}
          label={labels.itsaplan}
          onPress={handleViewItsaplan}
          isActive={isItsaplanActive}
          testID="sidebar-itsaplan"
          variant="compact"
        />
        {hasMissionControl ? (
          <SidebarHeaderRow
            icon={LayoutGrid}
            label={labels.agentGrid}
            onPress={handleViewMissionControl}
            isActive={isMissionControlActive}
            testID="sidebar-mission-control"
            variant="compact"
          />
        ) : null}
        <SidebarHeaderRow
          icon={Webhook}
          label={labels.webhooks}
          onPress={handleViewWebhooks}
          isActive={isWebhooksActive}
          testID="sidebar-webhooks"
          variant="compact"
        />
      </View>
    </>
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        {platformIsNative ? (
          <GHScrollView
            // Same contract as the workspace list: vertical drags scroll the nav
            // block, a clear horizontal intent still activates the close pan.
            simultaneousHandlers={closeGestureRef}
            style={styles.mobileNavScroll}
            showsVerticalScrollIndicator={false}
            alwaysBounceVertical={false}
            testID="sidebar-nav-scroll"
          >
            {navRows}
          </GHScrollView>
        ) : (
          <ScrollView
            style={styles.mobileNavScroll}
            showsVerticalScrollIndicator={false}
            alwaysBounceVertical={false}
            testID="sidebar-nav-scroll"
          >
            {navRows}
          </ScrollView>
        )}
        <SidebarSeparator />

        {viewMode === "agents" ? (
          <SidebarAgentViewList
            active={active}
            listHeaderComponent={sidebarSectionHeaderElement}
            onAgentPress={handleWorkspacePress}
            parentGestureRef={closeGestureRef}
          />
        ) : null}
        {viewMode === "workspaces" && showWorkspaceSkeleton ? (
          <View style={styles.sidebarContent}>
            <ScrollView
              style={styles.sidebarContent}
              contentContainerStyle={styles.workspaceSkeletonContent}
              showsVerticalScrollIndicator={false}
            >
              {sidebarSectionHeaderElement}
              <SidebarAgentListSkeleton />
            </ScrollView>
          </View>
        ) : null}
        {viewMode === "workspaces" && !showWorkspaceSkeleton ? (
          <SidebarWorkspaceList
            collapsedProjectKeys={collapsedProjectKeys}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
            groupMode={groupMode}
            workspaceGroups={workspaceGroups}
            projectIconTargets={projectIconTargets}
            pinnedGroups={pinnedGroups}
            projects={projects}
            hasProjectsBeforeFilter={hasProjectsBeforeFilter}
            hasActiveProjectFilter={hasActiveProjectFilter}
            workspaceEntriesByKey={workspaceEntriesByKey}
            isRefreshing={isManualRefresh && isRevalidating}
            onRefresh={handleRefresh}
            onWorkspacePress={handleWorkspacePress}
            onAddProject={handleOpenProject}
            onImportSession={handleImportSession}
            parentGestureRef={closeGestureRef}
            dragGestureHostActive={active}
            listHeaderComponent={sidebarSectionHeaderElement}
          />
        ) : null}

        <SidebarFooter
          handleOpenProject={handleOpenProject}
          handleSettings={handleSettings}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
          onBeforeNavigate={closeSidebar}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({
  theme,
  viewMode,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  active,
  overlay,
  hasMissionControl,
  handleViewWebhooks,
  handleViewItsaplan,
  handleViewMissionControl,
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const showWorkspaceSkeleton = isInitialLoad && !hasActiveHostFilter;
  const pathname = usePathname();
  const isWebhooksActive = pathname.includes("/webhooks");
  const isItsaplanActive = pathname.includes("/itsaplan");
  const isMissionControlActive = pathname.includes("/mission-control");
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;
  const divisionLayout = resolveDesktopDivisionLayout({
    geometry: useWindowLayout(),
    windowWidth,
    windowHeight,
    leftInset: insets.left,
    rightInset: insets.right,
  });
  const visibleSidebarWidth = useLeftPanelWidth();

  const closeSidebar = usePanelStore((state) => state.showMobileAgent);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture(overlay);

  const startWidth = useSharedValue(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(divisionLayout === null)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidth.value = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidth.value + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd((_event, success) => {
          if (success) runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      divisionLayout,
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      startWidth,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: divisionLayout?.sidebarWidth ?? resizeWidth.value,
  }));
  // The panel host gets no width of its own: the dock sizes to this view and the overlay fills the
  // window. A Reanimated width on the host reached Android after React had switched presentation,
  // and a lost update left the workspace at the dock width after the dock collapsed.
  const desktopSidebarStyle = useMemo(
    () => [staticStyles.desktopSidebar, resizeAnimatedStyle],
    [resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [
      styles.desktopSidebarBorder(divisionLayout !== null),
      {
        flex: 1,
        paddingTop: insetsTop,
        paddingBottom: insets.bottom,
        paddingLeft: resolveDesktopSidebarInsetLeft({ overlay, safeAreaLeft: insets.left }),
      },
    ],
    [insetsTop, insets.bottom, insets.left, overlay, divisionLayout],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  return (
    <MobilePanelOverlay
      panel="agent-list"
      presentation={overlay ? "overlay" : "dock"}
      dockVisible={active}
      closeGesture={closeGesture}
    >
      <Animated.View style={desktopSidebarStyle}>
        <View style={desktopSidebarBorderStyle}>
          <View style={styles.sidebarDragArea}>
            {ownsTopLeft || DEV_BUILD_LABEL ? (
              <View style={styles.desktopChromeRow}>
                <TitlebarDragRegion />
                {DEV_BUILD_LABEL ? (
                  <View
                    pointerEvents="none"
                    style={styles.devBuildBadge}
                    testID="dev-build-label"
                    accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
                  >
                    <GitBranch size={12} color={theme.colors.accentForeground} />
                    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                      {DEV_BUILD_LABEL}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <TitlebarDragRegion />
            )}
            <SidebarNavRows style={sidebarHeaderGroupStyle} onBeforeNavigate={closeSidebar} />
            <View style={styles.sidebarHeaderGroup}>
              <SidebarHeaderRow
                icon={SquareKanban}
                label={labels.itsaplan}
                onPress={handleViewItsaplan}
                isActive={isItsaplanActive}
                testID="sidebar-itsaplan"
                variant="compact"
              />
              {hasMissionControl ? (
                <SidebarHeaderRow
                  icon={LayoutGrid}
                  label={labels.agentGrid}
                  onPress={handleViewMissionControl}
                  isActive={isMissionControlActive}
                  testID="sidebar-mission-control"
                  variant="compact"
                />
              ) : null}
              <SidebarHeaderRow
                icon={Webhook}
                label={labels.webhooks}
                onPress={handleViewWebhooks}
                isActive={isWebhooksActive}
                testID="sidebar-webhooks"
                variant="compact"
              />
            </View>
          </View>

          {viewMode === "agents" ? (
            <SidebarAgentViewList
              active={active}
              listHeaderComponent={sidebarSectionHeaderElement}
              onAgentPress={closeSidebar}
              parentGestureRef={closeGestureRef}
            />
          ) : null}
          {viewMode === "workspaces" && showWorkspaceSkeleton ? (
            <View style={styles.sidebarContent}>
              <ScrollView
                style={styles.sidebarContent}
                contentContainerStyle={styles.workspaceSkeletonContent}
                showsVerticalScrollIndicator={false}
              >
                {sidebarSectionHeaderElement}
                <SidebarAgentListSkeleton />
              </ScrollView>
            </View>
          ) : null}
          {viewMode === "workspaces" && !showWorkspaceSkeleton ? (
            <SidebarWorkspaceList
              collapsedProjectKeys={collapsedProjectKeys}
              onToggleProjectCollapsed={toggleProjectCollapsed}
              shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
              groupMode={groupMode}
              workspaceGroups={workspaceGroups}
              projectIconTargets={projectIconTargets}
              pinnedGroups={pinnedGroups}
              projects={projects}
              hasProjectsBeforeFilter={hasProjectsBeforeFilter}
              hasActiveProjectFilter={hasActiveProjectFilter}
              workspaceEntriesByKey={workspaceEntriesByKey}
              isRefreshing={isManualRefresh && isRevalidating}
              onRefresh={handleRefresh}
              onAddProject={handleOpenProject}
              onImportSession={handleImportSession}
              onWorkspacePress={closeSidebar}
              parentGestureRef={closeGestureRef}
              dragGestureHostActive={active}
              listHeaderComponent={sidebarSectionHeaderElement}
            />
          ) : null}

          <SidebarCalloutSlot />

          <SidebarFooter
            handleOpenProject={handleOpenProject}
            handleSettings={handleSettings}
            labels={labels}
            handleAddHost={handleAddHost}
            handleOpenHostSettings={handleOpenHostSettings}
            onBeforeNavigate={closeSidebar}
          />

          {!overlay && divisionLayout === null ? (
            <SidebarResizeHandle
              edge="right"
              gesture={resizeGesture}
              pressed={resizePressed}
              testID="left-sidebar-resize-handle"
            />
          ) : null}
        </View>
      </Animated.View>
    </MobilePanelOverlay>
  );
}

function SidebarListHeader() {
  const { t } = useTranslation();
  const viewMode = useSidebarViewStore((state) => state.viewMode);
  const isAgentView = viewMode === "agents";

  return (
    <View>
      <SidebarSectionHeader title={isAgentView ? t("sidebar.agentView.title") : "Workspaces"}>
        <SidebarSearchToggle />
        <SidebarViewToggle />
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <View>
              {isAgentView ? (
                <SidebarAgentViewPreferencesMenu />
              ) : (
                <SidebarDisplayPreferencesMenu />
              )}
            </View>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <IconTooltipContent
              label={isAgentView ? t("sidebar.agentView.display.trigger") : "Display preferences"}
            />
          </TooltipContent>
        </Tooltip>
      </SidebarSectionHeader>
      <SidebarSearchPanel />
    </View>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (SidebarListHeader takes no props).
const sidebarSectionHeaderElement = <SidebarListHeader />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
    flex: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.sidebarDivider,
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  // The nav block caps at half the sidebar; a long item list scrolls inside the
  // cap instead of crowding the workspace list off a short screen.
  mobileNavScroll: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: "50%",
  },
  mobileNavRowsGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  workspaceSkeletonContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  mobileCloseButton: (rightInset: number) => ({
    marginRight: theme.spacing[2] + rightInset,
  }),
  desktopSidebarBorder: (hasDivision: boolean) => ({
    borderRightWidth: hasDivision ? 0 : 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  }),
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.sidebarDivider,
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  // Pushes Help and Settings to the end of the icon line.
  footerSpacer: {
    flex: 1,
  },
  // Usage and plugin rows sit above the footer's icon line, spaced like the header nav rows.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
