import type { TicketSummary } from "@getpaseo/protocol/tickets/types";

export interface TicketMove {
  ticketId: string;
  columnId: string;
  /** null = top of the column, undefined = bottom, else directly after that ticket. */
  afterTicketId?: string | null;
}

export function compareTicketPosition(a: TicketSummary, b: TicketSummary): number {
  return a.position - b.position || a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * The same fractional index the board host computes, so the optimistic card
 * lands where the server will put it. `peers` are the other tickets of the
 * target column in display order.
 */
function positionAfter(peers: readonly TicketSummary[], afterTicketId: string | null | undefined) {
  const first = peers[0];
  const last = peers[peers.length - 1];
  if (afterTicketId === null) {
    return first ? first.position - 1 : 0;
  }
  const afterIndex = peers.findIndex((ticket) => ticket.id === afterTicketId);
  const after = peers[afterIndex];
  if (afterTicketId === undefined || !after) {
    return last ? last.position + 1 : 0;
  }
  const next = peers[afterIndex + 1];
  return next ? (after.position + next.position) / 2 : after.position + 1;
}

/** Returns a new list with the move applied, or the same list when it does not hold the ticket. */
export function applyTicketMove(
  tickets: readonly TicketSummary[],
  move: TicketMove,
): readonly TicketSummary[] {
  const moving = tickets.find((ticket) => ticket.id === move.ticketId);
  if (!moving) {
    return tickets;
  }
  const peers = tickets
    .filter((ticket) => ticket.columnId === move.columnId && ticket.id !== move.ticketId)
    .sort(compareTicketPosition);
  const position = positionAfter(peers, move.afterTicketId);
  return tickets.map((ticket) =>
    ticket.id === move.ticketId ? { ...ticket, columnId: move.columnId, position } : ticket,
  );
}

/**
 * `displayed` is the target lane in display order without the dragged card;
 * `index` is the drop slot in it. In the all-projects view a lane mixes
 * columns of several boards, so the anchor is the nearest card above the slot
 * that lives in the real target column.
 */
export function afterTicketIdForDrop(input: {
  displayed: readonly TicketSummary[];
  index: number;
  columnId: string;
}): string | null {
  for (let cursor = Math.min(input.index, input.displayed.length) - 1; cursor >= 0; cursor -= 1) {
    const candidate = input.displayed[cursor];
    if (candidate && candidate.columnId === input.columnId) {
      return candidate.id;
    }
  }
  return null;
}
