import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { clampInspectorWidth, usePanelStore } from "@/stores/panel-store";

interface InspectorRailProps {
  children: ReactNode;
  testID?: string;
  /**
   * When true the rail grows to fill the row instead of its persisted fixed
   * width — used when the Commander thread collapses, so the inspector takes
   * the freed width. A drag on the handle exits flex-fill into fixed width.
   */
  flexFill?: boolean;
}

/**
 * The Mission Control inspector: a fixed-width right column the user drags
 * wider or narrower, matching the board rail's resize pattern. Width is
 * persisted in the panel store (clamped 280–560).
 *
 * The handle sits on the inspector's LEFT edge (against the thread column),
 * not its right: the right edge is shared with the board rail's own
 * left-edge handle, and two overlapping drag handles on one border would
 * fight over the same gesture.
 */
export function InspectorRail({
  children,
  testID = "mission-control-inspector-rail",
  flexFill = false,
}: InspectorRailProps) {
  const inspectorWidth = usePanelStore((state) => state.inspectorWidth);
  const setInspectorWidth = usePanelStore((state) => state.setInspectorWidth);

  const startWidthRef = useRef(inspectorWidth);
  // When the rail is flex-filling, the animated width is overridden. Capture
  // the laid-out width so a drag can leave flex-fill and resume fixed sizing.
  const measuredWidthRef = useRef(inspectorWidth);
  const resizeWidth = useSharedValue(inspectorWidth);
  const [resizePressed, setResizePressed] = useState(false);
  // Sticky until the next flexFill cycle ends: once the user drags out of a
  // flex-fill layout, keep fixed width so the handle remains usable.
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
    resizeWidth.value = inspectorWidth;
  }, [inspectorWidth, resizeWidth]);

  const handleResizeEnd = useCallback(
    (width: number) => {
      setInspectorWidth(width);
    },
    [setInspectorWidth],
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
            startWidthRef.current = inspectorWidth;
            resizeWidth.value = inspectorWidth;
          }
        })
        .onUpdate((event) => {
          // Dragging the inspector's left edge left grows it (negative
          // translation), mirroring the board rail's left-edge math.
          const next = startWidthRef.current - event.translationX;
          resizeWidth.value = clampInspectorWidth(next);
        })
        .onEnd(() => {
          runOnJS(handleResizeEnd)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      beginFlexFillDrag,
      fixedAfterFlexDrag,
      flexFill,
      handleResizeEnd,
      hideResizeGrip,
      inspectorWidth,
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
        testID="mission-control-inspector-resize-handle"
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
