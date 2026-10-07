import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ScrollView,
  StyleSheet,
  type ScrollViewProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from "react-native";
import Animated from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { useGlassTreatment } from "@/appearance/glass";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export interface FloatingSurfaceProps extends Omit<ComponentProps<typeof Animated.View>, "style"> {
  frameStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}

export const FloatingSurface = forwardRef<View, FloatingSurfaceProps>(function FloatingSurface(
  { frameStyle, style, ...props },
  ref,
): ReactElement {
  const inlineFrameStyle = useMemo(() => {
    const flattened = StyleSheet.flatten(frameStyle);
    return flattened ? inlineUnistylesStyle(stripUnistylesMetadata(flattened)) : undefined;
  }, [frameStyle]);
  const nodeRef = useRef<View | null>(null);
  const setRef = useCallback(
    (node: View | null) => {
      nodeRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );
  const glass = useGlassTreatment();
  const overWebview = useOverlapsWebview(nodeRef, inlineFrameStyle, glass !== null);
  // The glass fill is inline so it wins over the caller's fill, often a light wash that would
  // leave the surface nearly clear; on web, stylesheet classes resolve by insertion order, not
  // array order. Over a webview the frost has nothing to blur, so the fill is dense.
  const surfaceStyle = useMemo(() => {
    if (!glass) return appendStyle(style, inlineFrameStyle);
    const glassFill = inlineUnistylesStyle({
      backgroundColor: overWebview ? glass.overlay : glass.floating,
      borderColor: glass.floatingBorder,
      backdropFilter: glass.floatingBackdropFilter,
      ...inlineFrameStyle,
    } as ViewStyle);
    return appendStyle(style, glassFill);
  }, [glass, inlineFrameStyle, overWebview, style]);
  return <Animated.View {...props} ref={setRef} style={surfaceStyle} />;
});

function assignRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * Whether the surface sits over an embedded browser pane (`<webview>`, such as VS Code Web).
 * A glass surface's frost cannot blur a webview's content, so there it needs a dense fill.
 * Re-checked whenever the surface moves.
 */
function useOverlapsWebview(
  nodeRef: { current: View | null },
  position: unknown,
  enabled: boolean,
): boolean {
  const [overlaps, setOverlaps] = useState(false);
  useLayoutEffect(() => {
    if (!isWeb || !enabled) return;
    const node = nodeRef.current as unknown;
    if (!(node instanceof HTMLElement)) return;
    const rect = node.getBoundingClientRect();
    const next = Array.from(document.querySelectorAll("webview")).some((webview) => {
      const other = webview.getBoundingClientRect();
      return (
        other.width > 0 &&
        other.height > 0 &&
        rect.left < other.right &&
        rect.right > other.left &&
        rect.top < other.bottom &&
        rect.bottom > other.top
      );
    });
    setOverlaps(next);
  }, [enabled, nodeRef, position]);
  return overlaps;
}

export interface FloatingScrollViewProps {
  bounces?: boolean;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
  showsVerticalScrollIndicator?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function FloatingScrollView({
  bounces,
  children,
  contentContainerStyle,
  keyboardShouldPersistTaps,
  showsVerticalScrollIndicator,
  style,
}: FloatingScrollViewProps): ReactElement {
  const inlineStyle = useMemo(() => {
    const flattened = StyleSheet.flatten(style);
    return flattened ? inlineUnistylesStyle(stripUnistylesMetadata(flattened)) : undefined;
  }, [style]);

  return (
    <ScrollView
      bounces={bounces}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      style={inlineStyle}
    >
      {children}
    </ScrollView>
  );
}

function appendStyle(
  style: StyleProp<ViewStyle>,
  extraStyle: ViewStyle | undefined,
): StyleProp<ViewStyle> {
  if (!extraStyle) {
    return style;
  }
  if (Array.isArray(style)) {
    return [...style, extraStyle];
  }
  return [style, extraStyle];
}

function stripUnistylesMetadata(style: ViewStyle): ViewStyle {
  const cleanStyle: Record<string, unknown> = { ...style };
  for (const key of Object.keys(cleanStyle)) {
    if (key.startsWith("unistyles_")) {
      delete cleanStyle[key];
    }
  }
  return cleanStyle as ViewStyle;
}
