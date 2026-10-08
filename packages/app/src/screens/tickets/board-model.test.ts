import { describe, expect, it } from "vitest";
import type {
  TicketBoard,
  TicketColumn,
  TicketColumnStateType,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { applyTicketMove } from "@/tickets/ordering";
import { buildBoardLanes, resolveDrop, type BoardLane } from "./board-model";
import { resolveDropTargetFromRects } from "./board-drop-geometry";

const NOW = "2026-09-30T10:00:00.000Z";

function column(
  boardId: string,
  id: string,
  name: string,
  stateType: TicketColumnStateType,
  position: number,
): TicketColumn {
  return { id, boardId, name, stateType, position };
}

function board(id: string, key: string, columns: TicketColumn[], archivedAt: string | null = null) {
  const value: TicketBoard = {
    id,
    key,
    name: key,
    projectKey: null,
    columns,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt,
    externalRef: null,
  };
  return value;
}

function ticket(id: string, boardId: string, columnId: string, position: number): TicketSummary {
  return {
    id,
    boardId,
    key: id.toUpperCase(),
    title: id,
    columnId,
    position,
    priority: null,
    type: null,
    assignee: null,
    parentId: null,
    initiativeId: null,
    dueDate: null,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    openBlockerCount: 0,
    commentCount: 0,
    attachmentCount: 0,
    latestRun: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

const paseo = board("brd_a", "PASEO", [
  column("brd_a", "col_a_done", "Done", "completed", 3),
  column("brd_a", "col_a_todo", "Todo", "unstarted", 1),
  column("brd_a", "col_a_doing", "In Progress", "started", 2),
]);
const docs = board("brd_b", "DOCS", [
  column("brd_b", "col_b_todo", "todo", "unstarted", 1),
  column("brd_b", "col_b_review", "Ready to review", "started", 2),
]);

function laneByName(lanes: BoardLane[], name: string): BoardLane {
  const lane = lanes.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!lane) throw new Error(`no lane ${name}`);
  return lane;
}

describe("buildBoardLanes", () => {
  it("shows one board's columns in position order with tickets sorted by position", () => {
    const lanes = buildBoardLanes({
      boards: [paseo, docs],
      boardId: "brd_a",
      tickets: [ticket("t2", "brd_a", "col_a_todo", 2), ticket("t1", "brd_a", "col_a_todo", 1)],
    });
    expect(lanes.map((lane) => lane.key)).toEqual(["col_a_todo", "col_a_doing", "col_a_done"]);
    expect(lanes[0]?.tickets.map((item) => item.id)).toEqual(["t1", "t2"]);
  });

  it("merges same-named columns across boards in the all-projects view, ordered by state", () => {
    const archived = board(
      "brd_c",
      "OLD",
      [column("brd_c", "col_c_x", "Icebox", "backlog", 0)],
      NOW,
    );
    const lanes = buildBoardLanes({
      boards: [paseo, docs, archived],
      boardId: null,
      tickets: [ticket("a1", "brd_a", "col_a_todo", 5), ticket("b1", "brd_b", "col_b_todo", 1)],
    });
    expect(lanes.map((lane) => lane.name)).toEqual([
      "Todo",
      "In Progress",
      "Ready to review",
      "Done",
    ]);
    const todo = laneByName(lanes, "Todo");
    expect([...todo.columnByBoardId.keys()]).toEqual(["brd_a", "brd_b"]);
    expect(todo.tickets.map((item) => item.id)).toEqual(["b1", "a1"]);
  });
});

describe("resolveDrop", () => {
  const tickets = [
    ticket("t1", "brd_a", "col_a_todo", 1),
    ticket("t2", "brd_a", "col_a_todo", 2),
    ticket("t3", "brd_a", "col_a_todo", 3),
    ticket("d1", "brd_a", "col_a_doing", 1),
  ];
  const lanes = buildBoardLanes({ boards: [paseo], boardId: "brd_a", tickets });
  const todo = laneByName(lanes, "Todo");
  const doing = laneByName(lanes, "In Progress");
  const byId = new Map(tickets.map((item) => [item.id, item]));
  const get = (id: string) => byId.get(id) ?? ticket(id, "brd_a", "col_a_todo", 0);

  it("moves across columns after the card above the drop slot", () => {
    expect(
      resolveDrop({
        lane: doing,
        ticket: get("t2"),
        target: { laneKey: doing.key, ticketId: "d1", placement: "after" },
      }),
    ).toEqual({
      kind: "move",
      move: { ticketId: "t2", columnId: "col_a_doing", afterTicketId: "d1" },
    });
  });

  it("asks for the top of the column when dropped before the first card", () => {
    expect(
      resolveDrop({
        lane: todo,
        ticket: get("t3"),
        target: { laneKey: todo.key, ticketId: "t1", placement: "before" },
      }),
    ).toEqual({
      kind: "move",
      move: { ticketId: "t3", columnId: "col_a_todo", afterTicketId: null },
    });
  });

  it("is unchanged when the card is dropped back into its own slot", () => {
    expect(
      resolveDrop({
        lane: todo,
        ticket: get("t2"),
        target: { laneKey: todo.key, ticketId: "t2", placement: "after" },
      }),
    ).toEqual({ kind: "unchanged" });
    expect(
      resolveDrop({
        lane: todo,
        ticket: get("t2"),
        target: { laneKey: todo.key, ticketId: "t3", placement: "before" },
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("anchors an all-projects drop on the nearest card of the ticket's own board", () => {
    const mixed = [
      ticket("a1", "brd_a", "col_a_todo", 1),
      ticket("b1", "brd_b", "col_b_todo", 2),
      ticket("a2", "brd_a", "col_a_doing", 1),
    ];
    const allLanes = buildBoardLanes({ boards: [paseo, docs], boardId: null, tickets: mixed });
    const allTodo = laneByName(allLanes, "Todo");
    expect(
      resolveDrop({
        lane: allTodo,
        ticket: mixed[2] ?? get("a2"),
        target: { laneKey: allTodo.key, ticketId: "b1", placement: "after" },
      }),
    ).toEqual({
      kind: "move",
      move: { ticketId: "a2", columnId: "col_a_todo", afterTicketId: "a1" },
    });
  });

  it("refuses a lane the ticket's board has no column for", () => {
    const allLanes = buildBoardLanes({ boards: [paseo, docs], boardId: null, tickets: [] });
    const review = laneByName(allLanes, "Ready to review");
    expect(
      resolveDrop({
        lane: review,
        ticket: get("t1"),
        target: { laneKey: review.key, ticketId: null, placement: "after" },
      }),
    ).toEqual({ kind: "no_column", laneName: "Ready to review", boardId: "brd_a" });
  });
});

describe("applyTicketMove", () => {
  const tickets = [
    ticket("t1", "brd_a", "col_a_todo", 1),
    ticket("t2", "brd_a", "col_a_todo", 2),
    ticket("d1", "brd_a", "col_a_doing", 4),
  ];
  const positionOf = (list: readonly TicketSummary[], id: string) =>
    list.find((item) => item.id === id)?.position;

  it("places the card between its new neighbours, at the top, or at the bottom", () => {
    const between = applyTicketMove(tickets, {
      ticketId: "d1",
      columnId: "col_a_todo",
      afterTicketId: "t1",
    });
    expect(positionOf(between, "d1")).toBe(1.5);
    expect(between.find((item) => item.id === "d1")?.columnId).toBe("col_a_todo");
    expect(
      positionOf(
        applyTicketMove(tickets, { ticketId: "d1", columnId: "col_a_todo", afterTicketId: null }),
        "d1",
      ),
    ).toBe(0);
    expect(
      positionOf(applyTicketMove(tickets, { ticketId: "t1", columnId: "col_a_doing" }), "t1"),
    ).toBe(5);
  });

  it("leaves a list that does not hold the ticket untouched", () => {
    expect(applyTicketMove(tickets, { ticketId: "zz", columnId: "col_a_todo" })).toBe(tickets);
  });
});

describe("resolveDropTargetFromRects", () => {
  const lanes = [
    { laneKey: "todo", rect: { x: 0, y: 0, width: 340, height: 800 } },
    { laneKey: "doing", rect: { x: 352, y: 0, width: 340, height: 800 } },
  ];
  const cards = [
    { ticketId: "t2", laneKey: "todo", rect: { x: 8, y: 200, width: 320, height: 100 } },
    { ticketId: "t1", laneKey: "todo", rect: { x: 8, y: 80, width: 320, height: 100 } },
  ];

  it("targets the slot before the first card whose middle is below the finger", () => {
    expect(resolveDropTargetFromRects({ lanes, cards, x: 100, y: 100 })).toEqual({
      laneKey: "todo",
      ticketId: "t1",
      placement: "before",
    });
    expect(resolveDropTargetFromRects({ lanes, cards, x: 100, y: 240 })).toEqual({
      laneKey: "todo",
      ticketId: "t2",
      placement: "before",
    });
    expect(resolveDropTargetFromRects({ lanes, cards, x: 100, y: 700 })).toEqual({
      laneKey: "todo",
      ticketId: "t2",
      placement: "after",
    });
  });

  it("targets the end of an empty lane and nothing between lanes", () => {
    expect(resolveDropTargetFromRects({ lanes, cards, x: 400, y: 100 })).toEqual({
      laneKey: "doing",
      ticketId: null,
      placement: "after",
    });
    expect(resolveDropTargetFromRects({ lanes, cards, x: 346, y: 100 })).toBeNull();
  });
});
