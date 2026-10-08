import type {
  TicketBoard,
  TicketColumn,
  TicketColumnStateType,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { afterTicketIdForDrop, compareTicketPosition, type TicketMove } from "@/tickets/ordering";
import type { BoardDropTarget } from "./board-drag-state";

/**
 * One vertical lane on screen. On a single board a lane is one column. In the
 * all-projects view a lane gathers the same-named column of every board.
 */
export interface BoardLane {
  key: string;
  name: string;
  stateType: TicketColumnStateType;
  /** The real column of each board that this lane stands for. */
  columnByBoardId: ReadonlyMap<string, TicketColumn>;
  tickets: TicketSummary[];
}

export type DropResolution =
  | { kind: "move"; move: TicketMove }
  | { kind: "unchanged" }
  | { kind: "no_column"; laneName: string; boardId: string };

const STATE_ORDER: Record<TicketColumnStateType, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 4,
};

function sortedColumns(board: TicketBoard): TicketColumn[] {
  return [...board.columns].sort((a, b) => a.position - b.position);
}

function laneKeyForName(name: string): string {
  return `name:${name.trim().toLocaleLowerCase()}`;
}

export function buildBoardLanes(input: {
  boards: readonly TicketBoard[];
  /** null = the all-projects view. */
  boardId: string | null;
  tickets: readonly TicketSummary[];
}): BoardLane[] {
  const lanes: BoardLane[] = [];
  const laneByColumnId = new Map<string, BoardLane>();

  if (input.boardId !== null) {
    const board = input.boards.find((candidate) => candidate.id === input.boardId);
    for (const column of board ? sortedColumns(board) : []) {
      const lane: BoardLane = {
        key: column.id,
        name: column.name,
        stateType: column.stateType,
        columnByBoardId: new Map([[column.boardId, column]]),
        tickets: [],
      };
      lanes.push(lane);
      laneByColumnId.set(column.id, lane);
    }
  } else {
    const laneByName = new Map<
      string,
      BoardLane & { columnByBoardId: Map<string, TicketColumn> }
    >();
    for (const board of input.boards) {
      if (board.archivedAt !== null) continue;
      for (const column of sortedColumns(board)) {
        const key = laneKeyForName(column.name);
        let lane = laneByName.get(key);
        if (!lane) {
          lane = {
            key,
            name: column.name,
            stateType: column.stateType,
            columnByBoardId: new Map(),
            tickets: [],
          };
          laneByName.set(key, lane);
          lanes.push(lane);
        }
        lane.columnByBoardId.set(board.id, column);
        laneByColumnId.set(column.id, lane);
      }
    }
    // Stable sort: lanes of one state type keep the order the boards gave them.
    lanes.sort((a, b) => STATE_ORDER[a.stateType] - STATE_ORDER[b.stateType]);
  }

  for (const ticket of input.tickets) {
    laneByColumnId.get(ticket.columnId)?.tickets.push(ticket);
  }
  for (const lane of lanes) {
    lane.tickets.sort(compareTicketPosition);
  }
  return lanes;
}

/** Turns a drop on the board into the move the board host should apply. */
export function resolveDrop(input: {
  lane: BoardLane;
  ticket: TicketSummary;
  target: BoardDropTarget;
}): DropResolution {
  const { lane, ticket, target } = input;
  const column = lane.columnByBoardId.get(ticket.boardId);
  if (!column) {
    return { kind: "no_column", laneName: lane.name, boardId: ticket.boardId };
  }
  if (target.ticketId === ticket.id) {
    return { kind: "unchanged" };
  }
  const displayed = lane.tickets.filter((candidate) => candidate.id !== ticket.id);
  const anchorIndex =
    target.ticketId === null
      ? -1
      : displayed.findIndex((candidate) => candidate.id === target.ticketId);
  let index = displayed.length;
  if (anchorIndex !== -1) {
    index = target.placement === "before" ? anchorIndex : anchorIndex + 1;
  }
  const afterTicketId = afterTicketIdForDrop({ displayed, index, columnId: column.id });

  if (ticket.columnId === column.id) {
    const columnTickets = lane.tickets.filter((candidate) => candidate.columnId === column.id);
    const currentIndex = columnTickets.findIndex((candidate) => candidate.id === ticket.id);
    const currentAfter = columnTickets[currentIndex - 1]?.id ?? null;
    if (currentAfter === afterTicketId) {
      return { kind: "unchanged" };
    }
  }
  return { kind: "move", move: { ticketId: ticket.id, columnId: column.id, afterTicketId } };
}
