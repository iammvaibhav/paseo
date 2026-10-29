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
import { useAppSettings } from "@/hooks/use-settings";
import { useMissionControlLifecycle } from "@/mission-control/use-mission-control-lifecycle";
import { AgentGridDraftTile } from "./draft-tile";
import {
  registerAgentGridScrollHandler,
  registerAgentGridScrollOriginHandler,
  scrollAgentGridIntoView,
} from "./grid-glow";
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
// eslint-disable-next-line complexity -- grid layout resolution, windowing, and tile rendering
export function MissionControlAgentGrid({ isFocused }: { isFocused: boolean }): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const { settings } = useAppSettings();
  const {
    view,
    visibleCount: storedVisibleCount,
    direction: storedDirection,
    snapshotKeys,
    enterGrid,
    clearSnapshot,
    activeKey,
    setActiveKey,
    glowKey,
    draft,
    clearDraft,
    insertSnapshotKey,
    pinSlot,
    setPinSlot,
  } = useAgentGridStore(
    useShallow((state) => ({
      view: state.view,
      visibleCount: state.visibleCount,
      direction: state.direction,
      snapshotKeys: state.snapshotKeys,
      enterGrid: state.enterGrid,
      clearSnapshot: state.clearSnapshot,
      activeKey: state.activeKey,
      setActiveKey: state.setActiveKey,
      glowKey: state.glowKey,
      draft: state.draft,
      clearDraft: state.clearDraft,
      insertSnapshotKey: state.insertSnapshotKey,
      pinSlot: state.pinSlot,
      setPinSlot: state.setPinSlot,
    })),
  );
  const direction = settings?.agentGridDirection ?? storedDirection;
  const configuredVisibleCount = settings?.agentGridVisibleCount ?? storedVisibleCount;
  // A phone shows one tile at a time; the stored count is a desktop preference.
  const visibleCount = isCompact ? 1 : configuredVisibleCount;
  const { rows, isInitialLoad } = useMissionControlLifecycle({ enabled: isFocused });

  const isInGrid = isFocused && view === "grid";
  const wasInGridRef = useRef(false);

  useEffect(() => {
    if (!isInGrid) {
      if (wasInGridRef.current) {
        wasInGridRef.current = false;
        clearSnapshot();
      }
      return;
    }

    if (!wasInGridRef.current) {
      if (isInitialLoad && rows.length === 0) {
        return;
      }
      wasInGridRef.current = true;
      const initialItems = buildAgentGridItems(rows);
      enterGrid(initialItems.map((item) => item.key));
    }
  }, [clearSnapshot, enterGrid, isInitialLoad, isInGrid, rows]);

  useEffect(() => {
    return () => {
      if (wasInGridRef.current) {
        wasInGridRef.current = false;
        clearSnapshot();
      }
    };
  }, [clearSnapshot]);

  // Insert newcomer agent created from draft slot into snapshotKeys at pinSlot
  useEffect(() => {
    if (pinSlot == null || !snapshotKeys) return;
    const knownKeys = new Set(snapshotKeys);
    for (const row of rows) {
      const key = `${row.agent.serverId}:${row.agent.id}`;
      if (!knownKeys.has(key) && row.agent.archivedAt == null) {
        insertSnapshotKey(key, pinSlot);
        setPinSlot(null);
        break;
      }
    }
  }, [insertSnapshotKey, pinSlot, rows, setPinSlot, snapshotKeys]);

  const prevItemsRef = useRef<AgentGridItem[]>(EMPTY_ITEMS);
  const items = useMemo(() => {
    const next = buildAgentGridItems(rows, prevItemsRef.current, snapshotKeys);
    prevItemsRef.current = next;
    return next;
  }, [rows, snapshotKeys]);
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
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollSettleTimeoutRef = useRef<NodeJS.Timeout | number | null>(null);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { x, y } = event.nativeEvent.contentOffset;
    setScroll({ x, y });
    setIsScrolling(true);
    clearTimeout(scrollSettleTimeoutRef.current ?? undefined);
    scrollSettleTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
      scrollSettleTimeoutRef.current = null;
    }, 150);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(scrollSettleTimeoutRef.current ?? undefined);
    };
  }, []);

  const hasDraft = draft !== null;
  const totalItemCount = items.length + (hasDraft ? 1 : 0);

  // Switching axes leaves stale scroll state from the old axis: reset both the
  // tracked offset and the ScrollView's real position so windowing and the
  // visible tiles agree.
  useEffect(() => {
    setScroll(SCROLL_ORIGIN);
    scrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
  }, [direction]);

  useEffect(() => {
    return registerAgentGridScrollOriginHandler(() => {
      setScroll(SCROLL_ORIGIN);
      scrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    });
  }, []);

  const layout = useMemo(
    () =>
      resolveAgentGridLayout({
        itemCount: totalItemCount,
        visibleCount,
        direction,
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
        gap: TILE_GAP,
      }),
    [direction, totalItemCount, viewport, visibleCount],
  );

  useEffect(() => {
    return registerAgentGridScrollHandler((targetKey: string) => {
      scrollAgentGridIntoView({
        scrollView: scrollViewRef.current,
        layout,
        items,
        targetKey,
        viewportWidth: viewport?.width,
        viewportHeight: viewport?.height,
        draftOffset: hasDraft ? 1 : 0,
      });
    });
  }, [hasDraft, items, layout, viewport?.height, viewport?.width]);

  useEffect(() => {
    if (glowKey) {
      scrollAgentGridIntoView({
        scrollView: scrollViewRef.current,
        layout,
        items,
        targetKey: glowKey,
        viewportWidth: viewport?.width,
        viewportHeight: viewport?.height,
        draftOffset: hasDraft ? 1 : 0,
      });
    }
  }, [glowKey, hasDraft, items, layout, viewport?.height, viewport?.width]);

  useEffect(() => {
    if (draft) {
      scrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: true });
    }
  }, [draft]);

  const isHorizontal = direction === "horizontal";
  // The browser clamps the offset when content shrinks (count or direction
  // change) without always emitting a scroll event; clamp the same way.
  const maxOffset = isHorizontal
    ? layout.contentWidth - (viewport?.width ?? 0)
    : layout.contentHeight - (viewport?.height ?? 0);
  const scrollOffset = Math.max(0, Math.min(isHorizontal ? scroll.x : scroll.y, maxOffset));
  const defaultOverscan = isHorizontal ? layout.rows : layout.columns;
  const overscan = isScrolling ? 0 : defaultOverscan;
  const mountWindow = resolveAgentGridWindow(layout, totalItemCount, scrollOffset, overscan);
  const contentStyle = useMemo(
    () => inlineUnistylesStyle({ width: layout.contentWidth, height: layout.contentHeight }),
    [layout.contentHeight, layout.contentWidth],
  );

  return (
    <View style={styles.root} testID="mission-control-agent-grid">
      {totalItemCount === 0 ? (
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
              {viewport ? (
                <>
                  {hasDraft && mountWindow.start === 0 ? (
                    <AgentGridDraftTile
                      key={`draft-${draft.id}`}
                      onClose={clearDraft}
                      prefill={draft}
                      width={layout.tileWidth}
                      height={layout.tileHeight}
                      x={layout.placeTile(0).x}
                      y={layout.placeTile(0).y}
                    />
                  ) : null}
                  {items.map((item, index) => {
                    const slotIndex = hasDraft ? index + 1 : index;
                    const { x, y } = layout.placeTile(slotIndex);
                    const isMounted = slotIndex >= mountWindow.start && slotIndex < mountWindow.end;
                    return isMounted ? (
                      <AgentGridTile
                        key={item.key}
                        item={item}
                        isFocused={isFocused}
                        isActive={item.key === activeKey}
                        onActivate={setActiveKey}
                        glow={item.key === glowKey}
                        width={layout.tileWidth}
                        height={layout.tileHeight}
                        x={x}
                        y={y}
                      />
                    ) : (
                      <AgentGridTilePlaceholder
                        key={item.key}
                        item={item}
                        glow={item.key === glowKey}
                        width={layout.tileWidth}
                        height={layout.tileHeight}
                        x={x}
                        y={y}
                      />
                    );
                  })}
                </>
              ) : null}
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
