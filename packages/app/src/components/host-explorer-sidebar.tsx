import { useCallback, useMemo, useRef } from "react";
import {
  Pressable,
  Text,
  useWindowDimensions,
  View,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HardDrive, X } from "lucide-react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { getIsElectron, isWeb } from "@/constants/platform";
import {
  MAX_EXPLORER_SIDEBAR_WIDTH,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  usePanelStore,
} from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";

// Host browser is always rooted at the filesystem root; the daemon expands and
// sandboxes relative navigation from there (file-explorer/service.ts).
const HOST_EXPLORER_ROOT = "/";
const MIN_CHAT_WIDTH = 400;

interface HostExplorerSidebarProps {
  serverId: string;
  /** Opens the given absolute host path in VS Code Web. */
  onOpenFile: (absolutePath: string) => void;
}

/**
 * Desktop-only right-side sidebar that browses the host filesystem (rooted at
 * `/`) independent of any workspace. Files clicked here open in VS Code Web; the
 * per-file Download action from the shared file tree still works.
 */
const ThemedHardDrive = withUnistyles(HardDrive);
const ThemedX = withUnistyles(X);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function HostExplorerSidebar({ serverId, onOpenFile }: HostExplorerSidebarProps) {
  const insets = useSafeAreaInsets();
  const hostExplorer = usePanelStore((state) => state.hostExplorer);
  const width = usePanelStore((state) => state.hostExplorerWidth);
  const setWidth = usePanelStore((state) => state.setHostExplorerWidth);
  const closeHostExplorer = usePanelStore((state) => state.closeHostExplorer);
  const { width: viewportWidth } = useWindowDimensions();

  const startWidthRef = useRef(width);
  const resizeWidth = useSharedValue(width);

  const isOpen = hostExplorer.open && hostExplorer.serverId === serverId;

  const handleOpenFile = useCallback(
    (relativePath: string) => {
      const trimmed = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      onOpenFile(`/${trimmed}`);
    },
    [onOpenFile],
  );

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = width;
          resizeWidth.value = width;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          const maxWidth = Math.max(
            MIN_EXPLORER_SIDEBAR_WIDTH,
            Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, viewportWidth - MIN_CHAT_WIDTH),
          );
          resizeWidth.value = Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, Math.min(maxWidth, newWidth));
        })
        .onEnd(() => {
          runOnJS(setWidth)(resizeWidth.value);
        }),
    [resizeWidth, setWidth, viewportWidth, width],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));
  const sidebarStyle = useMemo(
    () => [staticStyles.sidebar, resizeAnimatedStyle, { paddingTop: insets.top }],
    [resizeAnimatedStyle, insets.top],
  );

  if (!getIsElectron() || !isOpen) {
    return null;
  }

  return (
    <Animated.View style={sidebarStyle}>
      <View style={BORDER_STYLE}>
        <GestureDetector gesture={resizeGesture}>
          <View style={RESIZE_HANDLE_STYLE} />
        </GestureDetector>

        <View style={styles.content} pointerEvents="auto">
          <View style={styles.header} testID="host-explorer-header">
            <TitlebarDragRegion />
            <View style={styles.titleRow}>
              <ThemedHardDrive size={14} uniProps={foregroundMutedColorMapping} />
              <Text style={styles.title}>Host files</Text>
            </View>
            <Pressable
              onPress={closeHostExplorer}
              style={styles.closeButton}
              testID="host-explorer-close"
            >
              <ThemedX size={18} uniProps={foregroundMutedColorMapping} />
            </Pressable>
          </View>

          <View style={styles.contentArea}>
            <FileExplorerPane
              serverId={serverId}
              workspaceId={null}
              workspaceRoot={HOST_EXPLORER_ROOT}
              onOpenFile={handleOpenFile}
            />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// Static styles for the Animated.View (see explorer-sidebar.tsx for the rationale
// on keeping Unistyles off Reanimated-managed nodes).
const staticStyles = RNStyleSheet.create({
  sidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  desktopSidebarBorder: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  resizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 10,
  },
  content: {
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
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
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

const BORDER_STYLE = [styles.desktopSidebarBorder, { flex: 1 }];
const RESIZE_HANDLE_STYLE = [styles.resizeHandle, isWeb && ({ cursor: "col-resize" } as object)];
