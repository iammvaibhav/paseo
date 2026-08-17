import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HardDrive, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatPrTabLabel, PullRequestTabIcon, usePrPaneData } from "@/git/pull-request-panel";
import type { Forge } from "@/git/forge";
import type { UsePrPaneDataResult } from "@/git/pull-request-panel/use-data";
import { usePanelStore, selectIsFileExplorerOpen, type ExplorerTab } from "@/stores/panel-store";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { GitDiffPane } from "@/git/diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useHasOwnedWindowChromeObstruction, WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { getIsElectron } from "@/constants/platform";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import { findSubmodule, useSubmodulesQuery } from "@/git/use-submodules-query";
import { SubmodulePicker } from "@/git/submodule-picker";
import { resolveSelectedSubmoduleForCheckout } from "@/stores/explorer-submodule-memory";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
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
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: true }));
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: true,
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
        paddingTop: insets.top,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      mobileKeyboardInsetStyle,
    ],
    [insets.top, theme.colors.surfaceSidebar, mobileKeyboardInsetStyle],
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

export function ExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
  onOpenDiff,
  onOpenHostFile,
}: ExplorerSidebarProps) {
  const insets = useSafeAreaInsets();
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: false }));
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const { width: viewportWidth } = useWindowDimensions();
  const visibleExplorerWidth = resolveDesktopExplorerWidth({
    requestedWidth: explorerWidth,
    viewportWidth,
  });
  const startWidthRef = useRef(visibleExplorerWidth);
  const resizeWidth = useSharedValue(visibleExplorerWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleExplorerWidth;
  }, [resizeWidth, visibleExplorerWidth]);

  const handleDesktopClose = useCallback(() => {
    logExplorerSidebar("handleClose", {
      reason: "desktop-close-button",
      isOpen,
    });
    closeDesktopFileExplorer();
  }, [closeDesktopFileExplorer, isOpen]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // See the left sidebar's gesture: horizontal intent only, with the start
        // width anchored to the activation translation so the threshold is free.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleExplorerWidth + event.translationX;
          resizeWidth.value = visibleExplorerWidth;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          resizeWidth.value = resolveDesktopExplorerWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setExplorerWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setExplorerWidth,
      showResizeGrip,
      viewportWidth,
      visibleExplorerWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));
  const desktopSidebarStyle = useMemo(
    () => [explorerStaticStyles.desktopSidebar, resizeAnimatedStyle, { paddingTop: insets.top }],
    [resizeAnimatedStyle, insets.top],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={desktopSidebarStyle}>
      <View style={[styles.desktopSidebarBorder, { flex: 1 }]}>
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="explorer-sidebar-resize-handle"
        />

        <ExplorerSidebarContent
          activeTab={explorerTab}
          onTabPress={handleTabPress}
          onClose={handleDesktopClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isOpen={isOpen}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onOpenHostFile={onOpenHostFile}
        />
      </View>
    </Animated.View>
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

function useSubmoduleContext({
  serverId,
  workspaceRoot,
  isGit,
  isOpen,
}: {
  serverId: string;
  workspaceRoot: string;
  isGit: boolean;
  isOpen: boolean;
}) {
  const storedSubmodule = usePanelStore((state) =>
    resolveSelectedSubmoduleForCheckout({
      serverId,
      cwd: workspaceRoot,
      selectedSubmoduleByCheckout: state.selectedSubmoduleByCheckout,
    }),
  );
  const setSelectedSubmoduleForCheckout = usePanelStore(
    (state) => state.setSelectedSubmoduleForCheckout,
  );
  const { submodules, hasSubmodules, isResolved } = useSubmodulesQuery({
    serverId,
    cwd: workspaceRoot,
    enabled: isGit && isOpen,
  });
  // The remembered submodule survives until the checkout proves it is gone;
  // holding it through the initial fetch avoids a root -> submodule flip that
  // would make the diff and PR panes fetch the superproject first.
  const selectedSubmodule =
    storedSubmodule && isResolved && !findSubmodule(submodules, storedSubmodule)
      ? null
      : storedSubmodule;
  const setSelectedSubmodule = useCallback(
    (submodulePath: string | null) => {
      setSelectedSubmoduleForCheckout({ serverId, cwd: workspaceRoot, submodulePath });
    },
    [serverId, setSelectedSubmoduleForCheckout, workspaceRoot],
  );
  const effectiveCwd = useMemo(
    () => (selectedSubmodule ? `${workspaceRoot}/${selectedSubmodule}` : workspaceRoot),
    [workspaceRoot, selectedSubmodule],
  );
  return { effectiveCwd, submodules, hasSubmodules, selectedSubmodule, setSelectedSubmodule };
}
function ExplorerContentArea({
  showHostFiles,
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
  prPane: UsePrPaneDataResult;
}) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  // The changes and files panes are rooted at the selected submodule, so the
  // paths they hand back are relative to it. Everything downstream — the
  // workspace file tab, VS Code Web, chat attachments — resolves paths against
  // the workspace root.
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
        <FileExplorerPane
          serverId={serverId}
          workspaceId={null}
          workspaceRoot="/"
          onOpenFile={onOpenHostFile}
        />
      </View>
    );
  }

  return (
    <View style={styles.contentArea} testID="explorer-content-area">
      {resolvedTab === "changes" && (
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
      )}
      {resolvedTab === "files" && (
        <FileExplorerPane
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={selectedSubmodule ? effectiveCwd : workspaceRoot}
          onOpenFile={handleOpenFile}
          onAddToChat={onAddToChat}
        />
      )}
      {resolvedTab === "pr" && (
        <PullRequestContent
          serverId={serverId}
          workspaceId={workspaceId}
          cwd={effectiveCwd}
          prPane={prPane}
        />
      )}
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
  const hasRightWindowControls = useHasOwnedWindowChromeObstruction("top-right");
  const [showHostFiles, setShowHostFiles] = useState(false);

  const submoduleState = useSubmoduleContext({ serverId, workspaceRoot, isGit, isOpen });
  const { effectiveCwd, submodules, hasSubmodules, selectedSubmodule, setSelectedSubmodule } =
    submoduleState;

  const canQueryPullRequest = isGit && Boolean(effectiveCwd);
  const prPane = usePrPaneData({
    serverId,
    cwd: effectiveCwd,
    enabled: canQueryPullRequest && isOpen,
    timelineEnabled: activeTab === "pr" && canQueryPullRequest && isOpen,
  });
  const showPrTab = prPane.prNumber !== null || (activeTab === "pr" && prPane.isLoading);
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

  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      {/* Header with tabs and close button */}
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
          {!hasRightWindowControls && (
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
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          )}
        </View>
      </WindowChromeSafeArea>

      <ExplorerContentArea
        showHostFiles={showHostFiles}
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

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const explorerStaticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  desktopSidebarBorder: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
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
    fontSize: theme.fontSize.sm,
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
