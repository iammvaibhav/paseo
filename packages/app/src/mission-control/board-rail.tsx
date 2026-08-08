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
  /**
   * When true the rail grows to fill the row instead of its persisted fixed
   * width — used when the Commander thread collapses with no inspector open,
   * so no dead space appears (spec: no dead space in any collapse combo).
   */
  flexFill?: boolean;
}

/**
 * The Mission Control board rail: a fixed-width right column the user drags
 * wider or narrower. Width is persisted in the panel store (clamped 240–480)
 * so the rail comes back where the user left it, matching the sidebar's
 * resize pattern.
 */
export function BoardRail({
  children,
  testID = "mission-control-board-rail",
  flexFill = false,
}: BoardRailProps) {
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
        .enabled(!flexFill)
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
    [boardRailWidth, flexFill, handleResizeEnd, resizeWidth],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  return (
    <Animated.View
      style={[styles.rail, animatedStyle, flexFill ? styles.railFill : null]}
      testID={testID}
    >
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
  // flex: 1 makes flexBasis 0, which overrides the animated width — the rail
  // fills the row when the collapsed thread leaves it free space.
  railFill: {
    flex: 1,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
}));
