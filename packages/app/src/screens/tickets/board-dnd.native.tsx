import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import {
  StyleSheet as RNStyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { FlatList, Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { StyleSheet } from "react-native-unistyles";
import { OPACITY } from "@/styles/theme";
import {
  BoardDragStoreContext,
  createBoardDragStore,
  IDLE_DRAG_STATE,
  useIsLaneDropTarget,
  useIsTicketDragging,
  useTicketDropIndicator,
} from "./board-drag-state";
import type {
  BoardDndProviderProps,
  BoardEdgeZone,
  DraggableTicketProps,
  DroppableLaneProps,
} from "./board-dnd.types";
import {
  resolveDropTargetFromRects,
  type MeasuredCard,
  type MeasuredLane,
  type MeasuredRect,
} from "./board-drop-geometry";

export type { BoardDndProviderProps, DraggableTicketProps, DroppableLaneProps };
export { FlatList as BoardLaneList, ScrollView as BoardScrollView };

// Long press arms the drag, so a plain swipe still scrolls the lane or the board.
const LONG_PRESS_MS = 320;
const EDGE_ZONE_WIDTH = 48;
// The drop line follows the finger at this cadence; the drop itself re-measures.
const HOVER_INTERVAL_MS = 90;
// Lanes shift under the finger while the board scrolls; re-measure once it settles.
const REMEASURE_AFTER_SCROLL_MS = 400;

interface CardEntry {
  laneKey: string;
  ref: RefObject<View | null>;
  width: number;
}

interface MeasuredLayout {
  lanes: MeasuredLane[];
  cards: MeasuredCard[];
}

interface NativeDnd {
  registerCard(ticketId: string, laneKey: string, ref: RefObject<View | null>): () => void;
  setCardWidth(ticketId: string, width: number): void;
  registerLane(laneKey: string, ref: RefObject<View | null>): () => void;
  begin(ticketId: string): void;
  hover(x: number, y: number): void;
  edge(zone: BoardEdgeZone): void;
  finish(x: number, y: number): void;
  cancel(): void;
  pointerX: SharedValue<number>;
  pointerY: SharedValue<number>;
  grabX: SharedValue<number>;
  grabY: SharedValue<number>;
  edgeZone: SharedValue<number>;
  lastHoverAt: SharedValue<number>;
  windowWidth: SharedValue<number>;
}

const NativeDndContext = createContext<NativeDnd | null>(null);

function useNativeDnd(): NativeDnd {
  const value = useContext(NativeDndContext);
  if (!value) {
    throw new Error("DraggableTicket and DroppableLane must render inside BoardDndProvider");
  }
  return value;
}

function measure(ref: RefObject<View | null>): Promise<MeasuredRect | null> {
  return new Promise((resolve) => {
    const node = ref.current;
    if (!node) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

interface OverlayState {
  ticketId: string;
  width: number;
}

export function BoardDndProvider({
  children,
  renderOverlay,
  onDrop,
  onEdgeZoneChange,
}: BoardDndProviderProps): ReactElement {
  const store = useMemo(createBoardDragStore, []);
  const { width: screenWidth } = useWindowDimensions();
  const rootRef = useRef<View>(null);
  const cardsRef = useRef(new Map<string, CardEntry>());
  const lanesRef = useRef(new Map<string, RefObject<View | null>>());
  const layoutRef = useRef<MeasuredLayout>({ lanes: [], cards: [] });
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onEdgeZoneChangeRef = useRef(onEdgeZoneChange);
  onEdgeZoneChangeRef.current = onEdgeZoneChange;
  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  const pointerX = useSharedValue(0);
  const pointerY = useSharedValue(0);
  const grabX = useSharedValue(0);
  const grabY = useSharedValue(0);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const edgeZone = useSharedValue(0);
  const lastHoverAt = useSharedValue(0);
  const windowWidth = useSharedValue(screenWidth);

  useEffect(() => {
    windowWidth.value = screenWidth;
  }, [screenWidth, windowWidth]);

  useEffect(() => () => clearTimeout(remeasureTimerRef.current ?? undefined), []);

  const api = useMemo((): NativeDnd => {
    async function measureLayout(): Promise<MeasuredLayout> {
      const laneEntries = [...lanesRef.current.entries()];
      const cardEntries = [...cardsRef.current.entries()];
      const laneRects = await Promise.all(laneEntries.map(([, ref]) => measure(ref)));
      const cardRects = await Promise.all(cardEntries.map(([, entry]) => measure(entry.ref)));
      const lanes: MeasuredLane[] = [];
      laneEntries.forEach(([laneKey], index) => {
        const rect = laneRects[index];
        if (rect) lanes.push({ laneKey, rect });
      });
      const cards: MeasuredCard[] = [];
      cardEntries.forEach(([ticketId, entry], index) => {
        const rect = cardRects[index];
        if (rect) cards.push({ ticketId, laneKey: entry.laneKey, rect });
      });
      return { lanes, cards };
    }

    function reset() {
      store.set(IDLE_DRAG_STATE);
      setOverlay(null);
      onEdgeZoneChangeRef.current?.(0);
    }

    async function trackOrigin() {
      const rect = await measure(rootRef);
      originX.value = rect?.x ?? 0;
      originY.value = rect?.y ?? 0;
    }

    async function remeasure() {
      layoutRef.current = await measureLayout();
    }

    return {
      registerCard(ticketId, laneKey, ref) {
        const width = cardsRef.current.get(ticketId)?.width ?? 0;
        cardsRef.current.set(ticketId, { laneKey, ref, width });
        return () => {
          if (cardsRef.current.get(ticketId)?.ref === ref) {
            cardsRef.current.delete(ticketId);
          }
        };
      },
      setCardWidth(ticketId, width) {
        const entry = cardsRef.current.get(ticketId);
        if (entry) entry.width = width;
      },
      registerLane(laneKey, ref) {
        lanesRef.current.set(laneKey, ref);
        return () => {
          if (lanesRef.current.get(laneKey) === ref) {
            lanesRef.current.delete(laneKey);
          }
        };
      },
      begin(ticketId) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        store.set({ activeTicketId: ticketId, target: null });
        setOverlay({ ticketId, width: cardsRef.current.get(ticketId)?.width ?? 0 });
        void trackOrigin();
        void remeasure();
      },
      hover(x, y) {
        const current = store.get();
        if (current.activeTicketId === null) return;
        const target = resolveDropTargetFromRects({ ...layoutRef.current, x, y });
        store.set({ ...current, target });
      },
      edge(zone) {
        onEdgeZoneChangeRef.current?.(zone);
        clearTimeout(remeasureTimerRef.current ?? undefined);
        remeasureTimerRef.current = setTimeout(() => {
          void remeasure();
        }, REMEASURE_AFTER_SCROLL_MS);
      },
      finish(x, y) {
        const ticketId = store.get().activeTicketId;
        void drop();
        async function drop() {
          const layout = await measureLayout();
          const target = resolveDropTargetFromRects({ ...layout, x, y });
          reset();
          if (ticketId !== null && target !== null) {
            onDropRef.current(ticketId, target);
          }
        }
      },
      cancel: reset,
      pointerX,
      pointerY,
      grabX,
      grabY,
      edgeZone,
      lastHoverAt,
      windowWidth,
    };
  }, [
    edgeZone,
    grabX,
    grabY,
    lastHoverAt,
    originX,
    originY,
    pointerX,
    pointerY,
    store,
    windowWidth,
  ]);

  const overlayStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: pointerX.value - originX.value - grabX.value },
      { translateY: pointerY.value - originY.value - grabY.value },
    ],
  }));

  return (
    <BoardDragStoreContext.Provider value={store}>
      <NativeDndContext.Provider value={api}>
        <View ref={rootRef} collapsable={false} style={nativeStyles.root}>
          {children}
          {overlay ? (
            <Animated.View
              pointerEvents="none"
              style={[nativeStyles.overlay, { width: overlay.width }, overlayStyle]}
            >
              {renderOverlay(overlay.ticketId)}
            </Animated.View>
          ) : null}
        </View>
      </NativeDndContext.Provider>
    </BoardDragStoreContext.Provider>
  );
}

export function DraggableTicket({
  ticketId,
  laneKey,
  children,
}: DraggableTicketProps): ReactElement {
  const api = useNativeDnd();
  const ref = useRef<View>(null);
  const isDragging = useIsTicketDragging(ticketId);
  const indicator = useTicketDropIndicator(ticketId);
  const { registerCard, setCardWidth } = api;

  useEffect(() => registerCard(ticketId, laneKey, ref), [laneKey, registerCard, ticketId]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setCardWidth(ticketId, event.nativeEvent.layout.width),
    [setCardWidth, ticketId],
  );

  const gesture = useMemo(() => {
    const { begin, hover, edge, finish, cancel } = api;
    const { pointerX, pointerY, grabX, grabY, edgeZone, lastHoverAt, windowWidth } = api;
    return Gesture.Pan()
      .activateAfterLongPress(LONG_PRESS_MS)
      .onStart((event) => {
        grabX.value = event.x;
        grabY.value = event.y;
        pointerX.value = event.absoluteX;
        pointerY.value = event.absoluteY;
        edgeZone.value = 0;
        scheduleOnRN(begin, ticketId);
      })
      .onUpdate((event) => {
        pointerX.value = event.absoluteX;
        pointerY.value = event.absoluteY;
        let zone: BoardEdgeZone = 0;
        if (event.absoluteX < EDGE_ZONE_WIDTH) {
          zone = -1;
        } else if (event.absoluteX > windowWidth.value - EDGE_ZONE_WIDTH) {
          zone = 1;
        }
        if (zone !== edgeZone.value) {
          edgeZone.value = zone;
          scheduleOnRN(edge, zone);
        }
        const now = Date.now();
        if (now - lastHoverAt.value > HOVER_INTERVAL_MS) {
          lastHoverAt.value = now;
          scheduleOnRN(hover, event.absoluteX, event.absoluteY);
        }
      })
      .onEnd((event, success) => {
        if (success) {
          scheduleOnRN(finish, event.absoluteX, event.absoluteY);
        } else {
          scheduleOnRN(cancel);
        }
      });
  }, [api, ticketId]);

  const showBefore = indicator === "before" && !isDragging;
  const showAfter = indicator === "after" && !isDragging;

  return (
    <GestureDetector gesture={gesture}>
      <View
        ref={ref}
        collapsable={false}
        onLayout={handleLayout}
        style={isDragging ? nativeStyles.dragged : nativeStyles.card}
      >
        {showBefore ? <View style={styles.dropLineBefore} pointerEvents="none" /> : null}
        {children}
        {showAfter ? <View style={styles.dropLineAfter} pointerEvents="none" /> : null}
      </View>
    </GestureDetector>
  );
}

export function DroppableLane({ laneKey, children, style }: DroppableLaneProps): ReactElement {
  const { registerLane } = useNativeDnd();
  const ref = useRef<View>(null);
  const isTarget = useIsLaneDropTarget(laneKey);

  useEffect(() => registerLane(laneKey, ref), [laneKey, registerLane]);

  return (
    <View ref={ref} collapsable={false} style={[style, isTarget ? styles.laneTarget : null]}>
      {children}
    </View>
  );
}

// Plain React Native styles: Reanimated animates the overlay node, and a
// Unistyles style on the same node crashes on theme change (docs/unistyles.md).
const nativeStyles = RNStyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  overlay: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  card: {
    position: "relative",
  },
  dragged: {
    position: "relative",
    opacity: OPACITY[50],
  },
});

const styles = StyleSheet.create((theme) => ({
  // Centred in the gap between two cards; absolute, so the list never reflows.
  dropLineBefore: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -(theme.spacing[1] + theme.borderWidth[1]),
    height: theme.borderWidth[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  dropLineAfter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: -(theme.spacing[1] + theme.borderWidth[1]),
    height: theme.borderWidth[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  laneTarget: {
    backgroundColor: theme.colors.interactionHighlight,
  },
}));
