import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  ITSAPLAN_ISSUE_LABEL_KEY,
  ItsaplanBridge,
  type ItsaplanBridgeAgentManager,
  type ItsaplanBridgeAgentStorage,
  type ItsaplanBridgeMissionControl,
} from "./bridge.js";
import { ItsaplanProjectStore, type ItsaplanCentralConfig } from "./projects.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import {
  MISSION_CONTROL_LABEL_KEY,
  MISSION_CONTROL_LABEL_VALUE,
} from "../mission-control/commander-contract.js";

// ---------------------------------------------------------------------------
// In-test fake itsaplan HTTP server (acceptance: "node http, in-test").
// ---------------------------------------------------------------------------

interface FakeIssue {
  id: number;
  projectId: number;
  sequenceNumber: number;
  columnId: number;
  title: string;
  description: string | null;
  assigneeUserId: string | null;
  labelIds?: number[];
  links: Array<{
    id: number;
    kind: string;
    direction: "outward" | "inward";
    issue: { id: number };
  }>;
}

interface FakeLabel {
  id: number;
  projectId: number;
  name: string;
  color?: string;
}
interface FakeColumn {
  id: number;
  projectId: number;
  name: string;
  stateType: string;
}

async function waitForIssueColumn(
  issues: Map<number, FakeIssue>,
  issueId: number,
  columnId: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(issues.get(issueId)?.columnId).toBe(columnId);
  });
}

async function waitForCreatedColumn(
  createdColumns: Array<{ projectKey: string; name: string; stateType: string }>,
  expected: { projectKey: string; name: string; stateType: string },
): Promise<void> {
  await vi.waitFor(() => {
    expect(createdColumns).toContainEqual(expected);
  });
}

async function waitForIssueAssignee(
  issues: Map<number, FakeIssue>,
  issueId: number,
  assigneeUserId: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(issues.get(issueId)?.assigneeUserId).toBe(assigneeUserId);
  });
}

function findColumnByName(columns: Map<number, FakeColumn>, name: string): FakeColumn | undefined {
  return Array.from(columns.values()).find((column) => column.name === name);
}

function startFakeItsaplanServer(options: {
  apiKey: string;
  issues: Map<number, FakeIssue>;
  columns: Map<number, FakeColumn>;
  labels?: Map<number, FakeLabel>;
  projectIdByKey: Map<string, number>;
}) {
  const comments: Array<{ issueId: number; body: string }> = [];
  const createdColumns: Array<{ projectKey: string; name: string; stateType: string }> = [];
  let nextColumnId = 1000;
  let nextLabelId = 2000;
  let nextIssueId = 3000;
  const labelsMap = options.labels ?? new Map<number, FakeLabel>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    // eslint-disable-next-line complexity -- in-test HTTP router
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers["x-api-key"] !== options.apiKey) {
        send(401, { error: "unauthorized" });
        return;
      }
      const path = url.pathname;
      const issueMatch = /^\/issues\/(\d+)$/.exec(path);
      const commentMatch = /^\/issues\/(\d+)\/comments$/.exec(path);
      const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
      const columnsMatch = /^\/projects\/([^/]+)\/columns$/.exec(path);
      const labelsMatch = /^\/projects\/([^/]+)\/labels$/.exec(path);
      const issuesMatch = /^\/projects\/([^/]+)\/issues$/.exec(path);
      if (req.method === "GET" && issueMatch) {
        const issue = options.issues.get(Number(issueMatch[1]));
        send(issue ? 200 : 404, issue ?? { error: "not found" });
        return;
      }
      if (req.method === "PATCH" && issueMatch) {
        const issue = options.issues.get(Number(issueMatch[1]));
        if (!issue) {
          send(404, { error: "not found" });
          return;
        }
        Object.assign(issue, body);
        send(200, issue);
        return;
      }
      if (req.method === "POST" && commentMatch) {
        comments.push({ issueId: Number(commentMatch[1]), body: String(body.body) });
        send(200, { id: comments.length });
        return;
      }
      if (req.method === "GET" && projectMatch) {
        const key = decodeURIComponent(projectMatch[1]);
        const projectId = options.projectIdByKey.get(key);
        if (projectId === undefined) {
          send(404, { error: "not found" });
          return;
        }
        const columns = Array.from(options.columns.values()).filter(
          (c) => c.projectId === projectId,
        );
        const labels = Array.from(labelsMap.values()).filter((l) => l.projectId === projectId);
        send(200, { id: projectId, key, name: key, columns, labels });
        return;
      }
      if (req.method === "POST" && labelsMatch) {
        const key = decodeURIComponent(labelsMatch[1]);
        const projectId = options.projectIdByKey.get(key);
        if (projectId === undefined) {
          send(404, { error: "not found" });
          return;
        }
        const label: FakeLabel = {
          id: nextLabelId++,
          projectId,
          name: String(body.name),
          color: body.color ? String(body.color) : undefined,
        };
        labelsMap.set(label.id, label);
        send(201, label);
        return;
      }
      if (req.method === "POST" && issuesMatch) {
        const key = decodeURIComponent(issuesMatch[1]);
        const projectId = options.projectIdByKey.get(key);
        if (projectId === undefined) {
          send(404, { error: "not found" });
          return;
        }
        const id = nextIssueId++;
        const issue: FakeIssue = {
          id,
          projectId,
          sequenceNumber: id,
          columnId: Number(body.columnId),
          title: String(body.title),
          description: (body.description as string | null | undefined) ?? null,
          assigneeUserId: null,
          labelIds: (body.labelIds as number[] | undefined) ?? [],
          links: [],
        };
        options.issues.set(issue.id, issue);
        send(201, issue);
        return;
      }
      if (req.method === "POST" && columnsMatch) {
        const key = decodeURIComponent(columnsMatch[1]);
        const projectId = options.projectIdByKey.get(key);
        if (projectId === undefined) {
          send(404, { error: "not found" });
          return;
        }
        const column: FakeColumn = {
          id: nextColumnId++,
          projectId,
          name: String(body.name),
          stateType: String(body.stateType),
        };
        options.columns.set(column.id, column);
        createdColumns.push({ projectKey: key, name: column.name, stateType: column.stateType });
        send(201, column);
        return;
      }
      send(404, { error: `unhandled ${req.method} ${path}` });
    });
  });

  return { server, comments, createdColumns };
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

/** Lets a fire-and-forget async chain (e.g. a subscriber callback's `void`
 * promise) settle before asserting on its side effects — no real duration,
 * just an event-loop tick (mirrors event-forward.test.ts's flushAsync). */
function flushAsync(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}
function isNonDispatchComment(comment: { body: string }): boolean {
  return !comment.body.startsWith("Dispatched:");
}

function waitForNonDispatchComment(comments: Array<{ body: string }>): Promise<void> {
  return vi.waitFor(() => {
    expect(comments.some(isNonDispatchComment)).toBe(true);
  });
}

function waitForLastCommentBody(
  comments: Array<{ body: string }>,
  expected: string,
): Promise<void> {
  return vi.waitFor(() => {
    expect(comments.at(-1)?.body).toBe(expected);
  });
}

function waitForCommentEqual(
  comments: Array<{ issueId: number; body: string }>,
  expected: { issueId: number; body: string },
): Promise<void> {
  return vi.waitFor(() => {
    expect(comments).toContainEqual(expected);
  });
}

function findCommentIncluding(
  comments: Array<{ body: string }>,
  snippet: string,
): { body: string } | undefined {
  return comments.find((comment) => comment.body.includes(snippet));
}

function signBody(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

// ---------------------------------------------------------------------------
// Fake bridge dependencies.
// ---------------------------------------------------------------------------

function createFakeAgentManager(): {
  manager: ItsaplanBridgeAgentManager;
  emit: (event: AgentManagerEvent) => void;
  setAgent: (agent: ManagedAgent) => void;
} {
  let listener: ((event: AgentManagerEvent) => void) | null = null;
  const agents = new Map<string, ManagedAgent>();
  return {
    manager: {
      subscribe: (callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
      getAgent: (agentId) => agents.get(agentId) ?? null,
      setLabels: async (agentId, patch) => {
        const agent = agents.get(agentId);
        if (agent) {
          agent.labels = { ...agent.labels };
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete agent.labels[k];
            else agent.labels[k] = v;
          }
        }
      },
    },
    emit: (event) => {
      if (event.type === "agent_state") {
        agents.set(event.agent.id, event.agent);
      }
      listener?.(event);
    },
    setAgent: (agent) => {
      agents.set(agent.id, agent);
    },
  };
}

function createFakeAgentStorage(
  records: Pick<
    StoredAgentRecord,
    "id" | "labels" | "updatedAt" | "title" | "name" | "shortDescription" | "cwd" | "workspaceId"
  >[] = [],
): ItsaplanBridgeAgentStorage {
  return {
    get: async (agentId) => records.find((r) => r.id === agentId) ?? null,
    list: async () => records,
  };
}

function createFakeMissionControl(initialBucket: LifecycleBucket): {
  control: ItsaplanBridgeMissionControl;
  emitSelfReport: (event: MissionControlEvent) => void;
  emitEvent: (event: MissionControlEvent) => void;
  setBucket: (bucket: LifecycleBucket) => void;
} {
  let selfReportListener: ((event: MissionControlEvent) => void) | null = null;
  let eventListener: ((event: MissionControlEvent) => void) | null = null;
  let bucket = initialBucket;
  return {
    control: {
      subscribeSelfReports: (callback) => {
        selfReportListener = callback;
        return () => {
          selfReportListener = null;
        };
      },
      subscribeEvents: (callback) => {
        eventListener = callback;
        return () => {
          eventListener = null;
        };
      },
      getLifecycleBucket: async () => bucket,
    },
    emitSelfReport: (event) => selfReportListener?.(event),
    emitEvent: (event) => eventListener?.(event),
    setBucket: (next) => {
      bucket = next;
    },
  };
}

function fakeAgent(id: string, labels: Record<string, string>): ManagedAgent {
  return { id, labels, internal: false, cwd: `/tmp/${id}` } as unknown as ManagedAgent;
}

describe("ItsaplanBridge", () => {
  let issues: Map<number, FakeIssue>;
  let columns: Map<number, FakeColumn>;
  let labels: Map<number, FakeLabel>;
  let projectIdByKey: Map<string, number>;
  let fakeServer: ReturnType<typeof startFakeItsaplanServer>;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let projectStore: ItsaplanProjectStore;
  let deliverMachineryPrompt: ReturnType<typeof vi.fn>;
  let steerWorkerPrompt: ReturnType<typeof vi.fn>;
  let agentStorageRecords: Pick<StoredAgentRecord, "id" | "labels" | "updatedAt">[];
  let agentManagerFake: ReturnType<typeof createFakeAgentManager>;
  let missionControlFake: ReturnType<typeof createFakeMissionControl>;
  let bridge: ItsaplanBridge;

  const PROJECT_KEY = "ENG";
  const PROJECT_ID = 1;
  const ISSUE_ID = 100;

  beforeEach(async () => {
    issues = new Map([
      [
        ISSUE_ID,
        {
          id: ISSUE_ID,
          projectId: PROJECT_ID,
          sequenceNumber: 42,
          columnId: 2,
          title: "Fix the bug",
          description: "Steps to reproduce...",
          assigneeUserId: null,
          links: [],
        },
      ],
    ]);
    columns = new Map([
      [1, { id: 1, projectId: PROJECT_ID, name: "Backlog", stateType: "backlog" }],
      [2, { id: 2, projectId: PROJECT_ID, name: "Todo", stateType: "unstarted" }],
      [3, { id: 3, projectId: PROJECT_ID, name: "In Progress", stateType: "started" }],
      [4, { id: 4, projectId: PROJECT_ID, name: "Done", stateType: "completed" }],
      [5, { id: 5, projectId: PROJECT_ID, name: "Canceled", stateType: "canceled" }],
    ]);
    projectIdByKey = new Map([[PROJECT_KEY, PROJECT_ID]]);
    labels = new Map([[50, { id: 50, projectId: PROJECT_ID, name: "auto-chain" }]]);
    fakeServer = startFakeItsaplanServer({
      apiKey: "itp_test_key",
      issues,
      columns,
      labels,
      projectIdByKey,
    });
    handle = await listen(fakeServer.server);
    config = {
      baseUrl: handle.baseUrl,
      apiKey: "itp_test_key",
      webhookSecret: "whsec_test",
      humanUserId: "human-1",
    };
    projectStore = new ItsaplanProjectStore({
      paseoHome: `/tmp/itsaplan-bridge-test-${Math.random()}`,
      logger: createTestLogger(),
    });
    await projectStore.upsert({
      paseoProjectKey: "proj",
      itsaplanProjectId: PROJECT_ID,
      itsaplanProjectKey: PROJECT_KEY,
      createdAt: new Date().toISOString(),
    });
    deliverMachineryPrompt = vi.fn(async () => true);
    steerWorkerPrompt = vi.fn(async () => {});
    agentStorageRecords = [];
    agentManagerFake = createFakeAgentManager();
    missionControlFake = createFakeMissionControl("running");
    bridge = new ItsaplanBridge({
      logger: createTestLogger(),
      serverId: "server-1",
      agentManager: agentManagerFake.manager,
      agentStorage: createFakeAgentStorage(agentStorageRecords),
      missionControl: missionControlFake.control,
      projectStore,
      getConfig: () => config,
      resolvePaseoProjectKey: async () => "proj",
      deliverMachineryPrompt,
      steerWorkerPrompt,
    });
    bridge.start();
  });

  describe("needs_you question comment", () => {
    function labeledRecord(
      agentId: string,
    ): Pick<StoredAgentRecord, "id" | "labels" | "updatedAt"> {
      return {
        id: agentId,
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      };
    }

    function commentRequest(
      actorUserId: string | null,
      body: string,
      eventId?: string,
    ): { rawBody: Buffer; headers: Record<string, string> } {
      const request = webhookRequest("comment.created", {
        id: 900,
        issueId: ISSUE_ID,
        kind: "comment",
        replyToId: null,
        actorUserId,
        actorName: actorUserId === config.humanUserId ? "Human" : "Someone",
        body,
        action: null,
        payload: {},
        createdAt: new Date().toISOString(),
      });
      if (eventId) {
        request.headers["x-itsaplan-event-id"] = eventId;
      }
      return request;
    }

    async function enterNeedsYou(agentId: string): Promise<void> {
      agentStorageRecords.push(labeledRecord(agentId));
      missionControlFake.setBucket("needs_you");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueAssignee(issues, ISSUE_ID, "human-1");
      await waitForNonDispatchComment(fakeServer.comments);
    }

    async function leaveNeedsYou(agentId: string): Promise<void> {
      missionControlFake.setBucket("running");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
    }

    test("posts one fallback question comment per needs_you entry, silent while it persists", async () => {
      await enterNeedsYou("agent-q1");
      await waitForCommentEqual(fakeServer.comments, {
        issueId: ISSUE_ID,
        body: "Waiting for input.",
      });
      const entryComments = fakeServer.comments.filter(isNonDispatchComment);
      // A second agent_state while still needs_you must not re-comment.
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-q1", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      await flushAsync();
      expect(fakeServer.comments.filter(isNonDispatchComment)).toEqual(entryComments);
    });

    test("quotes the latest clarification card in the entry comment", async () => {
      missionControlFake.emitEvent({
        id: "mce_c1",
        ts: new Date().toISOString(),
        seq: 1,
        agentId: "agent-q2",
        agentName: "agent-q2",
        agentTitle: "Agent Q2",
        kind: "clarification",
        source: "self",
        severity: "info",
        headline: "Need input",
        clarification: {
          question: "Which deployment target?",
          options: ["staging", "production"],
          allowFreeText: true,
        },
      } as unknown as MissionControlEvent);
      await enterNeedsYou("agent-q2");
      const entryComment = findCommentIncluding(fakeServer.comments, "Which deployment target?");
      expect(entryComment?.body).toContain("- staging");
      expect(entryComment?.body).toContain("- production");
    });

    test("steers a human comment into the waiting agent exactly once (retries deduped)", async () => {
      await enterNeedsYou("agent-s1");
      const request = commentRequest(config.humanUserId, "Use approach B please.", "evt-c1");
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(steerWorkerPrompt).toHaveBeenCalledTimes(1);
      expect(steerWorkerPrompt).toHaveBeenCalledWith("agent-s1", "Use approach B please.");
      // itsaplan retries the same delivery id on a hiccup — no second steer.
      const retried = await bridge.handleWebhookRequest(request);
      expect(retried.status).toBe(200);
      expect(steerWorkerPrompt).toHaveBeenCalledTimes(1);
    });

    test("ignores comments from other users and bots", async () => {
      await enterNeedsYou("agent-s2");
      const result = await bridge.handleWebhookRequest(commentRequest("other-user", "not for you"));
      expect(result.status).toBe(200);
      expect(steerWorkerPrompt).not.toHaveBeenCalled();
    });

    test("ignores a late human comment after the agent left needs_you", async () => {
      await enterNeedsYou("agent-s3");
      await leaveNeedsYou("agent-s3");
      const result = await bridge.handleWebhookRequest(
        commentRequest(config.humanUserId, "too late", "evt-c3"),
      );
      expect(result.status).toBe(200);
      expect(steerWorkerPrompt).not.toHaveBeenCalled();
    });
  });

  describe("needs_you convergence on exit", () => {
    async function runDirectAnswerScenario(agentId: string): Promise<void> {
      agentStorageRecords.push({
        id: agentId,
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("needs_you");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueAssignee(issues, ISSUE_ID, "human-1");
      missionControlFake.setBucket("running");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
    }

    test("direct answer in Paseo: convergence comment says so and assignee unassigns", async () => {
      await runDirectAnswerScenario("agent-x1");
      await waitForLastCommentBody(fakeServer.comments, "Resumed — answered directly in Paseo");
      await waitForIssueAssignee(issues, ISSUE_ID, null);
    });

    test("ticket-comment answer: convergence comment credits the ticket and assignee returns to the Commander user", async () => {
      await projectStore.upsert({
        paseoProjectKey: "proj",
        itsaplanProjectId: PROJECT_ID,
        itsaplanProjectKey: PROJECT_KEY,
        createdAt: new Date().toISOString(),
        commanderUserId: "bot-user-1",
      });
      const agentId = "agent-x2";
      agentStorageRecords.push({
        id: agentId,
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("needs_you");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueAssignee(issues, ISSUE_ID, "human-1");
      const request = webhookRequest("comment.created", {
        id: 901,
        issueId: ISSUE_ID,
        kind: "comment",
        replyToId: null,
        actorUserId: config.humanUserId,
        actorName: "Human",
        body: "ship it",
        action: null,
        payload: {},
        createdAt: new Date().toISOString(),
      });
      request.headers["x-itsaplan-event-id"] = "evt-c4";
      expect((await bridge.handleWebhookRequest(request)).status).toBe(200);
      expect(steerWorkerPrompt).toHaveBeenCalledTimes(1);
      missionControlFake.setBucket("running");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForLastCommentBody(fakeServer.comments, "Resumed — answered via ticket comment");
      await waitForIssueAssignee(issues, ISSUE_ID, "bot-user-1");
    });
  });

  afterEach(async () => {
    bridge.stop();
    await handle.close();
  });

  function webhookRequest(
    event: string,
    data: unknown,
    secretOverride?: string,
  ): { rawBody: Buffer; headers: Record<string, string> } {
    const rawBody = JSON.stringify({ event, data });
    const secret = secretOverride ?? config.webhookSecret;
    return {
      rawBody: Buffer.from(rawBody, "utf-8"),
      headers: { "x-itsaplan-signature": signBody(secret, rawBody) },
    };
  }

  describe("webhook signature verification", () => {
    test("rejects a missing signature", async () => {
      const result = await bridge.handleWebhookRequest({
        rawBody: Buffer.from(JSON.stringify({ event: "issue.state_changed", data: {} })),
        headers: {},
      });
      expect(result.status).toBe(401);
    });

    test("rejects a signature computed with the wrong secret", async () => {
      const request = webhookRequest("issue.state_changed", { id: ISSUE_ID }, "wrong-secret");
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(401);
    });

    test("accepts a validly signed payload", async () => {
      const request = webhookRequest("issue.updated", { id: ISSUE_ID });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
    });
  });

  describe("Todo -> machinery prompt", () => {
    test("dispatches exactly once for a Todo transition and dedupes a retried delivery", async () => {
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Fix the bug",
        description: "Steps to reproduce...",
      });
      request.headers["x-itsaplan-event-id"] = "evt-1";

      const first = await bridge.handleWebhookRequest(request);
      expect(first.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-42");
      expect(prompt).toContain(`"${ITSAPLAN_ISSUE_LABEL_KEY}": "${ISSUE_ID}"`);

      // Same delivery id retried (itsaplan's own retry semantics) — no second prompt.
      const second = await bridge.handleWebhookRequest(request);
      expect(second.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
    });

    test("ignores a move into a non-Todo column", async () => {
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 3, // In Progress, stateType "started"
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("skips dispatch while an open blocker exists", async () => {
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "inward", issue: { id: 200 } },
      ];
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 10,
        columnId: 3, // In Progress — still open, not completed/canceled
        title: "Blocker",
        description: null,
        assigneeUserId: null,
        links: [],
      });
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("dispatches once the blocker is done", async () => {
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "inward", issue: { id: 200 } },
      ];
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 10,
        columnId: 4, // Done — completed, no longer an open blocker
        title: "Blocker",
        description: null,
        assigneeUserId: null,
        links: [],
      });
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
    });

    test("B blocked by A, both Todo; A→Done (completed column) → Commander dispatch prompt for B fires", async () => {
      // Issue A (100) blocks Issue B (200), both in Todo (column 2)
      issues.get(ISSUE_ID)!.columnId = 2;
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 20,
        columnId: 2, // Todo
        title: "Blocked Issue B",
        description: "Depends on A",
        assigneeUserId: null,
        links: [{ id: 1, kind: "blocks", direction: "inward", issue: { id: ISSUE_ID } }],
      });
      // Link from A's perspective too (listIssueLinks on either returns the issue's links)
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "outward", issue: { id: 200 } },
      ];

      // Issue A moves to Done (column 4)
      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4, // Done (completed)
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-20");
      expect(prompt).toContain(`"${ITSAPLAN_ISSUE_LABEL_KEY}": "200"`);
    });

    test("same setup, A→Ready to review, A unlabeled → B does not dispatch", async () => {
      // Ensure "Ready to review" column exists
      columns.set(10, {
        id: 10,
        projectId: PROJECT_ID,
        name: "Ready to review",
        stateType: "started",
      });
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 20,
        columnId: 2, // Todo
        title: "Blocked Issue B",
        description: null,
        assigneeUserId: null,
        links: [{ id: 1, kind: "blocks", direction: "inward", issue: { id: ISSUE_ID } }],
      });
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "outward", issue: { id: 200 } },
      ];
      issues.get(ISSUE_ID)!.labelIds = []; // unlabeled

      // Issue A moves to Ready to review
      issues.get(ISSUE_ID)!.columnId = 10;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 10,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("same setup, A has auto-chain label, A→Ready to review → B dispatches", async () => {
      columns.set(10, {
        id: 10,
        projectId: PROJECT_ID,
        name: "Ready to review",
        stateType: "started",
      });
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 20,
        columnId: 2, // Todo
        title: "Blocked Issue B",
        description: "Will be unblocked",
        assigneeUserId: null,
        links: [{ id: 1, kind: "blocks", direction: "inward", issue: { id: ISSUE_ID } }],
      });
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "outward", issue: { id: 200 } },
      ];
      issues.get(ISSUE_ID)!.labelIds = [50]; // auto-chain label id is 50

      // Issue A moves to Ready to review
      issues.get(ISSUE_ID)!.columnId = 10;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 10,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-20");
      expect(prompt).toContain(`"${ITSAPLAN_ISSUE_LABEL_KEY}": "200"`);
    });

    test("unmapped itsaplan projects are left alone", async () => {
      const request = webhookRequest("issue.state_changed", {
        id: 999,
        projectId: 999,
        sequenceNumber: 1,
        columnId: 2,
        title: "Native itsaplan ticket",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });
  });

  describe("agent lifecycle projections", () => {
    test("moves the ticket to In Progress and comments a deep link when an agent is created with the label", async () => {
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-1", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, 3);
      expect(fakeServer.comments).toEqual([
        { issueId: ISSUE_ID, body: "Dispatched: paseo://h/server-1/agent/agent-1" },
      ]);
    });

    test("does not project agents without the itsaplan label", () => {
      // Synchronous early return (no label -> no async work spawned at all).
      agentManagerFake.emit({ type: "agent_state", agent: fakeAgent("agent-2", {}) });
      expect(issues.get(ISSUE_ID)?.columnId).toBe(2);
      expect(fakeServer.comments).toHaveLength(0);
    });

    test("projects report_status completed to a lazily-created Ready to review column, with proofs", async () => {
      agentManagerFake.setAgent(
        fakeAgent("agent-1", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      );
      issues.get(ISSUE_ID)!.columnId = 3; // already In Progress
      missionControlFake.emitSelfReport({
        id: "mce_1",
        ts: new Date().toISOString(),
        seq: 1,
        agentId: "agent-1",
        agentName: "agent-1",
        agentTitle: "Agent 1",
        kind: "finished",
        source: "self",
        severity: "info",
        headline: "Done",
        proof: [{ kind: "pr", url: "https://example.test/pr/1", label: "PR" }],
      } as unknown as MissionControlEvent);

      await waitForCreatedColumn(fakeServer.createdColumns, {
        projectKey: PROJECT_KEY,
        name: "Ready to review",
        stateType: "started",
      });
      const readyColumn = findColumnByName(columns, "Ready to review");
      expect(issues.get(ISSUE_ID)?.columnId).toBe(readyColumn?.id);
      expect(fakeServer.comments.at(-1)?.body).toContain("PR: https://example.test/pr/1");
    });
  });

  describe("needs_you projection", () => {
    test("flips the assignee exactly once per needs_you transition", async () => {
      missionControlFake.setBucket("needs_you");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-3", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueAssignee(issues, ISSUE_ID, "human-1");
      issues.get(ISSUE_ID)!.assigneeUserId = null;
      // Same event fired again while still needs_you: dedup means no repeat call.
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-3", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      await flushAsync();
      expect(issues.get(ISSUE_ID)?.assigneeUserId).toBeNull();
    });
  });

  describe("ticketizeAgent", () => {
    test("ticketizes a running unlabeled agent -> creates issue in In Progress + label + comment", async () => {
      const agentId = "agent-tick-1";
      const agent = fakeAgent(agentId, {});
      agentManagerFake.setAgent(agent);
      agentStorageRecords.push({
        id: agentId,
        title: "Feature implementation",
        shortDescription: "Implementing user feature",
        labels: {},
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("running");

      const result = await bridge.ticketizeAgent(agentId);
      expect("issueId" in result).toBe(true);
      if ("issueId" in result) {
        expect(result.issueId).toBeGreaterThanOrEqual(1000);
        expect(result.url).toContain(`/project/ENG/issues/${result.issueId}`);
        const created = issues.get(result.issueId);
        expect(created).toBeDefined();
        expect(created?.title).toBe("Feature implementation");
        expect(created?.description).toBe("Implementing user feature");
        expect(created?.columnId).toBe(3); // In Progress
        expect(agent.labels[ITSAPLAN_ISSUE_LABEL_KEY]).toBe(String(result.issueId));
        expect(fakeServer.comments).toContainEqual({
          issueId: result.issueId,
          body: `Dispatched: paseo://h/server-1/agent/${agentId}`,
        });
      }
    });

    test("is idempotent: second call returns existing issue without re-creating", async () => {
      const agentId = "agent-tick-2";
      const agent = fakeAgent(agentId, {});
      agentManagerFake.setAgent(agent);
      agentStorageRecords.push({
        id: agentId,
        title: "Existing task",
        shortDescription: "Task details",
        labels: {},
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("running");

      const first = await bridge.ticketizeAgent(agentId);
      const second = await bridge.ticketizeAgent(agentId);
      expect(first).toEqual(second);
    });

    test("returns error when project is unmapped", async () => {
      const unmappedBridge = new ItsaplanBridge({
        logger: createTestLogger(),
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage(agentStorageRecords),
        missionControl: missionControlFake.control,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => null, // unmapped
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      const result = await unmappedBridge.ticketizeAgent("agent-unmapped");
      expect(result).toEqual({ error: expect.stringContaining("No Paseo project found") });
    });

    test("bucket ready -> creates issue in Ready to review column", async () => {
      const agentId = "agent-tick-ready";
      const agent = fakeAgent(agentId, {});
      agentManagerFake.setAgent(agent);
      agentStorageRecords.push({
        id: agentId,
        title: "Ready task",
        labels: {},
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("ready");

      const result = await bridge.ticketizeAgent(agentId);
      expect("issueId" in result).toBe(true);
      if ("issueId" in result) {
        const created = issues.get(result.issueId);
        const readyCol = findColumnByName(columns, "Ready to review");
        expect(created?.columnId).toBe(readyCol?.id);
      }
    });

    test("bucket done -> creates issue in completed column", async () => {
      const agentId = "agent-tick-done";
      const agent = fakeAgent(agentId, {});
      agentManagerFake.setAgent(agent);
      agentStorageRecords.push({
        id: agentId,
        title: "Done task",
        labels: {},
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("done");

      const result = await bridge.ticketizeAgent(agentId);
      expect("issueId" in result).toBe(true);
      if ("issueId" in result) {
        const created = issues.get(result.issueId);
        expect(created?.columnId).toBe(4); // Done (completed)
      }
    });

    test("bucket idle -> creates issue in unstarted (Todo) column", async () => {
      const agentId = "agent-tick-idle";
      const agent = fakeAgent(agentId, {});
      agentManagerFake.setAgent(agent);
      agentStorageRecords.push({
        id: agentId,
        title: "Idle task",
        labels: {},
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("idle" as LifecycleBucket);

      const result = await bridge.ticketizeAgent(agentId);
      expect("issueId" in result).toBe(true);
      if ("issueId" in result) {
        const created = issues.get(result.issueId);
        expect(created?.columnId).toBe(2); // Todo (unstarted)
      }
    });

    test("fleet_ticketize_agent Commander tool creates ticket and returns structured outcome", async () => {
      const agentId = "11111111-2222-3333-4444-555555555555";
      const agent = fakeAgent(agentId, {});
      agentManagerFake.setAgent(agent);
      agentStorageRecords.push({
        id: agentId,
        title: "Tool ticket task",
        labels: {},
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("running");

      const catalog = createPaseoToolCatalog({
        agentManager: agentManagerFake.manager as never,
        agentStorage: createFakeAgentStorage(agentStorageRecords) as never,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager as never,
        callerLabels: { [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE },
        itsaplanTicketize: {
          ticketizeAgent: (id) => bridge.ticketizeAgent(id),
        },
        logger: createTestLogger(),
      });

      const result = await catalog.executeTool("fleet_ticketize_agent", { agentId });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        issueId: expect.any(Number),
        url: expect.stringContaining("/project/ENG/issues/"),
      });

      // Alias works identically
      const aliasResult = await catalog.executeTool("itsaplan_ticketize", { agentId });
      expect(aliasResult.structuredContent).toMatchObject({
        ok: true,
        issueId: expect.any(Number),
      });
    });

    test("fleet_ticketize_agent rejects non-Commander callers", async () => {
      const catalog = createPaseoToolCatalog({
        agentManager: agentManagerFake.manager as never,
        agentStorage: createFakeAgentStorage(agentStorageRecords) as never,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager as never,
        callerLabels: {}, // not Commander
        itsaplanTicketize: {
          ticketizeAgent: (id) => bridge.ticketizeAgent(id),
        },
        logger: createTestLogger(),
      });

      await expect(
        catalog.executeTool("fleet_ticketize_agent", {
          agentId: "11111111-2222-3333-4444-555555555555",
        }),
      ).rejects.toThrow("requires a Commander caller");
    });
  });

  describe("inert when config is absent", () => {
    test("webhook ingress returns 503 and lifecycle events no-op", async () => {
      const inertAgentManagerFake = createFakeAgentManager();
      const inertBridge = new ItsaplanBridge({
        logger: createTestLogger(),
        serverId: "server-1",
        agentManager: inertAgentManagerFake.manager,
        agentStorage: createFakeAgentStorage(),
        missionControl: missionControlFake.control,
        projectStore,
        getConfig: () => null,
        deliverMachineryPrompt,
        resolvePaseoProjectKey: async () => "proj",
        steerWorkerPrompt,
      });
      inertBridge.start();
      const result = await inertBridge.handleWebhookRequest({
        rawBody: Buffer.from("{}"),
        headers: {},
      });
      expect(result.status).toBe(503);

      // Synchronous early return (no config -> no async work spawned at all).
      inertAgentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-4", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      expect(issues.get(ISSUE_ID)?.columnId).toBe(2);
      expect(fakeServer.comments).toHaveLength(0);
      inertBridge.stop();
    });
  });
});
