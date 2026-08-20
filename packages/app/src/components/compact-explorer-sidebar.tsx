import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HardDrive, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatPrTabLabel, PullRequestTabIcon } from "@/git/pull-request-panel";
import type { Forge } from "@/git/forge";
import {
  usePanelStore,
  selectIsCompactFileExplorerOpen,
  type ExplorerTab,
} from "@/stores/panel-store";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import { GitDiffPane } from "@/git/diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { shouldUseCompactExplorerKeyboardPadding } from "@/hooks/keyboard-shift-policy";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanel, RetainedPanelActivity } from "@/components/retained-panel";
import { getIsElectron } from "@/constants/platform";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { useSubmoduleContext } from "@/git/submodule-context";
import { SubmodulePicker } from "@/git/submodule-picker";
import { usePullRequestPanelAvailability } from "@/panels/pull-request-availability";
import { PullRequestContent } from "@/panels/pull-request";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";

function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface ExplorerSidebarProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  onOpenFile?: (filePath: string) => void;
  /** Fork-only: opens the file's git diff in VS Code Web (desktop only). */
  onOpenDiff?: (filePath: string, baseRef: string | null) => void;
  onOpenHostFile?: (filePath: string) => void;
}

interface ExplorerSidebarSharedState {
  explorerTab: ExplorerTab;
  handleTabPress: (tab: ExplorerTab) => void;
}

function useExplorerSidebarSharedState({
  serverId,
  workspaceRoot,
  isGit,
}: Pick<ExplorerSidebarProps, "serverId" | "workspaceRoot" | "isGit">): ExplorerSidebarSharedState {
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleTabPress = useCallback(
    (tab: ExplorerTab) => {
      setExplorerTabForCheckout({ serverId, cwd: workspaceRoot, isGit, tab });
    },
    [isGit, serverId, setExplorerTabForCheckout, workspaceRoot],
  );

  return { explorerTab, handleTabPress };
}

export function CompactExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
  onOpenDiff,
  onOpenHostFile,
}: ExplorerSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const usePanelKeyboardPadding = shouldUseCompactExplorerKeyboardPadding({ isGit, explorerTab });
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: usePanelKeyboardPadding,
  });
  const { gesture: closeGesture } = useCloseFileExplorerGesture();

  const handleClose = useCallback(
    (reason: string) => {
      logExplorerSidebar("handleClose", {
        reason,
        isOpen,
      });
      showMobileAgent();
    },
    [isOpen, showMobileAgent],
  );

  const handleHeaderClose = useCallback(() => handleClose("header-close-button"), [handleClose]);

  const mobileSidebarStyle = useMemo(
    () => [
      {
        paddingTop: insets.top + HEADER_TOP_PADDING_MOBILE,
        paddingBottom: usePanelKeyboardPadding ? 0 : insets.bottom,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      mobileKeyboardInsetStyle,
    ],
    [
      insets.bottom,
      insets.top,
      mobileKeyboardInsetStyle,
      theme.colors.surfaceSidebar,
      usePanelKeyboardPadding,
    ],
  );

  return (
    <RetainedPanelActivity active={isOpen}>
      <MobilePanelOverlay
        panel="file-explorer"
        closeGesture={closeGesture}
        panelStyle={mobileSidebarStyle}
      >
        <ExplorerSidebarContent
          activeTab={explorerTab}
          onTabPress={handleTabPress}
          onClose={handleHeaderClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isOpen={isOpen}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onOpenHostFile={onOpenHostFile}
        />
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
}

interface ExplorerTabButtonProps {
  tab: ExplorerTab;
  active: boolean;
  label?: string;
  onTabPress: (tab: ExplorerTab) => void;
  testID: string;
  children?: React.ReactNode;
}

function ExplorerTabButton({
  tab,
  active,
  label,
  onTabPress,
  testID,
  children,
}: ExplorerTabButtonProps) {
  const handlePress = useCallback(() => onTabPress(tab), [onTabPress, tab]);
  const tabStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const tabTextStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);
  return (
    <Pressable testID={testID} style={tabStyle} onPress={handlePress}>
      {children}
      {label !== undefined ? <Text style={tabTextStyle}>{label}</Text> : null}
    </Pressable>
  );
}

function HostExplorerTabButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const tabStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const tabTextStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);

  return (
    <Pressable
      testID="explorer-tab-host"
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      style={tabStyle}
      onPress={onPress}
    >
      <HardDrive
        size={13}
        color={active ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <Text style={tabTextStyle}>{label}</Text>
    </Pressable>
  );
}

function ExplorerTabs({
  resolvedTab,
  isGit,
  showPrTab,
  showHostFiles,
  hostEnabled,
  changesLabel,
  filesLabel,
  hostLabel,
  prTabLabel,
  forge,
  onTabPress,
  onHostPress,
}: {
  resolvedTab: ExplorerTab;
  isGit: boolean;
  showPrTab: boolean;
  showHostFiles: boolean;
  hostEnabled: boolean;
  changesLabel: string;
  filesLabel: string;
  hostLabel: string;
  prTabLabel: string;
  forge: Forge;
  onTabPress: (tab: ExplorerTab) => void;
  onHostPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.tabsContainer}>
      {isGit && (
        <ExplorerTabButton
          tab="changes"
          active={!showHostFiles && resolvedTab === "changes"}
          label={changesLabel}
          onTabPress={onTabPress}
          testID="explorer-tab-changes"
        />
      )}
      <ExplorerTabButton
        tab="files"
        active={!showHostFiles && resolvedTab === "files"}
        label={filesLabel}
        onTabPress={onTabPress}
        testID="explorer-tab-files"
      />
      {hostEnabled ? (
        <HostExplorerTabButton active={showHostFiles} label={hostLabel} onPress={onHostPress} />
      ) : null}
      {isGit && showPrTab && (
        <ExplorerTabButton
          tab="pr"
          active={!showHostFiles && resolvedTab === "pr"}
          label={prTabLabel}
          onTabPress={onTabPress}
          testID="explorer-tab-pr"
        >
          <PullRequestTabIcon
            forge={forge}
            size={13}
            color={
              !showHostFiles && resolvedTab === "pr"
                ? theme.colors.foreground
                : theme.colors.foregroundMuted
            }
          />
        </ExplorerTabButton>
      )}
    </View>
  );
}

interface SidebarContentProps {
  activeTab: ExplorerTab;
  onTabPress: (tab: ExplorerTab) => void;
  onClose: () => void;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  isOpen: boolean;
  onOpenFile?: (filePath: string) => void;
  onOpenDiff?: (filePath: string, baseRef: string | null) => void;
  onOpenHostFile?: (filePath: string) => void;
}

function resolveEffectiveTab(
  activeTab: ExplorerTab,
  isGit: boolean,
  showPrTab: boolean,
): ExplorerTab {
  const requested: ExplorerTab =
    !isGit && (activeTab === "changes" || activeTab === "pr") ? "files" : activeTab;
  return requested === "pr" && !showPrTab ? "changes" : requested;
}

function ExplorerContentArea({
  showHostFiles,
  mountedTabIds,
  resolvedTab,
  serverId,
  workspaceId,
  effectiveCwd,
  workspaceRoot,
  selectedSubmodule,
  isOpen,
  onOpenFile,
  onOpenDiff,
  onOpenHostFile,
  prPane,
}: {
  showHostFiles: boolean;
  mountedTabIds: Set<string>;
  resolvedTab: ExplorerTab;
  serverId: string;
  workspaceId?: string | null;
  effectiveCwd: string;
  workspaceRoot: string;
  selectedSubmodule: string | null;
  isOpen: boolean;
  onOpenFile?: (filePath: string) => void;
  onOpenDiff?: (filePath: string, baseRef: string | null) => void;
  onOpenHostFile: (filePath: string) => void;
  prPane: ReturnType<typeof usePullRequestPanelAvailability>["prPane"];
}) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const submodulePrefix = selectedSubmodule ? `${selectedSubmodule}/` : "";
  const handleOpenFile = useMemo(
    () =>
      onOpenFile
        ? (filePath: string) =>
            onOpenFile(filePath.startsWith("/") ? filePath : `${submodulePrefix}${filePath}`)
        : undefined,
    [onOpenFile, submodulePrefix],
  );
  const handleOpenDiff = useMemo(
    () =>
      onOpenDiff
        ? (filePath: string, baseRef: string | null) =>
            onOpenDiff(
              filePath.startsWith("/") ? filePath : `${submodulePrefix}${filePath}`,
              baseRef,
            )
        : undefined,
    [onOpenDiff, submodulePrefix],
  );
  const onAddToChat = useMemo(
    () =>
      canAddToChat
        ? (filePath: string) =>
            addFile(filePath.startsWith("/") ? filePath : `${submodulePrefix}${filePath}`)
        : undefined,
    [addFile, canAddToChat, submodulePrefix],
  );

  if (showHostFiles) {
    return (
      <View style={styles.contentArea} testID="explorer-content-area">
        <RetainedPanel active>
          <FileExplorerPane
            serverId={serverId}
            workspaceId={null}
            workspaceRoot="/"
            onOpenFile={onOpenHostFile}
          />
        </RetainedPanel>
      </View>
    );
  }

  return (
    <View style={styles.contentArea} testID="explorer-content-area">
      {mountedTabIds.has("changes") ? (
        <RetainedPanel active={!showHostFiles && resolvedTab === "changes"}>
          <GitDiffPane
            host="explorer"
            serverId={serverId}
            workspaceId={workspaceId}
            cwd={effectiveCwd}
            enabled={isOpen}
            onOpenFile={handleOpenFile}
            onOpenDiff={handleOpenDiff}
            onAddToChat={onAddToChat}
          />
        </RetainedPanel>
      ) : null}
      {mountedTabIds.has("files") ? (
        <RetainedPanel active={!showHostFiles && resolvedTab === "files"}>
          <FileExplorerPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={selectedSubmodule ? effectiveCwd : workspaceRoot}
            onOpenFile={handleOpenFile}
            onAddToChat={onAddToChat}
          />
        </RetainedPanel>
      ) : null}
      {mountedTabIds.has("pr") ? (
        <RetainedPanel active={!showHostFiles && resolvedTab === "pr"}>
          <PullRequestContent
            serverId={serverId}
            workspaceId={workspaceId}
            cwd={effectiveCwd}
            prPane={prPane}
          />
        </RetainedPanel>
      ) : null}
    </View>
  );
}

function ExplorerSidebarContent({
  activeTab,
  onTabPress,
  onClose,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  isOpen,
  onOpenFile,
  onOpenDiff,
  onOpenHostFile,
}: SidebarContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [showHostFiles, setShowHostFiles] = useState(false);

  const submoduleState = useSubmoduleContext({ serverId, workspaceRoot, isGit, enabled: isOpen });
  const { effectiveCwd, submodules, hasSubmodules, selectedSubmodule, setSelectedSubmodule } =
    submoduleState;

  const { prPane, showPullRequest: showPrTab } = usePullRequestPanelAvailability({
    serverId,
    cwd: effectiveCwd,
    isGit,
    requested: activeTab === "pr",
    enabled: isOpen,
    timelineEnabled: activeTab === "pr" && isOpen,
  });
  const resolvedTab = resolveEffectiveTab(activeTab, isGit, showPrTab);
  const prTabLabel = formatPrTabLabel(prPane.prNumber);
  const handleWorkspaceTabPress = useCallback(
    (tab: ExplorerTab) => {
      setShowHostFiles(false);
      onTabPress(tab);
    },
    [onTabPress],
  );
  const handleShowHostFiles = useCallback(() => setShowHostFiles(true), []);
  const handleOpenHostFile = useCallback(
    (filePath: string) => {
      onOpenHostFile?.(filePath.startsWith("/") ? filePath : `/${filePath}`);
    },
    [onOpenHostFile],
  );
  const availableTabs = useMemo<ExplorerTab[]>(() => {
    const tabs: ExplorerTab[] = isGit ? ["changes", "files"] : ["files"];
    if (isGit && showPrTab) tabs.push("pr");
    return tabs;
  }, [isGit, showPrTab]);
  const { mountedTabIds } = useMountedTabSet({
    activeTabId: resolvedTab,
    allTabIds: availableTabs,
    cap: availableTabs.length,
  });

  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={theme.spacing[2]}
        style={styles.header}
        testID="explorer-header"
      >
        <TitlebarDragRegion />
        <ExplorerTabs
          resolvedTab={resolvedTab}
          isGit={isGit}
          showPrTab={showPrTab}
          showHostFiles={showHostFiles}
          hostEnabled={getIsElectron() && Boolean(onOpenHostFile)}
          changesLabel={t("workspace.tabs.explorer.changes")}
          filesLabel={t("workspace.tabs.explorer.files")}
          hostLabel={t("workspace.tabs.explorer.host", { defaultValue: "Host" })}
          prTabLabel={prTabLabel}
          forge={prPane.forge}
          onTabPress={handleWorkspaceTabPress}
          onHostPress={handleShowHostFiles}
        />
        <View style={styles.headerRightSection}>
          {isGit && hasSubmodules && (
            <SubmodulePicker
              submodules={submodules}
              selectedPath={selectedSubmodule}
              onSelect={setSelectedSubmodule}
            />
          )}
          <Pressable
            onPress={onClose}
            style={styles.closeButton}
            testID="explorer-close"
            nativeID="explorer-close"
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("workspace.tabs.explorer.close")}
            hitSlop={8}
          >
            {({ hovered, pressed }) => (
              <X
                size={18}
                color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </View>
      </WindowChromeSafeArea>

      <ExplorerContentArea
        showHostFiles={showHostFiles}
        mountedTabIds={mountedTabIds}
        resolvedTab={resolvedTab}
        serverId={serverId}
        workspaceId={workspaceId}
        effectiveCwd={effectiveCwd}
        workspaceRoot={workspaceRoot}
        selectedSubmodule={selectedSubmodule}
        isOpen={isOpen}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onOpenHostFile={handleOpenHostFile}
        prPane={prPane}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tabsContainer: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
  },
  tabTextMuted: {
    opacity: 0.8,
  },
  headerRightSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
  },
}));
