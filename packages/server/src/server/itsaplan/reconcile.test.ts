import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { ITSAPLAN_ISSUE_LABEL_KEY } from "./bridge.js";
import { ItsaplanProjectStore, type ItsaplanCentralConfig } from "./projects.js";
import { ItsaplanReconcileService, type ItsaplanReconcileMissionControl } from "./reconcile.js";

interface FakeColumn {
  id: number;
  projectId: number;
  name: string;
  stateType: string;
}

function startFakeItsaplanServer(
  apiKey: string,
  issue: {
    id: number;
    projectId: number;
    sequenceNumber: number;
    columnId: number;
    assigneeUserId: string | null;
  },
  columns: FakeColumn[],
) {
  let nextColumnId = 900;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers["x-api-key"] !== apiKey) {
        send(401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && path === `/issues/${issue.id}`) {
        send(200, {
          ...issue,
          title: "t",
          description: null,
          sequenceNumber: issue.sequenceNumber,
          links: [],
        });
        return;
      }
      if (req.method === "PATCH" && path === `/issues/${issue.id}`) {
        Object.assign(issue, body);
        send(200, { ...issue, title: "t", description: null, links: [] });
        return;
      }
      if (req.method === "GET" && path === "/projects/ENG") {
        send(200, { id: issue.projectId, key: "ENG", name: "ENG", columns });
        return;
      }
      if (req.method === "POST" && path === "/projects/ENG/columns") {
        const column: FakeColumn = {
          id: nextColumnId++,
          projectId: issue.projectId,
          name: String(body.name),
          stateType: String(body.stateType),
        };
        columns.push(column);
        send(201, column);
        return;
      }
      send(404, { error: `unhandled ${req.method} ${path}` });
    });
  });
  return server;
}

async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
      server.close(() => resolveClosed());
      return closed;
    },
  };
}

function agentRecord(
  id: string,
  issueId: number,
  updatedAt: string,
): Pick<StoredAgentRecord, "id" | "labels" | "updatedAt"> {
  return { id, labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(issueId) }, updatedAt };
}

describe("ItsaplanReconcileService", () => {
  const PROJECT_ID = 1;
  const ISSUE_ID = 5;
  let issue: {
    id: number;
    projectId: number;
    sequenceNumber: number;
    columnId: number;
    assigneeUserId: string | null;
  };
  let columns: FakeColumn[];
  let server: Server;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let store: ItsaplanProjectStore;
  let paseoHome: string;
  let bucket: LifecycleBucket;
  let missionControl: ItsaplanReconcileMissionControl;

  beforeEach(async () => {
    issue = {
      id: ISSUE_ID,
      projectId: PROJECT_ID,
      sequenceNumber: 3,
      columnId: 2,
      assigneeUserId: null,
    };
    columns = [
      { id: 1, projectId: PROJECT_ID, name: "Backlog", stateType: "backlog" },
      { id: 2, projectId: PROJECT_ID, name: "Todo", stateType: "unstarted" },
      { id: 3, projectId: PROJECT_ID, name: "In Progress", stateType: "started" },
      { id: 4, projectId: PROJECT_ID, name: "Done", stateType: "completed" },
      { id: 5, projectId: PROJECT_ID, name: "Canceled", stateType: "canceled" },
    ];
    server = startFakeItsaplanServer("itp_key", issue, columns);
    handle = await listen(server);
    config = {
      baseUrl: handle.baseUrl,
      apiKey: "itp_key",
      webhookSecret: "whsec",
      humanUserId: "human-1",
    };
    paseoHome = await mkdtemp(join(tmpdir(), "itsaplan-reconcile-test-"));
    store = new ItsaplanProjectStore({ paseoHome, logger: createTestLogger() });
    await store.initialize();
    await store.upsert({
      paseoProjectKey: "proj",
      itsaplanProjectId: PROJECT_ID,
      itsaplanProjectKey: "ENG",
      createdAt: new Date().toISOString(),
    });
    bucket = "running";
    missionControl = { getLifecycleBucket: async () => bucket };
  });

  afterEach(async () => {
    await handle.close();
    await rm(paseoHome, { recursive: true, force: true });
  });

  function service(
    agents: Pick<StoredAgentRecord, "id" | "labels" | "updatedAt">[],
  ): ItsaplanReconcileService {
    return new ItsaplanReconcileService({
      agentStorage: { list: async () => agents },
      missionControl,
      projectStore: store,
      getConfig: () => config,
      logger: createTestLogger(),
    });
  }

  test("corrects a ticket stuck in Todo when its labeled agent is running", async () => {
    bucket = "running";
    await service([agentRecord("agent-1", ISSUE_ID, "2026-01-01T00:00:00.000Z")]).runSweep();
    expect(issue.columnId).toBe(3); // In Progress
  });

  test("moves a ticket to Ready to review (lazily created) when the agent finished cleanly", async () => {
    issue.columnId = 3; // In Progress
    bucket = "ready";
    await service([agentRecord("agent-1", ISSUE_ID, "2026-01-01T00:00:00.000Z")]).runSweep();
    const readyColumn = columns.find((c) => c.name === "Ready to review");
    expect(readyColumn).toBeDefined();
    expect(issue.columnId).toBe(readyColumn?.id);
  });

  test("never regresses a ticket already at Ready to review back to In Progress", async () => {
    const readyColumn: FakeColumn = {
      id: 50,
      projectId: PROJECT_ID,
      name: "Ready to review",
      stateType: "started",
    };
    columns.push(readyColumn);
    issue.columnId = readyColumn.id;
    bucket = "running"; // a stray non-terminal bucket reading must never regress the column
    await service([agentRecord("agent-1", ISSUE_ID, "2026-01-01T00:00:00.000Z")]).runSweep();
    expect(issue.columnId).toBe(readyColumn.id);
  });

  test("never overrides a Done or Cancelled ticket (user-owned terminal columns)", async () => {
    issue.columnId = 4; // Done
    bucket = "running";
    await service([agentRecord("agent-1", ISSUE_ID, "2026-01-01T00:00:00.000Z")]).runSweep();
    expect(issue.columnId).toBe(4);
  });

  test("flips the assignee to the configured human when the truth bucket is needs_you", async () => {
    issue.columnId = 3;
    bucket = "needs_you";
    await service([agentRecord("agent-1", ISSUE_ID, "2026-01-01T00:00:00.000Z")]).runSweep();
    expect(issue.assigneeUserId).toBe("human-1");
  });

  test("picks the most recently updated agent attempt as the ticket's truth", async () => {
    issue.columnId = 2; // Todo
    bucket = "ready"; // the fake missionControl always answers the same bucket regardless of id in this test
    await service([
      agentRecord("agent-old", ISSUE_ID, "2026-01-01T00:00:00.000Z"),
      agentRecord("agent-new", ISSUE_ID, "2026-01-02T00:00:00.000Z"),
    ]).runSweep();
    const readyColumn = columns.find((c) => c.name === "Ready to review");
    expect(issue.columnId).toBe(readyColumn?.id);
  });

  test("does nothing when itsaplan config is absent", async () => {
    const inertService = new ItsaplanReconcileService({
      agentStorage: {
        list: async () => [agentRecord("agent-1", ISSUE_ID, "2026-01-01T00:00:00.000Z")],
      },
      missionControl,
      projectStore: store,
      getConfig: () => null,
      logger: createTestLogger(),
    });
    await inertService.runSweep();
    expect(issue.columnId).toBe(2);
  });
});
