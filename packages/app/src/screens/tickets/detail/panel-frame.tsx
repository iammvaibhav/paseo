import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { StyleSheet as RNStyleSheet, View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { isNative } from "@/constants/platform";
import {
  MAX_TICKET_PANEL_WIDTH,
  MIN_TICKET_PANEL_WIDTH,
  useTicketPanelWidthStore,
} from "./panel-width";

interface FrameProps {
  children: ReactNode;
}

/**
 * Desktop: a right-docked panel over the board. The handle sits on the left
 * edge; dragging it left makes the panel wider. The width is persisted.
 */
export function DesktopTicketPanelFrame({ children }: FrameProps): ReactElement {
  const width = useTicketPanelWidthStore((state) => state.width);
  const setWidth = useTicketPanelWidthStore((state) => state.setWidth);
  const startWidthRef = useRef(width);
  const resizeWidth = useSharedValue(width);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = width;
  }, [resizeWidth, width]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        .onStart(() => {
          startWidthRef.current = width;
          resizeWidth.value = width;
        })
        .onUpdate((event) => {
          // The clamp is inlined: this callback runs as a worklet.
          const next = startWidthRef.current - event.translationX;
          resizeWidth.value = Math.max(
            MIN_TICKET_PANEL_WIDTH,
            Math.min(MAX_TICKET_PANEL_WIDTH, next),
          );
        })
        .onEnd(() => {
          runOnJS(setWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [hideResizeGrip, resizeWidth, setWidth, showResizeGrip, width],
  );

  const animatedWidth = useAnimatedStyle(() => ({ width: resizeWidth.value }));

  return (
    <Animated.View style={[frameLayout.desktop, animatedWidth]} testID="ticket-detail-panel">
      <View style={styles.desktopSurface}>{children}</View>
      <SidebarResizeHandle
        edge="left"
        gesture={resizeGesture}
        pressed={resizePressed}
        testID="ticket-detail-resize-handle"
      />
    </Animated.View>
  );
}

/** Compact: a full-screen sheet over the screen that opened it. */
export function CompactTicketSheetFrame({ children }: FrameProps): ReactElement {
  const { style: keyboardPadding } = useKeyboardShiftStyle({ mode: "padding", enabled: isNative });
  return (
    <View style={styles.compactRoot} testID="ticket-detail-sheet">
      <Animated.View style={[frameLayout.fill, keyboardPadding]}>{children}</Animated.View>
    </View>
  );
}

// Plain React Native styles: Reanimated views must not carry theme styles
// (see docs/unistyles.md). The themed paint is on the inner views.
const frameLayout = RNStyleSheet.create({
  desktop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
  },
  fill: {
    flex: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  desktopSurface: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
  compactRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface0,
  },
}));
