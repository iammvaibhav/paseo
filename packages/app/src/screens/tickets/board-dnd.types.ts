import type { ReactElement, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { BoardDropTarget } from "./board-drag-state";

export type BoardEdgeZone = -1 | 0 | 1;

export interface BoardDndProviderProps {
  children: ReactNode;
  /** The card that follows the pointer while a drag is active. */
  renderOverlay: (ticketId: string) => ReactElement | null;
  onDrop: (ticketId: string, target: BoardDropTarget) => void;
  /**
   * Native only: the finger rests near the left (-1) or right (1) screen edge,
   * or left it (0). The board scrolls its lanes; the web auto-scrolls itself.
   */
  onEdgeZoneChange?: (zone: BoardEdgeZone) => void;
}

export interface DraggableTicketProps {
  ticketId: string;
  laneKey: string;
  children: ReactNode;
}

export interface DroppableLaneProps {
  laneKey: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}
