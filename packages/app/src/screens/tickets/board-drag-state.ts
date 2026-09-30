import { createContext, useContext, useSyncExternalStore } from "react";

/** `ticketId` null = the end of the lane. */
export interface BoardDropTarget {
  laneKey: string;
  ticketId: string | null;
  placement: "before" | "after";
}

export interface BoardDragState {
  activeTicketId: string | null;
  target: BoardDropTarget | null;
}

export interface BoardDragStore {
  get(): BoardDragState;
  set(next: BoardDragState): void;
  subscribe(listener: () => void): () => void;
}

export const IDLE_DRAG_STATE: BoardDragState = { activeTicketId: null, target: null };

function isSameTarget(a: BoardDropTarget | null, b: BoardDropTarget | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.laneKey === b.laneKey && a.ticketId === b.ticketId && a.placement === b.placement;
}

/**
 * Drag state changes on every pointer move. Cards read it through narrow
 * selectors, so only the card under the pointer re-renders.
 */
export function createBoardDragStore(): BoardDragStore {
  let state = IDLE_DRAG_STATE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (next.activeTicketId === state.activeTicketId && isSameTarget(next.target, state.target)) {
        return;
      }
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const BoardDragStoreContext = createContext<BoardDragStore | null>(null);

function useBoardDragStore(): BoardDragStore {
  const store = useContext(BoardDragStoreContext);
  if (!store) {
    throw new Error("Board drag hooks must render inside BoardDndProvider");
  }
  return store;
}

export function useIsTicketDragging(ticketId: string): boolean {
  const store = useBoardDragStore();
  return useSyncExternalStore(store.subscribe, () => store.get().activeTicketId === ticketId);
}

/** Where the drop line shows around this card, if the pointer targets it. */
export function useTicketDropIndicator(ticketId: string): BoardDropTarget["placement"] | null {
  const store = useBoardDragStore();
  return useSyncExternalStore(store.subscribe, () => {
    const target = store.get().target;
    return target?.ticketId === ticketId ? target.placement : null;
  });
}

export function useIsLaneDropTarget(laneKey: string): boolean {
  const store = useBoardDragStore();
  return useSyncExternalStore(store.subscribe, () => store.get().target?.laneKey === laneKey);
}
