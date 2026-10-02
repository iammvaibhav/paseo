import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TicketActor, TicketBoard, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { TicketsError, TicketService, type TicketsChange } from "./service.js";
import { TicketStore } from "./store.js";

const USER: TicketActor = { kind: "user" };

let directory: string;
let store: TicketStore;
let service: TicketService;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-tickets-"));
  const opened = await TicketStore.open({ directory, logger: createTestLogger() });
  if (!opened) {
    throw new Error("node:sqlite is required for the tickets tests");
  }
  store = opened;
  service = new TicketService({ store, logger: createTestLogger() });
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

function column(board: TicketBoard, name: string): string {
  const match = board.columns.find((candidate) => candidate.name === name);
  if (!match) {
    throw new Error(`No column ${name}`);
  }
  return match.id;
}

function createTicket(board: TicketBoard, title: string, columnName = "Todo") {
  return service.createTicket(
    { boardId: board.id, title, columnId: column(board, columnName) },
    USER,
  );
}

function keysInColumn(board: TicketBoard, columnName: string): string[] {
  const columnId = column(board, columnName);
  return service
    .listTickets({ boardId: board.id })
    .tickets.filter((ticket) => ticket.columnId === columnId)
    .map((ticket) => ticket.key);
}

function countRows(table: string, where: string, ...params: unknown[]): number {
  const row = store.withTransaction((db) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params),
  );
  return Number(row?.n);
}

function summaryOf(board: TicketBoard, ticketId: string): TicketSummary {
  const summary = service.listTickets({ boardId: board.id }).tickets.find((t) => t.id === ticketId);
  if (!summary) {
    throw new Error(`No ticket ${ticketId}`);
  }
  return summary;
}

describe("boards and keys", () => {
  it("creates the default columns in order and derives the key from the name", () => {
    const board = service.ensureBoard({ projectKey: "paseo", name: "Paseo App" });
    expect(board.key).toBe("PASEOAPP");
    expect(board.columns.map((c) => [c.name, c.stateType])).toEqual([
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["Ready to review", "started"],
      ["Done", "completed"],
      ["Canceled", "canceled"],
    ]);
  });

  it("is idempotent on projectKey and suffixes colliding keys within 10 characters", () => {
    const first = service.ensureBoard({ projectKey: "p1", name: "Abcdefghijklm" });
    const revision = store.getRevision();
    expect(service.ensureBoard({ projectKey: "p1", name: "Renamed" }).id).toBe(first.id);
    expect(store.getRevision()).toBe(revision);

    const second = service.ensureBoard({ projectKey: "p2", name: "abcdefghij-other" });
    const noProject = service.ensureBoard({ projectKey: null, name: "Abcdefghij" });
    expect([first.key, second.key, noProject.key]).toEqual([
      "ABCDEFGHIJ",
      "ABCDEFGHI2",
      "ABCDEFGHI3",
    ]);
    expect(service.ensureBoard({ projectKey: null, name: "Abcdefghij" }).id).toBe(noProject.id);
  });

  it("numbers tickets per board, monotonic after deletes", async () => {
    const paseo = service.ensureBoard({ projectKey: "paseo", name: "Paseo" });
    const other = service.ensureBoard({ projectKey: "other", name: "Other" });
    const one = createTicket(paseo, "one");
    createTicket(paseo, "two");
    await service.deleteTicket(one.id);
    const three = createTicket(paseo, "three");
    const firstOther = createTicket(other, "first");
    expect([three.key, firstOther.key]).toEqual(["PASEO-3", "OTHER-1"]);
    expect(service.getTicket({ key: "paseo-3" })?.id).toBe(three.id);
  });
});

describe("moveTicket", () => {
  it("places the ticket between its neighbours, at the top, or at the bottom", () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Pos" });
    const a = createTicket(board, "a");
    const b = createTicket(board, "b");
    const c = createTicket(board, "c");
    expect(keysInColumn(board, "Todo")).toEqual([a.key, b.key, c.key]);

    service.moveTicket(c.id, column(board, "Todo"), a.id, USER);
    expect(keysInColumn(board, "Todo")).toEqual([a.key, c.key, b.key]);

    service.moveTicket(b.id, column(board, "Todo"), null, USER);
    expect(keysInColumn(board, "Todo")).toEqual([b.key, a.key, c.key]);

    service.moveTicket(b.id, column(board, "In Progress"), undefined, USER);
    service.moveTicket(a.id, column(board, "In Progress"), undefined, USER);
    expect(keysInColumn(board, "Todo")).toEqual([c.key]);
    expect(keysInColumn(board, "In Progress")).toEqual([b.key, a.key]);
  });

  it("keeps the order when the same gap is split past float precision", () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Dense" });
    const first = createTicket(board, "first");
    createTicket(board, "last");
    const inserted: string[] = [];
    for (let index = 0; index < 80; index += 1) {
      const ticket = createTicket(board, `t${index}`, "Backlog");
      service.moveTicket(ticket.id, column(board, "Todo"), first.id, USER);
      inserted.unshift(ticket.key);
    }
    expect(keysInColumn(board, "Todo")).toEqual([first.key, ...inserted, "DENSE-2"]);
  });

  it("writes a moved event with column names and fires onTicketMoved", () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Ev" });
    const ticket = createTicket(board, "a");
    const moves: string[] = [];
    service.onTicketMoved((event) => moves.push(`${event.from?.name}->${event.to.name}`));
    service.moveTicket(ticket.id, column(board, "In Progress"), undefined, USER);
    const moved = service.getTicket({ ticketId: ticket.id })?.activity.at(-1);
    expect(moved).toMatchObject({
      eventType: "moved",
      from: "Todo",
      to: "In Progress",
      actor: USER,
    });
    expect(moves).toEqual(["Todo->In Progress"]);
  });

  it("refuses a column of another board", () => {
    const board = service.ensureBoard({ projectKey: "p", name: "A" });
    const other = service.ensureBoard({ projectKey: "q", name: "B" });
    const ticket = createTicket(board, "a");
    expect(() => service.moveTicket(ticket.id, column(other, "Todo"), undefined, USER)).toThrow(
      TicketsError,
    );
  });
});

describe("summary counts", () => {
  it("counts sub-tasks, open blockers, comments, attachments and the latest run", async () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Counts" });
    const parent = createTicket(board, "parent");
    const doneChild = service.createTicket(
      { boardId: board.id, title: "child 1", parentId: parent.id },
      USER,
    );
    service.createTicket({ boardId: board.id, title: "child 2", parentId: parent.id }, USER);
    service.moveTicket(doneChild.id, column(board, "Done"), undefined, USER);

    const openBlocker = createTicket(board, "open blocker");
    const doneBlocker = createTicket(board, "done blocker");
    service.setLink(parent.id, openBlocker.id, true, USER);
    service.setLink(parent.id, doneBlocker.id, true, USER);
    service.moveTicket(doneBlocker.id, column(board, "Canceled"), undefined, USER);

    service.addComment(parent.id, "first", USER);
    service.addComment(parent.id, "second", USER);
    await service.addAttachment(
      parent.id,
      { fileName: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello") },
      USER,
    );
    service.upsertRun({
      ticketId: parent.id,
      agentId: "agent-old",
      serverId: "srv",
      bucket: "done",
      agentTitle: "Old",
      agentName: "old",
      archived: false,
      observedAt: "2026-09-30T10:00:00.000Z",
    });
    service.upsertRun({
      ticketId: parent.id,
      agentId: "agent-new",
      serverId: "srv",
      bucket: "running",
      agentTitle: "New",
      agentName: "new",
      archived: false,
      observedAt: "2026-09-30T11:00:00.000Z",
    });

    const summary = summaryOf(board, parent.id);
    expect(summary).toMatchObject({
      subtaskCount: 2,
      subtaskDoneCount: 1,
      openBlockerCount: 1,
      commentCount: 2,
      attachmentCount: 1,
    });
    expect(summary.latestRun).toMatchObject({ agentId: "agent-new", bucket: "running" });

    const detail = service.getTicket({ ticketId: parent.id });
    expect(detail?.subtasks.map((t) => t.title)).toEqual(["child 1", "child 2"]);
    expect(detail?.blockedBy.map((t) => t.id).sort()).toEqual(
      [openBlocker.id, doneBlocker.id].sort(),
    );
    expect(service.getTicket({ ticketId: openBlocker.id })?.blocks.map((t) => t.id)).toEqual([
      parent.id,
    ]);
    const attachment = detail?.attachments[0];
    expect(attachment).toMatchObject({ fileName: "notes.txt", size: 5 });
    const content = await service.readAttachment(attachment?.id ?? "");
    expect(content?.data.toString()).toBe("hello");
  });

  it("ignores run reports older than the stored run", () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Runs" });
    const ticket = createTicket(board, "a");
    const report = {
      ticketId: ticket.id,
      agentId: "agent",
      serverId: "srv",
      agentTitle: null,
      agentName: null,
      archived: false,
    };
    const linked = service.upsertRun({
      ...report,
      bucket: "running",
      observedAt: "2026-09-30T11:00:00Z",
    });
    const stale = service.upsertRun({
      ...report,
      bucket: "idle",
      observedAt: "2026-09-30T10:00:00Z",
    });
    const finished = service.upsertRun({
      ...report,
      bucket: "done",
      observedAt: "2026-09-30T12:00:00Z",
    });
    expect([linked.changed, stale.changed, finished.changed]).toEqual([true, false, true]);
    expect([linked.previousBucket, finished.previousBucket]).toEqual([null, "running"]);
    expect(finished.ticket.latestRun?.bucket).toBe("done");
    const events = service
      .getTicket({ ticketId: ticket.id })
      ?.activity.map((entry) => [entry.eventType, entry.from, entry.to]);
    expect(events).toEqual([
      ["created", null, "Todo"],
      ["run_linked", null, "agent"],
      ["run_state", "running", "done"],
    ]);
  });
});

describe("setLink", () => {
  it("refuses links that close a cycle, directly or through a chain", () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Links" });
    const other = service.ensureBoard({ projectKey: "q", name: "Other" });
    const a = createTicket(board, "a");
    const b = createTicket(board, "b");
    const c = createTicket(other, "c");
    service.setLink(a.id, b.id, true, USER);
    service.setLink(b.id, c.id, true, USER);

    expect(() => service.setLink(b.id, a.id, true, USER)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => service.setLink(c.id, a.id, true, USER)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => service.setLink(a.id, a.id, true, USER)).toThrow(
      expect.objectContaining({ code: "invalid" }),
    );
    expect(service.getTicket({ ticketId: c.id })?.blocks.map((t) => t.id)).toEqual([b.id]);
  });
});

describe("revision and onChange", () => {
  it("bumps the revision and notifies once per mutation, never for a no-op", async () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Rev" });
    const changes: TicketsChange[] = [];
    service.onChange((change) => changes.push(change));
    const start = store.getRevision();

    const a = createTicket(board, "a");
    const b = createTicket(board, "b");
    service.moveTicket(a.id, column(board, "Done"), undefined, USER);
    service.setLink(b.id, a.id, true, USER);
    service.addComment(b.id, "hi", USER);
    service.updateTicket(b.id, { title: "b renamed", assignee: "commander" }, USER);
    await service.addAttachment(
      b.id,
      { fileName: "x.bin", mimeType: "application/octet-stream", data: Buffer.from([1]) },
      USER,
    );

    service.updateTicket(b.id, { title: "b renamed" }, USER);
    service.setLink(b.id, a.id, true, USER);

    expect(changes.map((change) => change.revision)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => start + n),
    );
    expect(store.getRevision()).toBe(start + 7);
    expect(changes[3]).toEqual({
      revision: start + 4,
      boardIds: [board.id],
      ticketIds: [b.id, a.id],
      initiativeIds: [],
    });
    expect(service.listTickets({ boardId: board.id }).revision).toBe(start + 7);
    const events = service
      .getTicket({ ticketId: b.id })
      ?.activity.map((entry) => entry.eventType ?? entry.kind);
    expect(events).toEqual([
      "created",
      "blocker_added",
      "comment",
      "renamed",
      "assigned",
      "attachment_added",
    ]);
  });
});

describe("deleteTicket", () => {
  it("removes links, activity, attachment files and runs, and detaches sub-tasks", async () => {
    const board = service.ensureBoard({ projectKey: "p", name: "Del" });
    const doomed = createTicket(board, "doomed");
    const blocker = createTicket(board, "blocker");
    const blocked = createTicket(board, "blocked");
    const child = service.createTicket(
      { boardId: board.id, title: "child", parentId: doomed.id },
      USER,
    );
    service.setLink(doomed.id, blocker.id, true, USER);
    service.setLink(blocked.id, doomed.id, true, USER);
    service.addComment(doomed.id, "bye", USER);
    const withFile = await service.addAttachment(
      doomed.id,
      { fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("a") },
      USER,
    );
    const filePath = store.attachmentPath(withFile.attachments[0]?.id ?? "");
    service.upsertRun({
      ticketId: doomed.id,
      agentId: "agent",
      serverId: "srv",
      bucket: "running",
      agentTitle: null,
      agentName: null,
      archived: false,
      observedAt: "2026-09-30T10:00:00Z",
    });
    expect(existsSync(filePath)).toBe(true);

    await service.deleteTicket(doomed.id);

    expect(service.getTicket({ ticketId: doomed.id })).toBeNull();
    expect(existsSync(filePath)).toBe(false);
    expect(
      countRows("ticket_links", "ticket_id = ? OR blocked_by_ticket_id = ?", doomed.id, doomed.id),
    ).toBe(0);
    expect(countRows("activity", "ticket_id = ?", doomed.id)).toBe(0);
    expect(countRows("attachments", "ticket_id = ?", doomed.id)).toBe(0);
    expect(countRows("runs", "ticket_id = ?", doomed.id)).toBe(0);
    expect(service.getTicket({ ticketId: blocked.id })?.blockedBy).toEqual([]);
    expect(service.getTicket({ ticketId: blocker.id })?.blocks).toEqual([]);
    expect(summaryOf(board, child.id).parentId).toBeNull();
  });
});
