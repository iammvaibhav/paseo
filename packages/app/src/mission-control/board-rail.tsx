import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { clampBoardRailWidth, usePanelStore } from "@/stores/panel-store";

interface BoardRailProps {
  children: ReactNode;
  testID?: string;
}

/**
 * The Mission Control board rail: a fixed-width right column the user drags
 * wider or narrower. Width is persisted in the panel store (clamped 240–480)
 * so the rail comes back where the user left it, matching the sidebar's
 * resize pattern.
 */
export function BoardRail({ children, testID = "mission-control-board-rail" }: BoardRailProps) {
  const boardRailWidth = usePanelStore((state) => state.boardRailWidth);
  const setBoardRailWidth = usePanelStore((state) => state.setBoardRailWidth);

  const startWidthRef = useRef(boardRailWidth);
  const resizeWidth = useSharedValue(boardRailWidth);

  useEffect(() => {
    resizeWidth.value = boardRailWidth;
  }, [boardRailWidth, resizeWidth]);

  const handleResizeEnd = useCallback(
    (width: number) => {
      setBoardRailWidth(width);
    },
    [setBoardRailWidth],
  );

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = boardRailWidth;
          resizeWidth.value = boardRailWidth;
        })
        .onUpdate((event) => {
          // Dragging the rail's left edge left grows it (negative translation).
          const next = startWidthRef.current - event.translationX;
          resizeWidth.value = clampBoardRailWidth(next);
        })
        .onEnd(() => {
          runOnJS(handleResizeEnd)(resizeWidth.value);
        }),
    [boardRailWidth, handleResizeEnd, resizeWidth],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  return (
    <Animated.View style={[styles.rail, animatedStyle]} testID={testID}>
      <SidebarResizeHandle
        edge="left"
        gesture={resizeGesture}
        testID="mission-control-board-resize-handle"
      />
      <View style={styles.content}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    flexDirection: "row",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
}));
