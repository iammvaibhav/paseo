import { describe, expect, it } from "vitest";
import type { TicketRun, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { selectActiveWork } from "./ticket-groups";

function run(bucket: TicketRun["bucket"], updatedAt: string, archived = false): TicketRun {
  return {
    ticketId: "",
    agentId: updatedAt,
    serverId: "host",
    bucket,
    agentTitle: null,
    agentName: null,
    archived,
    startedAt: updatedAt,
    updatedAt,
  };
}

function ticket(id: string, latestRun: TicketRun | null): TicketSummary {
  return {
    id,
    boardId: "brd_1",
    key: id.toUpperCase(),
    title: id,
    columnId: "col_1",
    position: 1,
    priority: null,
    type: null,
    assignee: null,
    parentId: null,
    initiativeId: "ini_1",
    dueDate: null,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    openBlockerCount: 0,
    commentCount: 0,
    attachmentCount: 0,
    latestRun,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("selectActiveWork", () => {
  it("lists tickets that need you first, then running ones, newest run first", () => {
    const active = selectActiveWork([
      ticket("running-old", run("running", "2026-09-01T00:00:00.000Z")),
      ticket("idle", run("idle", "2026-09-05T00:00:00.000Z")),
      ticket("running-new", run("running", "2026-09-04T00:00:00.000Z")),
      ticket("needs-you", run("needs_you", "2026-08-30T00:00:00.000Z")),
      ticket("archived", run("running", "2026-09-06T00:00:00.000Z", true)),
      ticket("no-run", null),
    ]);
    expect(active.map((entry) => entry.ticket.id)).toEqual([
      "needs-you",
      "running-new",
      "running-old",
    ]);
  });
});
