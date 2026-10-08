import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
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
  const measuredWidthRef = useRef(boardRailWidth);
  const resizeWidth = useSharedValue(boardRailWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const [fixedAfterFlexDrag, setFixedAfterFlexDrag] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  const useFlexFill = flexFill && !fixedAfterFlexDrag;

  useEffect(() => {
    if (!flexFill) {
      setFixedAfterFlexDrag(false);
    }
  }, [flexFill]);

  useEffect(() => {
    resizeWidth.value = boardRailWidth;
  }, [boardRailWidth, resizeWidth]);

  const handleResizeEnd = useCallback(
    (width: number) => {
      setBoardRailWidth(width);
    },
    [setBoardRailWidth],
  );

  const beginFlexFillDrag = useCallback(() => {
    setFixedAfterFlexDrag(true);
  }, []);

  const handleLayout = useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) {
      measuredWidthRef.current = width;
    }
  }, []);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        .onStart(() => {
          if (flexFill && !fixedAfterFlexDrag) {
            const measured = measuredWidthRef.current;
            startWidthRef.current = measured;
            resizeWidth.value = measured;
            runOnJS(beginFlexFillDrag)();
          } else {
            startWidthRef.current = boardRailWidth;
            resizeWidth.value = boardRailWidth;
          }
        })
        .onUpdate((event) => {
          // Dragging the rail's left edge left grows it (negative translation).
          const next = startWidthRef.current - event.translationX;
          resizeWidth.value = clampBoardRailWidth(next);
        })
        .onEnd(() => {
          runOnJS(handleResizeEnd)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      beginFlexFillDrag,
      boardRailWidth,
      fixedAfterFlexDrag,
      flexFill,
      handleResizeEnd,
      hideResizeGrip,
      resizeWidth,
      showResizeGrip,
    ],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  return (
    <Animated.View
      onLayout={handleLayout}
      style={[styles.rail, animatedStyle, useFlexFill ? styles.railFill : null]}
      testID={testID}
    >
      <SidebarResizeHandle
        edge="left"
        gesture={resizeGesture}
        pressed={resizePressed}
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
