import { useCallback, useEffect, useMemo, useRef, type ReactElement, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  ListRenderItemInfo,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import * as Clipboard from "expo-clipboard";
import { ChevronDown, Eye, EyeOff, RotateCw } from "lucide-react-native";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { TreeChevron, TreeIndentGuides, TREE_INDENT_PER_LEVEL } from "@/components/tree-primitives";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import type {
  AgentFileExplorerState,
  ExplorerDirectory,
  ExplorerEntry,
} from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useDownloadStore } from "@/stores/download-store";
import { FileActionsMenu } from "@/components/file-actions-menu";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { useFileDrop } from "@/components/file-drop/use-file-drop";
import type { DroppedItem } from "@/components/file-drop/types";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { usePanelStore, type ExpandedPathsUpdate, type SortOption } from "@/stores/panel-store";
import { formatTimeAgo } from "@/utils/time";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";
import {
  droppedItemsToExplorerFiles,
  resolveExplorerDropDirectoryPath,
} from "@/file-explorer/drop-upload";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import {
  flattenExplorerTree,
  reconcileRestoredExpandedPaths,
  restoreExpandedDirectories,
  setExpandedDirectoryPath,
  showHiddenFilesAndRestoreExpandedDirectories,
  type ExplorerTreeRow,
} from "@/file-explorer/tree";
import { useWorkspaceFileDragSource } from "@/attachments/use-workspace-file-drag-source";

const SORT_OPTIONS: { value: SortOption }[] = [
  { value: "name" },
  { value: "modified" },
  { value: "size" },
];

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

interface TreeRowItemProps {
  serverId: string;
  workspaceId?: string | null;
  entry: ExplorerEntry;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  loading: boolean;
  onEntryPress: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  testID?: string;
}

function sortTriggerStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.sortTrigger, (Boolean(hovered) || pressed) && styles.sortTriggerHovered];
}

function iconButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.iconButton, (Boolean(hovered) || pressed) && styles.iconButtonHovered];
}

function treeRowKeyExtractor(row: ExplorerTreeRow) {
  return row.entry.path;
}

function TreeRowItem({
  serverId,
  workspaceId,
  entry,
  depth,
  isExpanded,
  isSelected,
  loading,
  onEntryPress,
  onCopyPath,
  onDownloadEntry,
  onAddToChat,
  testID,
}: TreeRowItemProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isDirectory = entry.kind === "directory";
  const dragSourceRef = useWorkspaceFileDragSource({
    enabled: !isDirectory,
    serverId,
    workspaceId,
    path: entry.path,
  });

  const handlePress = useCallback(() => {
    onEntryPress(entry);
  }, [onEntryPress, entry]);

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.entryRow,
      { paddingLeft: theme.spacing[2] + depth * TREE_INDENT_PER_LEVEL },
      (Boolean(hovered) || pressed || isSelected) && styles.entryRowActive,
    ],
    [depth, isSelected, theme.spacing],
  );

  const handleCopy = useCallback(() => {
    onCopyPath(entry.path);
  }, [onCopyPath, entry.path]);

  const handleDownload = useCallback(() => {
    onDownloadEntry(entry);
  }, [onDownloadEntry, entry]);

  const handleAddToChat = useCallback(() => {
    onAddToChat?.(entry.path);
  }, [onAddToChat, entry.path]);

  const metaHeader = useMemo(
    () => (
      <View style={styles.contextMetaBlock}>
        <View style={styles.contextMetaRow}>
          <Text style={styles.contextMetaLabel} numberOfLines={1}>
            {t("workspace.fileExplorer.context.size")}
          </Text>
          <Text style={styles.contextMetaValue} numberOfLines={1} ellipsizeMode="tail">
            {formatFileSize({ size: entry.size })}
          </Text>
        </View>
        <View style={styles.contextMetaRow}>
          <Text style={styles.contextMetaLabel} numberOfLines={1}>
            {t("workspace.fileExplorer.context.modified")}
          </Text>
          <Text style={styles.contextMetaValue} numberOfLines={1} ellipsizeMode="tail">
            {formatTimeAgo(new Date(entry.modifiedAt))}
          </Text>
        </View>
      </View>
    ),
    [entry.modifiedAt, entry.size, t],
  );

  return (
    <Pressable onPress={handlePress} style={pressableStyle} testID={testID}>
      <TreeIndentGuides depth={depth} />
      <View ref={dragSourceRef} style={styles.entryInfo}>
        <View style={styles.entryIcon}>
          {(() => {
            if (!isDirectory) {
              return <MaterialFileIcon fileName={entry.name} size={16} />;
            }
            if (loading) {
              return <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />;
            }
            return <TreeChevron expanded={isExpanded} />;
          })()}
        </View>
        <Text style={styles.entryName} numberOfLines={1}>
          {entry.name}
        </Text>
      </View>
      <FileActionsMenu
        fileKind={entry.kind}
        onCopyPath={handleCopy}
        onDownload={handleDownload}
        onAddToChat={onAddToChat ? handleAddToChat : undefined}
        header={metaHeader}
        accessibilityLabel={t("workspace.fileActions.moreActions")}
        testIDPrefix={testID}
      />
    </Pressable>
  );
}

interface FileExplorerPaneProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  onOpenFile?: (filePath: string) => void;
  onAddToChat?: (path: string) => void;
}

export function FileExplorerPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
  onAddToChat,
}: FileExplorerPaneProps) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const hasWorkspaceScope = Boolean(workspaceStateKey && normalizedWorkspaceRoot);
  const explorerState = useSessionStore((state) =>
    workspaceStateKey && state.sessions[serverId]
      ? state.sessions[serverId]?.fileExplorer.get(workspaceStateKey)
      : undefined,
  );

  const { requestDirectoryListing, requestFileDownloadToken, selectExplorerEntry } =
    useFileExplorerActions({
      serverId,
      workspaceId,
      workspaceRoot: normalizedWorkspaceRoot,
    });
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const toggleExplorerShowHiddenFiles = usePanelStore(
    (state) => state.toggleExplorerShowHiddenFiles,
  );
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.expandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPathsForWorkspace = usePanelStore((state) => state.setExpandedPathsForWorkspace);
  const expandedPaths = useMemo(
    () => new Set(expandedPathsArray && expandedPathsArray.length > 0 ? expandedPathsArray : ["."]),
    [expandedPathsArray],
  );

  const explorerDerived = useMemo(() => deriveExplorerFields(explorerState), [explorerState]);
  const { directories, pendingRequest, isExplorerLoading, error, selectedEntryPath } =
    explorerDerived;

  const isDirectoryLoading = useCallback(
    (path: string) => isPendingListForPath({ isExplorerLoading, pendingRequest, path }),
    [isExplorerLoading, pendingRequest],
  );

  const treeListRef = useRef<FlatList<ExplorerTreeRow>>(null);

  const hasInitializedRef = useRef(false);

  useEffect(() => {
    hasInitializedRef.current = false;
  }, [workspaceStateKey]);

  useEffect(() => {
    void initializeExplorer({
      hasWorkspaceScope,
      hasInitializedRef,
      workspaceStateKey,
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
    });
  }, [
    expandedPaths,
    hasWorkspaceScope,
    requestDirectoryListing,
    setExpandedPathsForWorkspace,
    showHiddenFiles,
    workspaceStateKey,
  ]);

  const handleToggleDirectory = useCallback(
    (entry: ExplorerEntry) =>
      toggleDirectory({
        entry,
        workspaceStateKey,
        expandedPaths,
        directories,
        requestDirectoryListing,
        setExpandedPathsForWorkspace,
      }),
    [
      workspaceStateKey,
      expandedPaths,
      directories,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
    ],
  );

  const handleOpenFile = useCallback(
    (entry: ExplorerEntry) => {
      if (!hasWorkspaceScope) {
        return;
      }
      selectExplorerEntry(entry.path);
      onOpenFile?.(entry.path);
    },
    [hasWorkspaceScope, onOpenFile, selectExplorerEntry],
  );

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind === "directory") {
        handleToggleDirectory(entry);
        return;
      }
      handleOpenFile(entry);
    },
    [handleOpenFile, handleToggleDirectory],
  );

  const handleCopyPath = useCallback(
    async (path: string) => {
      await Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({
          workspaceRoot: normalizedWorkspaceRoot,
          entryPath: path,
        }),
      );
    },
    [normalizedWorkspaceRoot],
  );

  const startDownload = useDownloadStore((state) => state.startDownload);
  const handleDownloadEntry = useCallback(
    (entry: ExplorerEntry) =>
      downloadExplorerEntry({
        entry,
        workspaceScopeId,
        serverId,
        daemonProfile,
        startDownload,
        requestFileDownloadToken,
      }),
    [daemonProfile, requestFileDownloadToken, serverId, startDownload, workspaceScopeId],
  );

  const handleSortCycle = useCallback(() => {
    const currentIndex = SORT_OPTIONS.findIndex((opt) => opt.value === sortOption);
    const nextIndex = (currentIndex + 1) % SORT_OPTIONS.length;
    setSortOption(SORT_OPTIONS[nextIndex].value);
  }, [sortOption, setSortOption]);

  const handleToggleHiddenFiles = useCallback(() => {
    const willShow = !usePanelStore.getState().explorerShowHiddenFiles;
    if (!willShow) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    const rootDirectory = directories.get(".");
    if (!rootDirectory || !workspaceStateKey) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    void showHiddenFilesAndRestoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles: toggleExplorerShowHiddenFiles,
      requestDirectoryListing: (path) =>
        requestDirectoryListing(path, {
          recordHistory: false,
          setCurrentPath: false,
        }),
    }).then((restoredPaths) => {
      setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        reconcileRestoredExpandedPaths({
          persistedExpandedPaths: expandedPaths,
          currentExpandedPaths: new Set(currentPaths),
          restoredExpandedPaths: restoredPaths,
        }),
      );
      return null;
    });
  }, [
    directories,
    expandedPaths,
    requestDirectoryListing,
    setExpandedPathsForWorkspace,
    toggleExplorerShowHiddenFiles,
    workspaceStateKey,
  ]);

  const refreshExplorer = useCallback(
    () =>
      refreshExplorerDirectories({
        hasWorkspaceScope,
        expandedPaths,
        requestDirectoryListing,
      }),
    [expandedPaths, hasWorkspaceScope, requestDirectoryListing],
  );
  const { refetch: refetchExplorer, isFetching: isRefreshFetching } = useQuery({
    queryKey: ["fileExplorerRefresh", serverId, workspaceStateKey],
    queryFn: refreshExplorer,
    enabled: false,
  });

  const handleRefresh = useCallback(() => {
    void refetchExplorer();
  }, [refetchExplorer]);

  const handleDropUploaded = useCallback(() => {
    void refetchExplorer();
  }, [refetchExplorer]);

  const sortLabels = useMemo(
    () => ({
      name: t("workspace.fileExplorer.sort.name"),
      modified: t("workspace.fileExplorer.sort.modified"),
      size: t("workspace.fileExplorer.sort.size"),
    }),
    [t],
  );
  const currentSortLabel = resolveCurrentSortLabel(sortOption, sortLabels);

  const treeRows = useMemo(
    () => flattenExplorerTree({ directories, expandedPaths, sortOption, showHiddenFiles }),
    [directories, expandedPaths, showHiddenFiles, sortOption],
  );

  const showInitialLoading = resolveShowInitialLoading({
    directories,
    isExplorerLoading,
    pendingRequest,
  });
  const showBackFromError = Boolean(error && selectedEntryPath);
  const errorRecoveryPath = useMemo(() => getErrorRecoveryPath(explorerState), [explorerState]);

  const renderTreeRow = useCallback(
    (info: ListRenderItemInfo<ExplorerTreeRow>) => (
      <TreeRowDispatcher
        info={info}
        serverId={serverId}
        workspaceId={workspaceId}
        expandedPaths={expandedPaths}
        selectedEntryPath={selectedEntryPath}
        isDirectoryLoading={isDirectoryLoading}
        onEntryPress={handleEntryPress}
        onCopyPath={handleCopyPath}
        onDownloadEntry={handleDownloadEntry}
        onAddToChat={onAddToChat}
      />
    ),
    [
      expandedPaths,
      handleEntryPress,
      handleCopyPath,
      handleDownloadEntry,
      isDirectoryLoading,
      onAddToChat,
      selectedEntryPath,
      serverId,
      workspaceId,
    ],
  );

  const handleBackFromError = useCallback(() => {
    if (!hasWorkspaceScope) {
      return;
    }
    selectExplorerEntry(null);
    void requestDirectoryListing(errorRecoveryPath, {
      recordHistory: false,
      setCurrentPath: true,
    });
  }, [errorRecoveryPath, hasWorkspaceScope, requestDirectoryListing, selectExplorerEntry]);

  const handleRetry = useCallback(() => {
    void requestDirectoryListing(".", {
      recordHistory: false,
      setCurrentPath: false,
    });
  }, [requestDirectoryListing]);

  if (!hasWorkspaceScope) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{t("workspace.fileExplorer.states.unavailable")}</Text>
      </View>
    );
  }

  return (
    <FileDropZone style={styles.container}>
      <FileExplorerDropTarget
        disabled={!client}
        client={client}
        cwd={normalizedWorkspaceRoot}
        directories={directories}
        selectedEntryPath={selectedEntryPath}
        onUploaded={handleDropUploaded}
      />
      <FileExplorerPaneContent
        error={error}
        showInitialLoading={showInitialLoading}
        showBackFromError={showBackFromError}
        treeRows={treeRows}
        currentSortLabel={currentSortLabel}
        isRefreshFetching={isRefreshFetching}
        treeListRef={treeListRef}
        renderTreeRow={renderTreeRow}
        handleSortCycle={handleSortCycle}
        handleToggleHiddenFiles={handleToggleHiddenFiles}
        handleRefresh={handleRefresh}
        handleBackFromError={handleBackFromError}
        handleRetry={handleRetry}
        sortTriggerStyle={sortTriggerStyle}
        iconButtonStyle={iconButtonStyle}
      />
    </FileDropZone>
  );
}

interface FileExplorerDropClient {
  writeExplorerFile: (input: {
    cwd: string;
    directoryPath?: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  }) => Promise<{ error: string | null }>;
}

function FileExplorerDropTarget({
  disabled,
  client,
  cwd,
  directories,
  selectedEntryPath,
  onUploaded,
}: {
  disabled: boolean;
  client: FileExplorerDropClient | null;
  cwd: string;
  directories: Map<string, { entries: ExplorerEntry[] }>;
  selectedEntryPath: string | null;
  onUploaded: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const isUploadingDropRef = useRef(false);

  const handleExplorerDrop = useCallback(
    async (items: DroppedItem[]) => {
      if (disabled || isUploadingDropRef.current) {
        return;
      }
      if (!client) {
        toast.error(t("workspace.fileExplorer.drop.hostDisconnected"));
        return;
      }

      let files;
      try {
        files = await droppedItemsToExplorerFiles(items);
      } catch (error) {
        toast.error(toErrorMessage(error));
        return;
      }
      if (files.length === 0) {
        return;
      }

      const directoryPath = resolveExplorerDropDirectoryPath({
        selectedEntryPath,
        directories,
      });

      isUploadingDropRef.current = true;
      toast.show(
        t("workspace.fileExplorer.drop.uploading", {
          count: files.length,
        }),
      );
      try {
        for (const file of files) {
          const response = await client.writeExplorerFile({
            cwd,
            directoryPath,
            fileName: file.fileName,
            mimeType: file.mimeType,
            bytes: file.bytes,
          });
          if (response.error) {
            throw new Error(response.error);
          }
        }
        toast.show(
          t("workspace.fileExplorer.drop.uploaded", {
            count: files.length,
          }),
          { variant: "success" },
        );
        onUploaded();
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        isUploadingDropRef.current = false;
      }
    },
    [client, cwd, directories, disabled, onUploaded, selectedEntryPath, t, toast],
  );

  useFileDrop(
    {
      onFiles: () => undefined,
      onGenericFiles: (items) => {
        void handleExplorerDrop(items);
      },
    },
    { disabled },
  );

  return null;
}

interface FileExplorerPaneContentProps {
  error: string | null;
  showInitialLoading: boolean;
  showBackFromError: boolean;
  treeRows: ExplorerTreeRow[];
  currentSortLabel: string;
  isRefreshFetching: boolean;
  treeListRef: RefObject<FlatList<ExplorerTreeRow> | null>;
  renderTreeRow: (info: ListRenderItemInfo<ExplorerTreeRow>) => ReactElement;
  handleSortCycle: () => void;
  handleToggleHiddenFiles: () => void;
  handleRefresh: () => void;
  handleBackFromError: () => void;
  handleRetry: () => void;
  sortTriggerStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  iconButtonStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
}

function FileExplorerPaneContent(props: FileExplorerPaneContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    error,
    showInitialLoading,
    showBackFromError,
    treeRows,
    currentSortLabel,
    isRefreshFetching,
    treeListRef,
    renderTreeRow,
    handleSortCycle,
    handleToggleHiddenFiles,
    handleRefresh,
    handleBackFromError,
    handleRetry,
    sortTriggerStyle: sortTriggerStyleProp,
    iconButtonStyle: iconButtonStyleProp,
  } = props;

  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);

  const hiddenFilesToggleAccessibilityLabel = showHiddenFiles
    ? t("workspace.fileExplorer.actions.hideHiddenFiles")
    : t("workspace.fileExplorer.actions.showHiddenFiles");
  const emptyLabel = showHiddenFiles
    ? t("workspace.fileExplorer.empty.noFiles")
    : t("workspace.fileExplorer.empty.noVisibleFiles");
  const hiddenFilesToggleStyle = useCallback(
    (state: PressableStateCallbackType) => [
      iconButtonStyleProp(state),
      !showHiddenFiles && styles.iconButtonActive,
    ],
    [showHiddenFiles, iconButtonStyleProp],
  );
  const hiddenFilesToggleAccessibilityState = useMemo(
    () => ({ selected: !showHiddenFiles }),
    [showHiddenFiles],
  );

  if (error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{error}</Text>
        <View style={styles.errorActions}>
          {showBackFromError ? (
            <Pressable style={styles.retryButton} onPress={handleBackFromError}>
              <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.back")}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.retry")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (showInitialLoading) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("workspace.fileExplorer.states.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.treePane, styles.treePaneFill]}>
      <View style={styles.paneHeader} testID="files-pane-header">
        <Pressable onPress={handleSortCycle} style={sortTriggerStyleProp}>
          <Text style={styles.sortTriggerText}>{currentSortLabel}</Text>
          <ChevronDown size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleToggleHiddenFiles}
            hitSlop={8}
            style={hiddenFilesToggleStyle}
            accessibilityRole="button"
            accessibilityLabel={hiddenFilesToggleAccessibilityLabel}
            accessibilityState={hiddenFilesToggleAccessibilityState}
          >
            {showHiddenFiles ? (
              <Eye size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            ) : (
              <EyeOff size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
          <Pressable
            onPress={handleRefresh}
            disabled={isRefreshFetching}
            hitSlop={8}
            style={iconButtonStyleProp}
            accessibilityRole="button"
            accessibilityLabel={
              isRefreshFetching
                ? t("workspace.fileExplorer.actions.refreshing")
                : t("workspace.fileExplorer.actions.refresh")
            }
          >
            <View style={styles.refreshIcon}>
              {isRefreshFetching ? (
                <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              ) : (
                <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              )}
            </View>
          </Pressable>
        </View>
      </View>
      {treeRows.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyText}>{emptyLabel}</Text>
        </View>
      ) : (
        <FlatList
          ref={treeListRef}
          style={styles.treeList}
          data={treeRows}
          renderItem={renderTreeRow}
          keyExtractor={treeRowKeyExtractor}
          testID="file-explorer-tree-scroll"
          contentContainerStyle={styles.entriesContent}
          showsVerticalScrollIndicator
          initialNumToRender={24}
          maxToRenderPerBatch={40}
          windowSize={12}
        />
      )}
    </View>
  );
}

function deriveExplorerFields(state: AgentFileExplorerState | undefined) {
  return {
    directories:
      state?.directories ?? new Map<string, { path: string; entries: ExplorerEntry[] }>(),
    pendingRequest: state?.pendingRequest ?? null,
    isExplorerLoading: state?.isLoading ?? false,
    error: state?.lastError ?? null,
    selectedEntryPath: state?.selectedEntryPath ?? null,
  };
}

function isPendingListForPath({
  isExplorerLoading,
  pendingRequest,
  path,
}: {
  isExplorerLoading: boolean;
  pendingRequest: AgentFileExplorerState["pendingRequest"] | null;
  path: string;
}): boolean {
  return Boolean(
    isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === path,
  );
}

function resolveShowInitialLoading({
  directories,
  isExplorerLoading,
  pendingRequest,
}: {
  directories: Map<string, unknown>;
  isExplorerLoading: boolean;
  pendingRequest: AgentFileExplorerState["pendingRequest"] | null;
}): boolean {
  if (directories.has(".")) {
    return false;
  }
  return Boolean(
    isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === ".",
  );
}

function resolveCurrentSortLabel(
  sortOption: SortOption,
  labels: Record<SortOption, string>,
): string {
  return labels[sortOption] ?? labels.name;
}

type StartDownloadFn = ReturnType<typeof useDownloadStore.getState>["startDownload"];
type StartDownloadParams = Parameters<StartDownloadFn>[0];

function downloadExplorerEntry({
  entry,
  workspaceScopeId,
  serverId,
  daemonProfile,
  startDownload,
  requestFileDownloadToken,
}: {
  entry: ExplorerEntry;
  workspaceScopeId: string | undefined;
  serverId: string;
  daemonProfile: StartDownloadParams["daemonProfile"];
  startDownload: StartDownloadFn;
  requestFileDownloadToken: (
    targetPath: string,
  ) => ReturnType<StartDownloadParams["requestFileDownloadToken"]>;
}): void {
  if (!workspaceScopeId) {
    return;
  }
  let fileName = entry.name;
  if (entry.kind === "directory" && !entry.name.endsWith(".zip")) {
    fileName = `${entry.name}.zip`;
  }
  startDownload({
    serverId,
    scopeId: workspaceScopeId,
    fileName,
    path: entry.path,
    daemonProfile,
    requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
  });
}

function toggleDirectory({
  entry,
  workspaceStateKey,
  expandedPaths,
  directories,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  entry: ExplorerEntry;
  workspaceStateKey: string | null;
  expandedPaths: Set<string>;
  directories: Map<string, ExplorerDirectory>;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): void {
  if (!workspaceStateKey) {
    return;
  }
  const isExpanded = expandedPaths.has(entry.path);
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
    setExpandedDirectoryPath({
      currentExpandedPaths: currentPaths,
      directoryPath: entry.path,
      expanded: !isExpanded,
    }),
  );
  if (!isExpanded && !directories.has(entry.path)) {
    void requestDirectoryListing(entry.path, {
      recordHistory: false,
      setCurrentPath: false,
    });
  }
}

function TreeRowDispatcher({
  info,
  serverId,
  workspaceId,
  expandedPaths,
  selectedEntryPath,
  isDirectoryLoading,
  onEntryPress,
  onCopyPath,
  onDownloadEntry,
  onAddToChat,
}: {
  info: ListRenderItemInfo<ExplorerTreeRow>;
  serverId: string;
  workspaceId?: string | null;
  expandedPaths: Set<string>;
  selectedEntryPath: string | null;
  isDirectoryLoading: (path: string) => boolean;
  onEntryPress: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void | Promise<void>;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
}) {
  const entry = info.item.entry;
  const depth = info.item.depth;
  const isDirectory = entry.kind === "directory";
  const isExpanded = isDirectory && expandedPaths.has(entry.path);
  const isSelected = selectedEntryPath === entry.path;
  const loading = isDirectory && isDirectoryLoading(entry.path);

  return (
    <TreeRowItem
      serverId={serverId}
      workspaceId={workspaceId}
      entry={entry}
      depth={depth}
      isExpanded={isExpanded}
      isSelected={isSelected}
      loading={loading}
      onEntryPress={onEntryPress}
      onCopyPath={onCopyPath}
      onDownloadEntry={onDownloadEntry}
      onAddToChat={onAddToChat}
    />
  );
}

async function initializeExplorer({
  hasWorkspaceScope,
  hasInitializedRef,
  workspaceStateKey,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  hasWorkspaceScope: boolean;
  hasInitializedRef: RefObject<boolean>;
  workspaceStateKey: string | null;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): Promise<void> {
  if (!hasWorkspaceScope || hasInitializedRef.current) {
    return;
  }
  hasInitializedRef.current = true;
  const rootDirectory = await requestDirectoryListing(".", {
    recordHistory: false,
    setCurrentPath: false,
  });
  if (!rootDirectory) {
    hasInitializedRef.current = false;
    return;
  }
  if (!workspaceStateKey) {
    return;
  }

  const restoredPaths = await restoreExpandedDirectories({
    rootDirectory,
    persistedExpandedPaths,
    showHiddenFiles,
    requestDirectoryListing: (path) =>
      requestDirectoryListing(path, {
        recordHistory: false,
        setCurrentPath: false,
      }),
  });
  const hiddenPersistedPaths = showHiddenFiles
    ? []
    : Array.from(persistedExpandedPaths).filter(isHiddenExplorerPath);
  const restoredPathsWithHidden = [...restoredPaths, ...hiddenPersistedPaths];
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
    reconcileRestoredExpandedPaths({
      persistedExpandedPaths,
      currentExpandedPaths: new Set(currentPaths),
      restoredExpandedPaths: restoredPathsWithHidden,
    }),
  );
}

async function refreshExplorerDirectories({
  hasWorkspaceScope,
  expandedPaths,
  requestDirectoryListing,
}: {
  hasWorkspaceScope: boolean;
  expandedPaths: Set<string>;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
}): Promise<null> {
  if (!hasWorkspaceScope) {
    return null;
  }
  const showHiddenFiles = usePanelStore.getState().explorerShowHiddenFiles;
  const directoryPaths = Array.from(expandedPaths).filter(
    (path) => showHiddenFiles || !isHiddenExplorerPath(path),
  );
  if (!directoryPaths.includes(".")) {
    directoryPaths.unshift(".");
  }
  await Promise.all(
    directoryPaths.map((path) =>
      requestDirectoryListing(path, {
        recordHistory: false,
        setCurrentPath: false,
      }),
    ),
  );
  return null;
}

function getErrorRecoveryPath(state: AgentFileExplorerState | undefined): string {
  if (!state) {
    return ".";
  }

  const currentHistoryPath =
    state.history.length > 0 ? state.history[state.history.length - 1] : null;
  const candidate = currentHistoryPath ?? state.lastVisitedPath ?? state.currentPath;

  if (!candidate || candidate.length === 0) {
    return ".";
  }
  return candidate;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSplit: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  treePane: {
    minWidth: 0,
    position: "relative",
  },
  treePaneFill: {
    flex: 1,
  },
  treePaneWithPreview: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  splitResizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 20,
  },
  previewPane: {
    flex: 1,
    minWidth: 0,
  },
  paneHeader: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    marginLeft: theme.spacing[3] - theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    height: 24,
    borderRadius: theme.borderRadius.base,
  },
  sortTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  sortTriggerText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  treeList: {
    flex: 1,
    minHeight: 0,
  },
  entriesContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  errorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 2,
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  entryRowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  entryIcon: {
    flexShrink: 0,
  },
  entryName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  menuButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  contextMetaBlock: {
    paddingVertical: theme.spacing[1],
  },
  contextMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
  },
  contextMetaLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  contextMetaValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  previewHeaderText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  iconButton: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  refreshIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  previewContent: {
    flex: 1,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  previewCodeScrollContent: {
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3] + theme.spacing[2],
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    flexShrink: 0,
  },
  previewImageScrollContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  previewImage: {
    width: "100%",
    aspectRatio: 1,
  },
  sheetBackground: {
    backgroundColor: theme.colors.surface2,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  sheetCloseButton: {
    padding: theme.spacing[2],
  },
  sheetCenterState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
}));
