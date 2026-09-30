import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  TicketActor,
  TicketBoard,
  TicketColumn,
  TicketColumnStateType,
  TicketRun,
  TicketRunBucket,
} from "@getpaseo/protocol/tickets/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  isReadyForAutoDispatch,
  mentionsCommander,
  planRunColumnMove,
  readTicketLink,
  TicketAutomation,
  type AutoDispatchCandidate,
  type LifecycleSetInput,
  type MachineryPrompt,
} from "./fleet.js";
import { TicketService } from "./service.js";
import { TicketStore } from "./store.js";

function boardColumn(
  name: string,
  stateType: TicketColumnStateType,
  position: number,
): TicketColumn {
  return { id: `col_${position}`, boardId: "brd_1", name, stateType, position };
}

const BACKLOG = boardColumn("Backlog", "backlog", 1);
const TODO = boardColumn("Todo", "unstarted", 2);
const IN_PROGRESS = boardColumn("In Progress", "started", 3);
const READY_TO_REVIEW = boardColumn("Ready to review", "started", 4);
const DONE = boardColumn("Done", "completed", 5);
const CANCELED = boardColumn("Canceled", "canceled", 6);
const DEFAULT_BOARD = [BACKLOG, TODO, IN_PROGRESS, READY_TO_REVIEW, DONE, CANCELED];

function plan(bucket: TicketRunBucket, current: TicketColumn, columns = DEFAULT_BOARD) {
  return planRunColumnMove({ bucket, current, columns });
}

describe("planRunColumnMove", () => {
  it("moves a started run forward to In Progress", () => {
    expect(plan("running", TODO)).toEqual({ kind: "move", column: IN_PROGRESS });
    expect(plan("needs_you", BACKLOG)).toEqual({ kind: "move", column: IN_PROGRESS });
  });

  it("moves a finished run forward to Ready to review", () => {
    expect(plan("ready", IN_PROGRESS)).toEqual({ kind: "move", column: READY_TO_REVIEW });
    expect(plan("done", TODO)).toEqual({ kind: "move", column: READY_TO_REVIEW });
  });

  it("never moves a ticket backwards", () => {
    expect(plan("running", READY_TO_REVIEW)).toEqual({ kind: "stay" });
    expect(plan("needs_you", READY_TO_REVIEW)).toEqual({ kind: "stay" });
    expect(plan("running", IN_PROGRESS)).toEqual({ kind: "stay" });
  });

  it("never moves a ticket out of a closed column", () => {
    expect(plan("running", DONE)).toEqual({ kind: "stay" });
    expect(plan("ready", CANCELED)).toEqual({ kind: "stay" });
  });

  it("leaves the ticket where it is for an idle run", () => {
    expect(plan("idle", TODO)).toEqual({ kind: "stay" });
  });

  it("treats Ready to review as later than In Progress wherever the user put it", () => {
    const reordered = [TODO, { ...READY_TO_REVIEW, position: 2.5 }, IN_PROGRESS, DONE];
    expect(plan("running", { ...READY_TO_REVIEW, position: 2.5 }, reordered)).toEqual({
      kind: "stay",
    });
    expect(plan("ready", IN_PROGRESS, reordered)).toEqual({
      kind: "move",
      column: { ...READY_TO_REVIEW, position: 2.5 },
    });
  });

  it("asks for a Ready to review column after In Progress when the board has none", () => {
    const board = [BACKLOG, TODO, IN_PROGRESS, DONE];
    expect(plan("ready", IN_PROGRESS, board)).toEqual({
      kind: "create_ready_column",
      afterColumnId: IN_PROGRESS.id,
    });
  });

  it("anchors a missing Ready to review column after the last open column without In Progress", () => {
    expect(plan("ready", TODO, [BACKLOG, TODO, DONE])).toEqual({
      kind: "create_ready_column",
      afterColumnId: TODO.id,
    });
  });
});

function run(bucket: TicketRunBucket, archived = false): TicketRun {
  return {
    ticketId: "tkt_1",
    agentId: `agent-${bucket}`,
    serverId: "srv",
    bucket,
    agentTitle: null,
    agentName: null,
    archived,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const RELEASED: AutoDispatchCandidate = {
  assignee: "commander",
  openBlockerCount: 0,
  archivedAt: null,
  runs: [],
};

describe("isReadyForAutoDispatch", () => {
  it("dispatches an unblocked Commander ticket waiting in Todo", () => {
    expect(isReadyForAutoDispatch(RELEASED, TODO)).toBe(true);
  });

  it("holds a ticket that still has an open blocker", () => {
    expect(isReadyForAutoDispatch({ ...RELEASED, openBlockerCount: 1 }, TODO)).toBe(false);
  });

  it("holds a ticket outside an unstarted column", () => {
    expect(isReadyForAutoDispatch(RELEASED, BACKLOG)).toBe(false);
    expect(isReadyForAutoDispatch(RELEASED, IN_PROGRESS)).toBe(false);
  });

  it("holds a ticket that is not assigned to the Commander", () => {
    expect(isReadyForAutoDispatch({ ...RELEASED, assignee: "user" }, TODO)).toBe(false);
    expect(isReadyForAutoDispatch({ ...RELEASED, assignee: null }, TODO)).toBe(false);
  });

  it("holds an archived ticket", () => {
    expect(
      isReadyForAutoDispatch({ ...RELEASED, archivedAt: "2026-01-01T00:00:00.000Z" }, TODO),
    ).toBe(false);
  });

  it("holds a ticket a run still works on, but not one whose runs ended", () => {
    expect(isReadyForAutoDispatch({ ...RELEASED, runs: [run("ready")] }, TODO)).toBe(false);
    expect(isReadyForAutoDispatch({ ...RELEASED, runs: [run("idle")] }, TODO)).toBe(false);
    expect(
      isReadyForAutoDispatch({ ...RELEASED, runs: [run("done"), run("running", true)] }, TODO),
    ).toBe(true);
  });
});

describe("mentionsCommander", () => {
  it("finds @commander as a word of its own", () => {
    expect(mentionsCommander("@commander can you take this?")).toBe(true);
    expect(mentionsCommander("Thoughts, @Commander?")).toBe(true);
    expect(mentionsCommander("ping (@commander)")).toBe(true);
    expect(mentionsCommander("first line\n@commander second line")).toBe(true);
  });

  it("ignores addresses, paths and longer handles", () => {
    expect(mentionsCommander("mail ops@commander.dev")).toBe(false);
    expect(mentionsCommander("see /users/@commander")).toBe(false);
    expect(mentionsCommander("@commanders unite")).toBe(false);
    expect(mentionsCommander("@commander-bot")).toBe(false);
    expect(mentionsCommander("the commander said")).toBe(false);
  });
});

describe("readTicketLink", () => {
  it("reads the native ticket label", () => {
    expect(readTicketLink({ "paseo.ticket-id": "tkt_0123456789abcdef" })).toEqual({
      ticketId: "tkt_0123456789abcdef",
      itsaplanIssueId: null,
    });
  });

  it("reads the itsaplan issue label for imported tickets", () => {
    expect(readTicketLink({ "itsaplan.issue": "45" })).toEqual({
      ticketId: null,
      itsaplanIssueId: 45,
    });
  });

  it("is null for an agent without a ticket", () => {
    expect(readTicketLink({ surface: "workspace" })).toBeNull();
    expect(readTicketLink({ "paseo.ticket-id": "  " })).toBeNull();
  });
});

const USER: TicketActor = { kind: "user" };
const COMMANDER: TicketActor = { kind: "commander" };

let directory: string;
let store: TicketStore;
let service: TicketService;
let automation: TicketAutomation;
let deliveries: MachineryPrompt[];
let lifecycleCalls: LifecycleSetInput[];
let clock: number;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-tickets-fleet-"));
  const opened = await TicketStore.open({ directory, logger: createTestLogger() });
  if (!opened) {
    throw new Error("node:sqlite is required for the tickets tests");
  }
  store = opened;
  service = new TicketService({ store, logger: createTestLogger() });
  deliveries = [];
  lifecycleCalls = [];
  clock = Date.UTC(2026, 0, 1);
  automation = new TicketAutomation({
    logger: createTestLogger(),
    service,
    missionControl: {
      async setLifecycle(input) {
        lifecycleCalls.push(input);
        return { ok: true };
      },
    },
    async deliverMachineryPrompt(input) {
      deliveries.push(input);
      return true;
    },
  });
  automation.start();
});

afterEach(async () => {
  automation.stop();
  store.close();
  await rm(directory, { recursive: true, force: true });
});

// Automation runs off service events; with no file I/O it settles within
// the microtask queue, which drains before the next macrotask.
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(() => resolve());
  return promise;
}

function createBoard(): TicketBoard {
  return service.ensureBoard({ projectKey: "paseo", name: "Paseo", key: "PASEO" });
}

function columnId(board: TicketBoard, name: string): string {
  const match = board.columns.find((candidate) => candidate.name === name);
  if (!match) {
    throw new Error(`No column ${name}`);
  }
  return match.id;
}

function columnNameOf(ticketId: string): string | undefined {
  const ticket = service.getTicket({ ticketId });
  return ticket === null ? undefined : service.getColumn(ticket.columnId)?.name;
}

function reportRun(ticketId: string, agentId: string, bucket: TicketRunBucket) {
  clock += 1000;
  return automation.reportRun({
    serverId: "srv-peer",
    agentId,
    ticketId,
    itsaplanIssueId: null,
    bucket,
    agentTitle: "PASEO-1 - Build it",
    agentName: "PASEO-1",
    archived: false,
    observedAt: new Date(clock).toISOString(),
  });
}

describe("TicketAutomation run reports", () => {
  it("moves a linked ticket Todo → In Progress → Ready to review and never back", async () => {
    const board = createBoard();
    const ticket = service.createTicket(
      { boardId: board.id, title: "Build it", columnId: columnId(board, "Todo") },
      USER,
    );

    await reportRun(ticket.id, "agent-1", "running");
    expect(columnNameOf(ticket.id)).toBe("In Progress");

    await reportRun(ticket.id, "agent-1", "ready");
    expect(columnNameOf(ticket.id)).toBe("Ready to review");

    await reportRun(ticket.id, "agent-1", "running");
    expect(columnNameOf(ticket.id)).toBe("Ready to review");
  });

  it("creates Ready to review after In Progress when the board lost it", async () => {
    const board = createBoard();
    service.deleteColumn(columnId(board, "Ready to review"));
    const ticket = service.createTicket(
      { boardId: board.id, title: "Build it", columnId: columnId(board, "In Progress") },
      USER,
    );

    await reportRun(ticket.id, "agent-1", "ready");

    expect(columnNameOf(ticket.id)).toBe("Ready to review");
    const names = service.listColumns(board.id).map((column) => column.name);
    expect(names).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Ready to review",
      "Done",
      "Canceled",
    ]);
  });

  it("ignores an itsaplan-linked agent whose issue was never imported", async () => {
    const result = await automation.reportRun({
      serverId: "srv-peer",
      agentId: "agent-1",
      ticketId: null,
      itsaplanIssueId: 999,
      bucket: "running",
      agentTitle: null,
      agentName: null,
      archived: false,
      observedAt: new Date(clock).toISOString(),
    });
    expect(result).toEqual({ applied: false });
  });

  it("does not apply a report for a deleted ticket", async () => {
    const result = await reportRun("tkt_0000000000000000", "agent-1", "running");
    expect(result).toEqual({ applied: false });
  });
});

describe("TicketAutomation board events", () => {
  it("marks runs done and dispatches a released dependent when the user closes the blocker", async () => {
    const board = createBoard();
    const blocker = service.createTicket(
      { boardId: board.id, title: "Blocker", columnId: columnId(board, "Todo") },
      USER,
    );
    const dependent = service.createTicket(
      {
        boardId: board.id,
        title: "Dependent",
        columnId: columnId(board, "Todo"),
        assignee: "commander",
        blockedByTicketIds: [blocker.id],
      },
      USER,
    );
    await settle();
    expect(deliveries).toEqual([]);

    await reportRun(blocker.id, "agent-blocker", "ready");
    service.moveTicket(blocker.id, columnId(board, "Done"), undefined, USER);
    await settle();

    expect(lifecycleCalls).toEqual([{ agentId: "agent-blocker", action: "done" }]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.prompt).toContain(`Ticket: ${dependent.key} — Dependent`);
    expect(deliveries[0]?.prompt).toContain(`"paseo.ticket-id": "${dependent.id}"`);
  });

  it("dispatches when the user moves a Commander ticket into Todo, not when the Commander does", async () => {
    const board = createBoard();
    const ticket = service.createTicket(
      {
        boardId: board.id,
        title: "Ship",
        columnId: columnId(board, "Backlog"),
        assignee: "commander",
      },
      USER,
    );

    service.moveTicket(ticket.id, columnId(board, "Todo"), undefined, COMMANDER);
    await settle();
    expect(deliveries).toEqual([]);

    service.moveTicket(ticket.id, columnId(board, "Backlog"), undefined, USER);
    service.moveTicket(ticket.id, columnId(board, "Todo"), undefined, USER);
    await settle();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.prompt).toContain(`Ticket: ${ticket.key} — Ship`);
  });

  it("wakes the Commander for a user comment that mentions @commander", async () => {
    const board = createBoard();
    const ticket = service.createTicket(
      { boardId: board.id, title: "Question", columnId: columnId(board, "Backlog") },
      USER,
    );

    service.addComment(ticket.id, "Looks good", USER);
    service.addComment(ticket.id, "@commander answering myself", COMMANDER);
    service.addComment(ticket.id, "@commander what blocks this?", USER);
    await settle();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.prompt).toContain("@commander what blocks this?");
    expect(deliveries[0]?.prompt).toContain(`ticket_comment({ key: "${ticket.key}"`);
  });

  it("dispatches on request whatever the assignee and fails without a Commander", async () => {
    const board = createBoard();
    const ticket = service.createTicket(
      { boardId: board.id, title: "Now", columnId: columnId(board, "Backlog"), assignee: "user" },
      USER,
    );

    const summary = await automation.dispatch({ ticketId: ticket.id, note: "Use the staging DB" });

    expect(summary.key).toBe(ticket.key);
    expect(deliveries[0]?.prompt).toContain("Dispatch note: Use the staging DB");

    const withoutCommander = new TicketAutomation({
      logger: createTestLogger(),
      service,
      missionControl: { setLifecycle: async () => ({ ok: true }) },
      deliverMachineryPrompt: async () => false,
    });
    await expect(withoutCommander.dispatch({ ticketId: ticket.id })).rejects.toThrow(
      `No Commander is available to dispatch ${ticket.key}`,
    );
  });
});
