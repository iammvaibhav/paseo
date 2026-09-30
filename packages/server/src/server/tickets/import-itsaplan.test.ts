import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { TicketDetail } from "@getpaseo/protocol/tickets/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ITSAPLAN_ISSUE_LABEL_KEY } from "../itsaplan/bridge.js";
import type { ItsaplanIssueLink } from "../itsaplan/client.js";
import { ItsaplanProjectStore, type ItsaplanCentralConfig } from "../itsaplan/projects.js";
import {
  ItsaplanTicketImporter,
  itsaplanBlockerLinks,
  itsaplanTicketKey,
  mapItsaplanAssignee,
  mapItsaplanCommentActor,
  type ItsaplanImportAgentRecord,
} from "./import-itsaplan.js";
import { TicketService, type TicketsChange } from "./service.js";
import { TicketStore } from "./store.js";

const API_KEY = "itp_key";
const HUMAN = "human-1";
const COMMANDER_BOT = "bot-commander";
const T0 = "2026-01-01T00:00:00.000Z";

describe("itsaplan import mapping", () => {
  const users = { humanUserId: HUMAN, commanderUserIds: new Set([COMMANDER_BOT]) };

  test("keeps the itsaplan identifier as the ticket key and the issue number as the sequence", () => {
    expect(itsaplanTicketKey({ identifier: "PASEO-45", sequenceNumber: 45 }, "PASEO")).toEqual({
      key: "PASEO-45",
      sequence: 45,
    });
    // A collision-suffixed project key contains a hyphen of its own.
    expect(
      itsaplanTicketKey({ identifier: "PASEO-A1B2-7", sequenceNumber: 7 }, "PASEO-A1B2"),
    ).toEqual({ key: "PASEO-A1B2-7", sequence: 7 });
    expect(itsaplanTicketKey({ sequenceNumber: 3 }, "ENG")).toEqual({ key: "ENG-3", sequence: 3 });
  });

  test("maps the human to user, the Commander bot to commander and anyone else to nobody", () => {
    expect(mapItsaplanAssignee(HUMAN, users)).toBe("user");
    expect(mapItsaplanAssignee(COMMANDER_BOT, users)).toBe("commander");
    expect(mapItsaplanAssignee("bot-reviewer", users)).toBeNull();
    expect(mapItsaplanAssignee(null, users)).toBeNull();
    expect(
      mapItsaplanAssignee(HUMAN, { humanUserId: null, commanderUserIds: new Set() }),
    ).toBeNull();
  });

  test("keeps the itsaplan author name on comments, except for the Commander bot", () => {
    expect(mapItsaplanCommentActor({ actorUserId: HUMAN, actorName: "Ramon" }, users)).toEqual({
      kind: "imported",
      name: "Ramon",
    });
    expect(
      mapItsaplanCommentActor({ actorUserId: COMMANDER_BOT, actorName: "Commander" }, users),
    ).toEqual({ kind: "commander" });
    expect(mapItsaplanCommentActor({ actorUserId: null, actorName: null }, users)).toEqual({
      kind: "imported",
      name: "Unknown",
    });
  });

  test("the target of a blocks relation is blocked by its source", () => {
    const links: ItsaplanIssueLink[] = [
      { id: 1, kind: "blocks", sourceIssueId: 10, targetIssueId: 20 },
      // The same relation read from its other end.
      { id: 1, kind: "blocks", sourceIssueId: 10, targetIssueId: 20 },
      { id: 2, kind: "relates", sourceIssueId: 10, targetIssueId: 30 },
      { id: 3, kind: "duplicates", sourceIssueId: 30, targetIssueId: 20 },
      { id: 4, kind: "blocks", sourceIssueId: 40, targetIssueId: 10 },
    ];
    expect(itsaplanBlockerLinks(links)).toEqual([
      { issueId: 20, blockedByIssueId: 10 },
      { issueId: 10, blockedByIssueId: 40 },
    ]);
  });
});

// --- Fake itsaplan server: the wire shapes of the real REST API.

interface FakeItsaplan {
  baseUrl: string;
  close(): Promise<void>;
  requests: string[];
  maxInFlight: number;
  // Answered 503 once, then normally.
  failOnce: Set<string>;
  // Answered 429 every time.
  rateLimited: Set<string>;
  boardIssues: Array<Record<string, unknown>>;
}

function column(id: number, name: string, stateType: string, position: number) {
  return { id, projectId: 1, name, stateType, position };
}

function issue(fields: {
  id: number;
  sequenceNumber: number;
  columnId: number;
  title: string;
  parentId?: number;
  assigneeUserId?: string;
  priority?: string;
  typeId?: number;
  initiative?: { id: number; title: string; status: string };
  archivedAt?: string;
  links?: Array<{ id: number; relation: string; issueId: number }>;
}) {
  return {
    id: fields.id,
    projectId: 1,
    sequenceNumber: fields.sequenceNumber,
    identifier: `PASEO-${fields.sequenceNumber}`,
    typeId: fields.typeId ?? null,
    initiative: fields.initiative ?? null,
    cycle: null,
    assigneeUserId: fields.assigneeUserId ?? null,
    delegateUserId: null,
    columnId: fields.columnId,
    parentId: fields.parentId ?? null,
    title: fields.title,
    description: `About ${fields.title}`,
    priority: fields.priority ?? null,
    startDate: null,
    dueDate: null,
    position: fields.sequenceNumber,
    createdAt: `2026-01-0${fields.sequenceNumber % 9}T10:00:00.000Z`,
    updatedAt: "2026-02-01T10:00:00.000Z",
    archivedAt: fields.archivedAt ?? null,
    labelIds: [],
    fieldValues: [],
    ...(fields.links ? { links: fields.links, subtaskCount: 0 } : {}),
  };
}

function feedItem(fields: {
  id: number;
  kind?: string;
  replyToId?: number;
  actorUserId: string;
  actorName: string;
  body: string;
  createdAt: string;
}) {
  return {
    issueId: 101,
    kind: "comment",
    replyToId: null,
    action: null,
    payload: {},
    ...fields,
  };
}

async function startFakeItsaplan(): Promise<FakeItsaplan> {
  const initiative = { id: 501, title: "Launch", status: "active" };
  const fake: Omit<FakeItsaplan, "baseUrl" | "close"> = {
    requests: [],
    maxInFlight: 0,
    failOnce: new Set(["/projects/PASEO/issues/board"]),
    rateLimited: new Set(),
    boardIssues: [
      issue({
        id: 101,
        sequenceNumber: 1,
        columnId: 11,
        title: "Parent",
        assigneeUserId: HUMAN,
        priority: "high",
        typeId: 1,
        initiative,
        links: [{ id: 900, relation: "blocks", issueId: 102 }],
      }),
      issue({
        id: 102,
        sequenceNumber: 2,
        columnId: 12,
        title: "Blocked child",
        parentId: 101,
        assigneeUserId: COMMANDER_BOT,
        links: [{ id: 900, relation: "blocked_by", issueId: 101 }],
      }),
      issue({
        id: 103,
        sequenceNumber: 7,
        columnId: 13,
        title: "Other",
        assigneeUserId: "bot-reviewer",
        priority: "none",
        links: [],
      }),
    ],
  };
  const archived = [
    issue({
      id: 104,
      sequenceNumber: 5,
      columnId: 14,
      title: "Shipped",
      archivedAt: "2026-03-01T00:00:00.000Z",
    }),
  ];
  const projectColumns = [
    column(10, "Backlog", "backlog", 1),
    column(11, "Todo", "unstarted", 2),
    column(12, "In Progress", "started", 3),
    column(13, "QA", "started", 4),
    column(14, "Done", "completed", 5),
    column(15, "Canceled", "canceled", 6),
  ];
  let inFlight = 0;

  const server: Server = createServer((req, res) => {
    inFlight += 1;
    fake.maxInFlight = Math.max(fake.maxInFlight, inFlight);
    const send = (status: number, body: unknown, contentType = "application/json"): void => {
      // Answer after the poll phase, so requests that arrive together overlap in flight.
      setImmediate(() => {
        inFlight -= 1;
        res.writeHead(status, { "content-type": contentType });
        res.end(contentType === "application/json" ? JSON.stringify(body) : (body as Buffer));
      });
    };
    if (req.headers["x-api-key"] !== API_KEY) {
      send(401, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    fake.requests.push(`${route}${url.search}`);
    if (req.method !== "GET") {
      send(405, { error: "the import must not write" });
      return;
    }
    if (fake.failOnce.delete(url.pathname)) {
      send(503, { error: "try again" });
      return;
    }
    if (fake.rateLimited.has(url.pathname)) {
      send(429, { error: "slow down" });
      return;
    }
    const emptyProjectPaths: Record<string, unknown> = {
      "/projects/EMPTY": { project: { id: 2, key: "EMPTY" }, columns: [], issueTypes: [] },
      "/projects/EMPTY/issues/board": { issues: [] },
      "/projects/EMPTY/issues/archived": [],
      "/projects/EMPTY/initiatives": { items: [], total: 0, page: 1, pageSize: 100 },
    };
    if (url.pathname in emptyProjectPaths) {
      send(200, emptyProjectPaths[url.pathname]);
      return;
    }
    switch (url.pathname) {
      case "/projects":
        send(200, [
          { id: 1, key: "PASEO", name: "Paseo", description: "", createdAt: T0, role: "owner" },
          { id: 2, key: "EMPTY", name: "Empty", description: "", createdAt: T0, role: "owner" },
        ]);
        return;
      case "/projects/PASEO":
        send(200, {
          project: { id: 1, key: "PASEO", name: "Paseo" },
          columns: projectColumns,
          issueTypes: [{ id: 1, name: "Bug", icon: "bug", color: "red", isDefault: false }],
          labels: [],
          assignees: [
            { userId: HUMAN, name: "Ramon", username: "ramon", kind: "member" },
            { userId: COMMANDER_BOT, name: "Commander", username: "commander", kind: "agent" },
            { userId: "bot-reviewer", name: "Reviewer", username: "reviewer", kind: "agent" },
          ],
        });
        return;
      case "/projects/PASEO/issues/board":
        send(200, { issues: fake.boardIssues });
        return;
      case "/projects/PASEO/issues/archived":
        send(200, archived);
        return;
      case "/projects/PASEO/initiatives":
        send(200, {
          items: [
            {
              ...initiative,
              projectId: 1,
              description: "Ship it",
              ownerUserId: null,
              priority: "high",
              startDate: "2026-01-01",
              targetDate: "2026-06-30",
              position: 1,
              createdAt: T0,
              updatedAt: T0,
              labelIds: [],
              progress: { completed: 0, canceled: 0, total: 1 },
              health: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 100,
        });
        return;
      case "/issues/104":
        send(200, {
          ...archived[0],
          links: [
            { id: 901, kind: "blocks", direction: "inward", issue: { id: 103 } },
            { id: 902, kind: "relates", direction: "outward", issue: { id: 101 } },
          ],
        });
        return;
      case "/issues/101/feed":
        // Newest first; the replies of a thread follow it on its page.
        send(
          200,
          url.searchParams.get("cursor")
            ? {
                items: [
                  feedItem({
                    id: 7000,
                    actorUserId: "someone",
                    actorName: "Old Timer",
                    body: "Oldest",
                    createdAt: "2026-01-02T00:00:00.000Z",
                  }),
                ],
                nextCursor: null,
              }
            : {
                items: [
                  feedItem({
                    id: 7002,
                    kind: "activity",
                    actorUserId: HUMAN,
                    actorName: "Ramon",
                    body: "",
                    createdAt: "2026-01-04T00:00:00.000Z",
                  }),
                  feedItem({
                    id: 7001,
                    actorUserId: HUMAN,
                    actorName: "Ramon",
                    body: "First",
                    createdAt: "2026-01-03T00:00:00.000Z",
                  }),
                  feedItem({
                    id: 7003,
                    replyToId: 7001,
                    actorUserId: COMMANDER_BOT,
                    actorName: "Commander",
                    body: "On it",
                    createdAt: "2026-01-05T00:00:00.000Z",
                  }),
                ],
                nextCursor: { ts: "2026-01-03 00:00:00+00", id: 7001 },
              },
        );
        return;
      case "/issues/101/attachments":
        send(200, [
          {
            id: "pub-att-1",
            filename: "shot.png",
            contentType: "image/png",
            sizeBytes: 4,
            createdAt: "2026-01-03T00:00:00.000Z",
            url: "/attachments/pub-att-1/raw",
          },
        ]);
        return;
      case "/attachments/pub-att-1/raw":
        send(200, Buffer.from("PNG!"), "image/png");
        return;
    }
    if (/^\/issues\/\d+\/feed$/.test(url.pathname)) {
      send(200, { items: [], nextCursor: null });
      return;
    }
    if (/^\/issues\/\d+\/attachments$/.test(url.pathname)) {
      send(200, []);
      return;
    }
    send(404, { error: `unhandled ${route}` });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
      server.close(() => resolveClosed());
      return closed;
    },
  });
}

function agent(
  id: string,
  issueId: number | null,
  fields: Partial<ItsaplanImportAgentRecord> = {},
): ItsaplanImportAgentRecord {
  return {
    id,
    labels: issueId === null ? {} : { [ITSAPLAN_ISSUE_LABEL_KEY]: String(issueId) },
    title: `Agent ${id}`,
    name: id.toUpperCase(),
    archivedAt: null,
    createdAt: T0,
    updatedAt: "2026-02-02T00:00:00.000Z",
    ...fields,
  };
}

describe("ItsaplanTicketImporter", () => {
  let directory: string;
  let store: TicketStore;
  let service: TicketService;
  let itsaplan: FakeItsaplan;
  let projectStore: ItsaplanProjectStore;
  let changes: TicketsChange[];
  let importer: ItsaplanTicketImporter;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "paseo-tickets-import-"));
    const opened = await TicketStore.open({
      directory: path.join(directory, "tickets"),
      logger: createTestLogger(),
    });
    if (!opened) {
      throw new Error("node:sqlite is required for the tickets tests");
    }
    store = opened;
    service = new TicketService({ store, logger: createTestLogger() });
    changes = [];
    service.onChange((change) => changes.push(change));
    itsaplan = await startFakeItsaplan();
    projectStore = new ItsaplanProjectStore({ paseoHome: directory, logger: createTestLogger() });
    await projectStore.initialize();
    await projectStore.upsert({
      paseoProjectKey: "paseo",
      itsaplanProjectId: 1,
      itsaplanProjectKey: "PASEO",
      createdAt: T0,
      commanderUserId: COMMANDER_BOT,
    });
    const config: ItsaplanCentralConfig = {
      baseUrl: itsaplan.baseUrl,
      apiKey: API_KEY,
      webhookSecret: "whsec",
      humanUserId: HUMAN,
    };
    const buckets: Record<string, LifecycleBucket> = { "agent-1": "running", "agent-2": "done" };
    importer = new ItsaplanTicketImporter({
      ticketStore: store,
      ticketService: service,
      getConfig: () => config,
      projectStore,
      agentStorage: {
        list: async () => [
          agent("agent-1", 102),
          agent("agent-2", 104, { archivedAt: "2026-03-02T00:00:00.000Z" }),
          agent("agent-3", null),
          agent("agent-4", 999),
        ],
      },
      missionControl: { getLifecycleBucket: async (agentId) => buckets[agentId] ?? "idle" },
      serverId: "srv-local",
      logger: createTestLogger(),
      retry: { baseDelayMs: 1, maxDelayMs: 4 },
    });
  });

  afterEach(async () => {
    await itsaplan.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  function ticket(key: string): TicketDetail {
    const detail = service.getTicket({ key });
    if (!detail) {
      throw new Error(`No ticket ${key}`);
    }
    return detail;
  }

  function rowCounts(): Record<string, number> {
    return store.withTransaction((db) =>
      Object.fromEntries(
        [
          "boards",
          "columns",
          "tickets",
          "ticket_links",
          "activity",
          "attachments",
          "initiatives",
          "runs",
        ].map((table) => [
          table,
          Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n),
        ]),
      ),
    );
  }

  test("imports one board per non-empty project with its tickets, comments, links, attachments and runs", async () => {
    const report = await importer.run();

    expect(report).toEqual({
      boards: 1,
      tickets: 4,
      comments: 3,
      attachments: 1,
      initiatives: 1,
      links: 2,
      runs: 2,
      updated: 0,
      errors: [],
    });
    expect(itsaplan.requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(itsaplan.maxInFlight).toBeLessThanOrEqual(2);

    const boards = service.listBoards();
    expect(boards.map((board) => [board.key, board.name, board.projectKey])).toEqual([
      ["PASEO", "Paseo", "paseo"],
    ]);
    const [board] = boards;
    expect(board.externalRef).toEqual({ system: "itsaplan", id: 1, identifier: "PASEO" });
    expect(board.columns.map((c) => [c.name, c.stateType])).toEqual([
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["QA", "started"],
      ["Done", "completed"],
      ["Canceled", "canceled"],
    ]);
    const columnName = (columnId: string) => board.columns.find((c) => c.id === columnId)?.name;

    const [initiative] = service.listInitiatives(board.id);
    expect(initiative).toMatchObject({
      title: "Launch",
      description: "Ship it",
      status: "active",
      priority: "high",
      startDate: "2026-01-01",
      targetDate: "2026-06-30",
      externalRef: { system: "itsaplan", id: 501 },
    });

    const parent = ticket("PASEO-1");
    expect(parent).toMatchObject({
      title: "Parent",
      description: "About Parent",
      assignee: "user",
      priority: "high",
      type: "Bug",
      initiativeId: initiative.id,
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-02-01T10:00:00.000Z",
      externalRef: { system: "itsaplan", id: 101, identifier: "PASEO-1" },
    });
    expect(columnName(parent.columnId)).toBe("Todo");
    expect(parent.subtasks.map((t) => t.key)).toEqual(["PASEO-2"]);
    expect(parent.blocks.map((t) => t.key)).toEqual(["PASEO-2"]);
    const comments = parent.activity.filter((entry) => entry.kind === "comment");
    expect(comments.map((c) => [c.body, c.actor, c.createdAt])).toEqual([
      ["Oldest", { kind: "imported", name: "Old Timer" }, "2026-01-02T00:00:00.000Z"],
      ["First", { kind: "imported", name: "Ramon" }, "2026-01-03T00:00:00.000Z"],
      ["On it", { kind: "commander" }, "2026-01-05T00:00:00.000Z"],
    ]);
    expect(comments[2].replyToId).toBe(comments[1].id);
    expect(
      parent.activity.filter((entry) => entry.kind === "event").map((e) => e.eventType),
    ).toEqual(["imported"]);
    expect(parent.attachments.map((a) => [a.fileName, a.mimeType, a.size])).toEqual([
      ["shot.png", "image/png", 4],
    ]);
    const file = await service.readAttachment(parent.attachments[0].id);
    expect(file?.data.toString()).toBe("PNG!");

    const child = ticket("PASEO-2");
    expect(child).toMatchObject({ parentId: parent.id, assignee: "commander" });
    expect(columnName(child.columnId)).toBe("In Progress");
    expect(child.blockedBy.map((t) => t.key)).toEqual(["PASEO-1"]);
    expect(child.runs).toEqual([
      {
        ticketId: child.id,
        agentId: "agent-1",
        serverId: "srv-local",
        bucket: "running",
        agentTitle: "Agent agent-1",
        agentName: "AGENT-1",
        archived: false,
        startedAt: T0,
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
    ]);

    // A priority itsaplan has but tickets do not ("none") and a bot that is
    // not the Commander both map to nothing.
    expect(ticket("PASEO-7")).toMatchObject({ priority: null, assignee: null });
    expect(columnName(ticket("PASEO-7").columnId)).toBe("QA");

    const archivedTicket = ticket("PASEO-5");
    expect(archivedTicket.archivedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(archivedTicket.blockedBy.map((t) => t.key)).toEqual(["PASEO-7"]);
    expect(archivedTicket.runs.map((run) => [run.agentId, run.bucket, run.archived])).toEqual([
      ["agent-2", "done", true],
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0].boardIds).toEqual([board.id]);
    expect(new Set(changes[0].ticketIds)).toEqual(
      new Set(["PASEO-1", "PASEO-2", "PASEO-5", "PASEO-7"].map((key) => ticket(key).id)),
    );
    expect(changes[0].initiativeIds).toEqual([initiative.id]);

    // Native tickets continue after the highest imported number.
    const native = service.createTicket(
      { boardId: board.id, title: "Native", columnId: parent.columnId },
      { kind: "user" },
    );
    expect(native.key).toBe("PASEO-8");
  });

  test("a second run creates nothing and changes nothing", async () => {
    await importer.run();
    const rowsAfterFirst = rowCounts();
    const revisionAfterFirst = store.getRevision();

    const report = await importer.run();

    expect(report).toEqual({
      boards: 0,
      tickets: 0,
      comments: 0,
      attachments: 0,
      initiatives: 0,
      links: 0,
      runs: 0,
      updated: 0,
      errors: [],
    });
    expect(rowCounts()).toEqual(rowsAfterFirst);
    expect(store.getRevision()).toBe(revisionAfterFirst);
    expect(changes).toHaveLength(1);
    // An imported attachment is not downloaded again.
    expect(
      itsaplan.requests.filter((request) => request === "GET /attachments/pub-att-1/raw"),
    ).toHaveLength(1);
  });

  test("a re-run updates the fields that changed in itsaplan and counts them", async () => {
    await importer.run();
    const rowsAfterFirst = rowCounts();
    itsaplan.boardIssues[2] = { ...itsaplan.boardIssues[2], title: "Renamed", columnId: 14 };

    const report = await importer.run();

    expect(report).toMatchObject({ boards: 0, tickets: 0, updated: 1, errors: [] });
    expect(rowCounts()).toEqual(rowsAfterFirst);
    const renamed = ticket("PASEO-7");
    expect(renamed.title).toBe("Renamed");
    expect(service.listBoards()[0].columns.find((c) => c.id === renamed.columnId)?.name).toBe(
      "Done",
    );
    expect(changes.at(-1)?.ticketIds).toEqual([renamed.id]);
  });

  test("a request that stays rate limited is tried six times, reported, and the import goes on", async () => {
    itsaplan.rateLimited.add("/issues/101/attachments");

    const report = await importer.run();

    expect(report).toMatchObject({ boards: 1, tickets: 4, comments: 3, attachments: 0 });
    expect(report.errors).toEqual([
      'PASEO-1: attachments: itsaplan GET /issues/101/attachments failed: 429 {"error":"slow down"}',
    ]);
    expect(
      itsaplan.requests.filter((request) => request === "GET /issues/101/attachments"),
    ).toHaveLength(6);
  });

  test("an unused native board of the project becomes the imported board", async () => {
    const native = service.ensureBoard({ projectKey: "paseo", name: "Paseo", key: "PAS" });

    const report = await importer.run();

    expect(report).toMatchObject({ boards: 1, errors: [] });
    const boards = service.listBoards();
    expect(boards.map((board) => [board.id, board.key, board.projectKey])).toEqual([
      [native.id, "PASEO", "paseo"],
    ]);
    // itsaplan's QA column sits between its itsaplan neighbours; the native
    // Ready to review column stays.
    expect(boards[0].columns.map((c) => c.name)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "QA",
      "Ready to review",
      "Done",
      "Canceled",
    ]);
  });
});
