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
   * the freed width (spec: no dead space in any collapse combo).
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
  const resizeWidth = useSharedValue(inspectorWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = inspectorWidth;
  }, [inspectorWidth, resizeWidth]);

  const handleResizeEnd = useCallback(
    (width: number) => {
      setInspectorWidth(width);
    },
    [setInspectorWidth],
  );

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!flexFill)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        .onStart(() => {
          startWidthRef.current = inspectorWidth;
          resizeWidth.value = inspectorWidth;
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
    [flexFill, handleResizeEnd, hideResizeGrip, inspectorWidth, resizeWidth, showResizeGrip],
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
