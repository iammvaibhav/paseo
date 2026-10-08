import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { FlatList, ScrollView, View } from "react-native";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { StyleSheet } from "react-native-unistyles";
import { OPACITY } from "@/styles/theme";
import {
  BoardDragStoreContext,
  createBoardDragStore,
  IDLE_DRAG_STATE,
  useIsLaneDropTarget,
  useIsTicketDragging,
  useTicketDropIndicator,
  type BoardDropTarget,
} from "./board-drag-state";
import type {
  BoardDndProviderProps,
  DraggableTicketProps,
  DroppableLaneProps,
} from "./board-dnd.types";

export type { BoardDndProviderProps, DraggableTicketProps, DroppableLaneProps };
export { FlatList as BoardLaneList, ScrollView as BoardScrollView };

const CARD_PREFIX = "card:";
const LANE_PREFIX = "lane:";
const DRAG_PREFIX = "drag:";
// A press shorter than this is a click that opens the ticket, not a drag.
const MOUSE_ACTIVATION = { distance: 6 };
const TOUCH_ACTIVATION = { delay: 180, tolerance: 8 };
// The raw div sits between React Native Web flex boxes; without an explicit
// full-width flex column the card inside shrinks to its content width.
const CARD_STYLE = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignSelf: "stretch",
  width: "100%",
} as const;
const DRAGGED_CARD_STYLE = { ...CARD_STYLE, opacity: OPACITY[50] } as const;

// A card under the pointer wins over the lane around it, so the drop line
// sits between two cards instead of at the lane end.
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const card = hits.find((hit) => String(hit.id).startsWith(CARD_PREFIX));
  return card ? [card] : hits.slice(0, 1);
};

function readTarget(
  event: DragMoveEvent | DragEndEvent,
  pointerY: number | null,
): BoardDropTarget | null {
  const { over } = event;
  const data = over?.data.current;
  const laneKey = data?.laneKey;
  if (!over || typeof laneKey !== "string") {
    return null;
  }
  const ticketId = data?.ticketId;
  if (typeof ticketId !== "string") {
    return { laneKey, ticketId: null, placement: "after" };
  }
  const middle = over.rect.top + over.rect.height / 2;
  const placement = pointerY !== null && pointerY > middle ? "after" : "before";
  return { laneKey, ticketId, placement };
}

export function BoardDndProvider({
  children,
  renderOverlay,
  onDrop,
}: BoardDndProviderProps): ReactElement {
  const store = useMemo(createBoardDragStore, []);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  // dnd-kit reports a scroll-adjusted delta, not the pointer, so the drop half
  // (above or below a card's middle) reads the pointer directly.
  const pointerYRef = useRef<number | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_ACTIVATION }),
  );

  useEffect(() => {
    if (activeTicketId === null) {
      return undefined;
    }
    function trackPointer(event: PointerEvent) {
      pointerYRef.current = event.clientY;
    }
    window.addEventListener("pointermove", trackPointer, { capture: true });
    return () => window.removeEventListener("pointermove", trackPointer, { capture: true });
  }, [activeTicketId]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const ticketId = event.active.data.current?.ticketId;
      if (typeof ticketId !== "string") {
        return;
      }
      pointerYRef.current = null;
      setActiveTicketId(ticketId);
      store.set({ activeTicketId: ticketId, target: null });
    },
    [store],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const current = store.get();
      store.set({ ...current, target: readTarget(event, pointerYRef.current) });
    },
    [store],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const ticketId = store.get().activeTicketId;
      const target = readTarget(event, pointerYRef.current);
      store.set(IDLE_DRAG_STATE);
      setActiveTicketId(null);
      if (ticketId !== null && target !== null) {
        onDrop(ticketId, target);
      }
    },
    [onDrop, store],
  );

  const handleDragCancel = useCallback(() => {
    store.set(IDLE_DRAG_STATE);
    setActiveTicketId(null);
  }, [store]);

  return (
    <BoardDragStoreContext.Provider value={store}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeTicketId === null ? null : renderOverlay(activeTicketId)}
        </DragOverlay>
      </DndContext>
    </BoardDragStoreContext.Provider>
  );
}

export function DraggableTicket({
  ticketId,
  laneKey,
  children,
}: DraggableTicketProps): ReactElement {
  const isDragging = useIsTicketDragging(ticketId);
  const indicator = useTicketDropIndicator(ticketId);
  const draggable = useDraggable({ id: DRAG_PREFIX + ticketId, data: { ticketId } });
  // The dragged card stays a drop target: releasing on its own slot is a no-op,
  // not a move to the end of the lane under it.
  const droppable = useDroppable({ id: CARD_PREFIX + ticketId, data: { laneKey, ticketId } });
  const setDragNode = draggable.setNodeRef;
  const setDropNode = droppable.setNodeRef;
  const setNode = useCallback(
    (node: HTMLDivElement | null) => {
      setDragNode(node);
      setDropNode(node);
    },
    [setDragNode, setDropNode],
  );
  const showBefore = indicator === "before" && !isDragging;
  const showAfter = indicator === "after" && !isDragging;

  // Only the pointer listeners: the card inside is the button, and no
  // keyboard sensor is registered, so dnd-kit's role/tabIndex would add a
  // second, dead focus stop around it.
  return (
    <div
      ref={setNode}
      {...draggable.listeners}
      style={isDragging ? DRAGGED_CARD_STYLE : CARD_STYLE}
    >
      {showBefore ? <View style={styles.dropLineBefore} pointerEvents="none" /> : null}
      {children}
      {showAfter ? <View style={styles.dropLineAfter} pointerEvents="none" /> : null}
    </div>
  );
}

export function DroppableLane({ laneKey, children, style }: DroppableLaneProps): ReactElement {
  const isTarget = useIsLaneDropTarget(laneKey);
  const { setNodeRef } = useDroppable({ id: LANE_PREFIX + laneKey, data: { laneKey } });
  return (
    <View
      ref={setNodeRef as unknown as Ref<View>}
      style={[style, isTarget ? styles.laneTarget : null]}
    >
      {children}
    </View>
  );
}

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
