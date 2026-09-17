import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { SPACING } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useMissionControlLifecycle } from "@/mission-control/use-mission-control-lifecycle";
import { buildAgentGridItems, type AgentGridItem } from "./items";
import { resolveAgentGridLayout, resolveAgentGridWindow } from "./layout";
import { useAgentGridStore } from "./store";
import { AgentGridTile, AgentGridTilePlaceholder } from "./tile";

const TILE_GAP = SPACING[2];
const EMPTY_ITEMS: AgentGridItem[] = [];

interface Viewport {
  width: number;
  height: number;
}

interface ScrollPosition {
  x: number;
  y: number;
}

const SCROLL_ORIGIN: ScrollPosition = { x: 0, y: 0 };

/**
 * Fleet-wide grid of agent tiles: Running first, then Ready for review.
 * `visibleCount` tiles fill the viewport; the rest scroll in along
 * `direction`. Only tiles inside the viewport window (plus one line of
 * overscan on each side) mount their stream; the others are placeholders.
 */
export function MissionControlAgentGrid({ isFocused }: { isFocused: boolean }): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const { visibleCount: storedVisibleCount, direction } = useAgentGridStore(
    useShallow((state) => ({ visibleCount: state.visibleCount, direction: state.direction })),
  );
  // A phone shows one tile at a time; the stored count is a desktop preference.
  const visibleCount = isCompact ? 1 : storedVisibleCount;

  const { rows } = useMissionControlLifecycle({ enabled: isFocused });
  const prevItemsRef = useRef<AgentGridItem[]>(EMPTY_ITEMS);
  const items = useMemo(() => {
    const next = buildAgentGridItems(rows, prevItemsRef.current);
    prevItemsRef.current = next;
    return next;
  }, [rows]);

  // The last positive measurement. A hidden retained surface reports zero
  // and must not collapse the grid.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) {
      return;
    }
    setViewport((current) =>
      current && current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  const scrollViewRef = useRef<ScrollView>(null);
  const [scroll, setScroll] = useState<ScrollPosition>(SCROLL_ORIGIN);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { x, y } = event.nativeEvent.contentOffset;
    setScroll({ x, y });
  }, []);

  // Switching axes leaves stale scroll state from the old axis: reset both the
  // tracked offset and the ScrollView's real position so windowing and the
  // visible tiles agree.
  useEffect(() => {
    setScroll(SCROLL_ORIGIN);
    scrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
  }, [direction]);

  const [activeKey, setActiveKey] = useState<string | null>(null);

  const layout = useMemo(
    () =>
      resolveAgentGridLayout({
        itemCount: items.length,
        visibleCount,
        direction,
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
        gap: TILE_GAP,
      }),
    [direction, items.length, viewport, visibleCount],
  );

  const isHorizontal = direction === "horizontal";
  // The browser clamps the offset when content shrinks (count or direction
  // change) without always emitting a scroll event; clamp the same way.
  const maxOffset = isHorizontal
    ? layout.contentWidth - (viewport?.width ?? 0)
    : layout.contentHeight - (viewport?.height ?? 0);
  const scrollOffset = Math.max(0, Math.min(isHorizontal ? scroll.x : scroll.y, maxOffset));
  const overscan = isHorizontal ? layout.rows : layout.columns;
  const mountWindow = resolveAgentGridWindow(layout, items.length, scrollOffset, overscan);

  const contentStyle = useMemo(
    () => inlineUnistylesStyle({ width: layout.contentWidth, height: layout.contentHeight }),
    [layout.contentHeight, layout.contentWidth],
  );

  return (
    <View style={styles.root} testID="mission-control-agent-grid">
      {items.length === 0 ? (
        <View style={styles.empty} testID="mission-control-agent-grid-empty">
          <Text style={styles.emptyText}>No running or ready-for-review agents</Text>
        </View>
      ) : (
        <View style={styles.viewport} onLayout={handleLayout}>
          <ScrollView
            ref={scrollViewRef}
            horizontal={isHorizontal}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            style={styles.scroll}
            testID="mission-control-agent-grid-scroll"
          >
            <View style={contentStyle}>
              {viewport
                ? items.map((item, index) => {
                    const { x, y } = layout.placeTile(index);
                    const isMounted = index >= mountWindow.start && index < mountWindow.end;
                    return isMounted ? (
                      <AgentGridTile
                        key={item.key}
                        item={item}
                        isFocused={isFocused}
                        isActive={item.key === activeKey}
                        onActivate={setActiveKey}
                        width={layout.tileWidth}
                        height={layout.tileHeight}
                        x={x}
                        y={y}
                      />
                    ) : (
                      <AgentGridTilePlaceholder
                        key={item.key}
                        item={item}
                        width={layout.tileWidth}
                        height={layout.tileHeight}
                        x={x}
                        y={y}
                      />
                    );
                  })
                : null}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minWidth: 0,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  viewport: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
