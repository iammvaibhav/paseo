import type { BoardDropTarget } from "./board-drag-state";

export interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeasuredLane {
  laneKey: string;
  rect: MeasuredRect;
}

export interface MeasuredCard {
  ticketId: string;
  laneKey: string;
  rect: MeasuredRect;
}

/**
 * Native drops resolve from window-space rects measured at drop time. The lane
 * is the one under the finger's x; the slot is before the first card whose
 * middle lies below the finger. Off-screen rendered cards still measure, so a
 * drop below the viewport edge of a long lane lands in the right place.
 */
export function resolveDropTargetFromRects(input: {
  lanes: readonly MeasuredLane[];
  cards: readonly MeasuredCard[];
  x: number;
  y: number;
}): BoardDropTarget | null {
  const lane = input.lanes.find(
    (candidate) =>
      candidate.rect.width > 0 &&
      input.x >= candidate.rect.x &&
      input.x <= candidate.rect.x + candidate.rect.width,
  );
  if (!lane) {
    return null;
  }
  const cards = input.cards
    .filter((card) => card.laneKey === lane.laneKey && card.rect.height > 0)
    .sort((a, b) => a.rect.y - b.rect.y);
  const below = cards.find((card) => input.y < card.rect.y + card.rect.height / 2);
  if (below) {
    return { laneKey: lane.laneKey, ticketId: below.ticketId, placement: "before" };
  }
  const last = cards[cards.length - 1];
  if (last) {
    return { laneKey: lane.laneKey, ticketId: last.ticketId, placement: "after" };
  }
  return { laneKey: lane.laneKey, ticketId: null, placement: "after" };
}
