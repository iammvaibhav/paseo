import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type {
  MissionControlEvent,
  MissionControlLifecycleAction,
} from "@getpaseo/protocol/mission-control/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  buildDispatchPrompt,
  extractProjectKeyFromIdentifier,
  ITSAPLAN_ISSUE_LABEL_KEY,
  ItsaplanBridge,
  type ItsaplanBridgeAgentManager,
  type ItsaplanBridgeAgentStorage,
  type ItsaplanBridgeFleet,
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
  identifier?: string;
  columnId: number;
  title: string;
  description: string | null;
  assigneeUserId: string | null;
  delegateUserId?: string | null;
  initiativeId?: number | null;
  initiative?: {
    id: number;
    title: string;
    description?: string | null;
    status?: string;
  } | null;
  labelIds?: number[];
  links: Array<{
    id: number;
    kind: string;
    direction: "outward" | "inward";
    issue: { id: number };
  }>;
}

interface FakeAttachment {
  id: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt?: string;
  url: string;
  bytes?: Buffer;
}

interface FakeInitiative {
  id: number;
  projectId: number;
  title: string;
  description?: string | null;
  status?: string;
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
  autoAssignUserId?: string | null;
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

function findColumnByNameAndProject(
  columns: Map<number, FakeColumn>,
  projectId: number,
  name: string,
): FakeColumn | undefined {
  return Array.from(columns.values()).find(
    (column) => column.projectId === projectId && column.name === name,
  );
}

interface FakeItsaplanServerHandle {
  server: Server;
  comments: Array<{ issueId: number; body: string; apiKey?: string }>;
  createdColumns: Array<{ projectKey: string; name: string; stateType: string }>;
}

function startFakeItsaplanServer(options: {
  apiKey: string;
  allowedApiKeys?: string[];
  issues: Map<number, FakeIssue>;
  columns: Map<number, FakeColumn>;
  labels?: Map<number, FakeLabel>;
  attachments?: Map<number, FakeAttachment[]>;
  initiatives?: Map<number, FakeInitiative>;
  projectIdByKey: Map<string, number>;
}): FakeItsaplanServerHandle {
  const comments: Array<{ issueId: number; body: string; apiKey?: string }> = [];
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
      const requestApiKey = String(req.headers["x-api-key"] ?? "");
      if (requestApiKey !== options.apiKey && !options.allowedApiKeys?.includes(requestApiKey)) {
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
      const attachmentsMatch = /^\/issues\/(\d+)\/attachments$/.exec(path);
      if (req.method === "GET" && attachmentsMatch) {
        const issueId = Number(attachmentsMatch[1]);
        const atts = options.attachments?.get(issueId) ?? [];
        send(200, atts);
        return;
      }
      const rawAttachmentMatch = /^\/attachments\/([^/]+)\/raw$/.exec(path);
      if (req.method === "GET" && rawAttachmentMatch) {
        const id = rawAttachmentMatch[1];
        for (const atts of options.attachments?.values() ?? []) {
          const att = atts.find((candidate) => candidate.id === id);
          if (att?.bytes) {
            res.writeHead(200, { "content-type": att.contentType ?? "application/octet-stream" });
            res.end(att.bytes);
            return;
          }
        }
        send(404, { error: "not found" });
        return;
      }
      const initiativeMatch = /^\/initiatives\/(\d+)$/.exec(path);
      if (req.method === "GET" && initiativeMatch) {
        const initId = Number(initiativeMatch[1]);
        const init = options.initiatives?.get(initId);
        send(init ? 200 : 404, init ?? { error: "not found" });
        return;
      }
      if (req.method === "POST" && commentMatch) {
        comments.push({
          issueId: Number(commentMatch[1]),
          body: String(body.body),
          apiKey: requestApiKey,
        });
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
      const columnPatchMatch = /^\/projects\/([^/]+)\/columns\/(\d+)$/.exec(path);
      if (req.method === "PATCH" && columnPatchMatch) {
        const columnId = Number(columnPatchMatch[2]);
        const column = options.columns.get(columnId);
        if (!column) {
          send(404, { error: "not found" });
          return;
        }
        Object.assign(column, body);
        send(200, column);
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
function isDispatchComment(comment: { body: string }): boolean {
  return comment.body.startsWith("Dispatched:");
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

function waitForLastCommentContaining(
  comments: Array<{ body: string }>,
  snippet: string,
): Promise<void> {
  return vi.waitFor(() => {
    expect(comments.at(-1)?.body).toContain(snippet);
  });
}

function waitForCommentEqual(
  comments: Array<{ issueId: number; body: string }>,
  expected: { issueId: number; body: string },
): Promise<void> {
  return vi.waitFor(() => {
    expect(comments).toContainEqual(expect.objectContaining(expected));
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

interface FakeAgentManagerHandle {
  manager: ItsaplanBridgeAgentManager;
  emit: (event: AgentManagerEvent) => void;
  setAgent: (agent: ManagedAgent) => void;
}

interface FakeMissionControlHandle {
  control: ItsaplanBridgeMissionControl;
  emitSelfReport: (event: MissionControlEvent) => void;
  emitEvent: (event: MissionControlEvent) => void;
  setBucket: (bucket: LifecycleBucket) => void;
  lifecycleActions: Array<{ agentId: string; action: MissionControlLifecycleAction }>;
}

function createFakeAgentManager(): FakeAgentManagerHandle {
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

function createFakeFleet(
  found: { agentId: string; host: string } | null,
  options?: {
    bucket?: LifecycleBucket;
    steerResult?: { ok: true } | { ok: false; error: string };
  },
): {
  fleet: ItsaplanBridgeFleet;
  lookups: string[];
  writes: Array<{ host: string; agentId: string; action: MissionControlLifecycleAction }>;
  bucketLookups: Array<{ host: string; agentId: string }>;
  steers: Array<{ host: string; agentId: string; prompt: string }>;
} {
  const lookups: string[] = [];
  const writes: Array<{ host: string; agentId: string; action: MissionControlLifecycleAction }> =
    [];
  const bucketLookups: Array<{ host: string; agentId: string }> = [];
  const steers: Array<{ host: string; agentId: string; prompt: string }> = [];
  const bucket = options?.bucket ?? "needs_you";
  return {
    lookups,
    writes,
    bucketLookups,
    steers,
    fleet: {
      findAgentByIssue: async (issueId) => {
        lookups.push(issueId);
        return found;
      },
      setLifecycle: async (input) => {
        writes.push(input);
        return { ok: true };
      },
      getLifecycleBucket: async (input) => {
        bucketLookups.push(input);
        return bucket;
      },
      steerWorkerPrompt: async (input) => {
        steers.push(input);
        return options?.steerResult ?? { ok: true };
      },
    },
  };
}

function createFakeMissionControl(initialBucket: LifecycleBucket): FakeMissionControlHandle {
  let selfReportListener: ((event: MissionControlEvent) => void) | null = null;
  let eventListener: ((event: MissionControlEvent) => void) | null = null;
  let bucket = initialBucket;
  const lifecycleActions: Array<{ agentId: string; action: MissionControlLifecycleAction }> = [];
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
      setLifecycle: async (input) => {
        lifecycleActions.push({ agentId: input.agentId, action: input.action });
        if (input.action === "done") {
          bucket = "done";
        }
        return { ok: true };
      },
    },
    emitSelfReport: (event) => selfReportListener?.(event),
    emitEvent: (event) => eventListener?.(event),
    setBucket: (next) => {
      bucket = next;
    },
    lifecycleActions,
  };
}

function fakeAgent(id: string, labels: Record<string, string>): ManagedAgent {
  return { id, labels, internal: false, cwd: `/tmp/${id}` } as unknown as ManagedAgent;
}

describe("ItsaplanBridge", () => {
  let issues: Map<number, FakeIssue>;
  let columns: Map<number, FakeColumn>;
  let labels: Map<number, FakeLabel>;
  let attachments: Map<number, FakeAttachment[]>;
  let initiatives: Map<number, FakeInitiative>;
  let projectIdByKey: Map<string, number>;
  let fakeServer: FakeItsaplanServerHandle;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let projectStore: ItsaplanProjectStore;
  let deliverMachineryPrompt: ReturnType<typeof vi.fn>;
  let steerWorkerPrompt: ReturnType<typeof vi.fn>;
  let agentStorageRecords: Pick<StoredAgentRecord, "id" | "labels" | "updatedAt">[];
  let agentManagerFake: FakeAgentManagerHandle;
  let missionControlFake: FakeMissionControlHandle;
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
          assigneeUserId: "bot-user-1",
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
    attachments = new Map();
    initiatives = new Map();
    fakeServer = startFakeItsaplanServer({
      apiKey: "itp_test_key",
      issues,
      columns,
      labels,
      attachments,
      initiatives,
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
      commanderUserId: "bot-user-1",
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

  describe("ticket moved to a completed column -> agent lifecycle", () => {
    const DONE_COLUMN_ID = 4;

    function issueRecord(columnId: number) {
      return { id: ISSUE_ID, projectId: PROJECT_ID, columnId, sequenceNumber: 1, title: "t" };
    }

    test("an agent on THIS host is marked done locally, without touching the fleet", async () => {
      agentStorageRecords.push({
        id: "local-agent",
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      });
      const fleetFake = createFakeFleet(null);
      const local = new ItsaplanBridge({
        logger: createTestLogger(),
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage(agentStorageRecords),
        missionControl: missionControlFake.control,
        fleet: fleetFake.fleet,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => "proj",
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      local.start();

      await local.handleWebhookRequest(
        webhookRequest("issue.state_changed", issueRecord(DONE_COLUMN_ID)),
      );

      expect(missionControlFake.lifecycleActions).toEqual([
        { agentId: "local-agent", action: "done" },
      ]);
      // A local hit must not fan out to peers.
      expect(fleetFake.lookups).toEqual([]);
      expect(fleetFake.writes).toEqual([]);
    });

    test("an agent on a PEER host is marked done over peering, not silently skipped", async () => {
      // Nothing local carries the label: this is the cross-host case that used
      // to log completed_issue_no_linked_agent and write nothing.
      const fleetFake = createFakeFleet({ agentId: "peer-agent", host: "blrofc3" });
      const remote = new ItsaplanBridge({
        logger: createTestLogger(),
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage([]),
        missionControl: missionControlFake.control,
        fleet: fleetFake.fleet,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => "proj",
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      remote.start();

      await remote.handleWebhookRequest(
        webhookRequest("issue.state_changed", issueRecord(DONE_COLUMN_ID)),
      );

      expect(fleetFake.lookups).toEqual([String(ISSUE_ID)]);
      expect(fleetFake.writes).toEqual([
        { host: "blrofc3", agentId: "peer-agent", action: "done" },
      ]);
      // The local mission control owns only local agents.
      expect(missionControlFake.lifecycleActions).toEqual([]);
    });

    test("no fleet dependency (single host) stays local-only and does not throw", async () => {
      await bridge.handleWebhookRequest(
        webhookRequest("issue.state_changed", issueRecord(DONE_COLUMN_ID)),
      );
      expect(missionControlFake.lifecycleActions).toEqual([]);
    });
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

    test("steers a human comment to an agent on a PEER host over peering, not silently discarded", async () => {
      const fleetFake = createFakeFleet(
        { agentId: "peer-agent-1", host: "blrofc3" },
        { bucket: "needs_you" },
      );
      const peerBridge = new ItsaplanBridge({
        logger: createTestLogger(),
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage([]),
        missionControl: missionControlFake.control,
        fleet: fleetFake.fleet,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => "proj",
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      peerBridge.start();

      const request = commentRequest(config.humanUserId, "Use option B on peer.", "evt-peer-1");
      const result = await peerBridge.handleWebhookRequest(request);

      expect(result.status).toBe(200);
      expect(fleetFake.lookups).toEqual([String(ISSUE_ID)]);
      expect(fleetFake.bucketLookups).toEqual([{ host: "blrofc3", agentId: "peer-agent-1" }]);
      expect(fleetFake.steers).toEqual([
        { host: "blrofc3", agentId: "peer-agent-1", prompt: "Use option B on peer." },
      ]);
      expect(steerWorkerPrompt).not.toHaveBeenCalled();
    });

    test("steers a human comment to a local needs_you agent without calling peers", async () => {
      await enterNeedsYou("agent-local-s1");
      const fleetFake = createFakeFleet({ agentId: "peer-agent-2", host: "blrofc3" });
      const localBridge = new ItsaplanBridge({
        logger: createTestLogger(),
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage(agentStorageRecords),
        missionControl: missionControlFake.control,
        fleet: fleetFake.fleet,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => "proj",
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      localBridge.start();

      const request = commentRequest(config.humanUserId, "Local answer.", "evt-local-1");
      const result = await localBridge.handleWebhookRequest(request);

      expect(result.status).toBe(200);
      expect(steerWorkerPrompt).toHaveBeenCalledWith("agent-local-s1", "Local answer.");
      expect(fleetFake.lookups).toEqual([]);
      expect(fleetFake.steers).toEqual([]);
    });

    test("logs at warn when a comment is undeliverable rather than returning silently", async () => {
      const warnLogs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      const testLogger = {
        ...createTestLogger(),
        child: () => testLogger,
        warn: (obj: Record<string, unknown>, msg: string) => {
          warnLogs.push({ obj, msg });
        },
      } as unknown as Logger;

      const hasWarnReason = (reason: string): boolean => {
        for (const log of warnLogs) {
          if (
            log.msg === "itsaplan.bridge.comment_delivery_skipped" &&
            log.obj?.reason === reason
          ) {
            return true;
          }
        }
        return false;
      };

      const emptyFleetFake = createFakeFleet(null);
      const bridgeWithLogger = new ItsaplanBridge({
        logger: testLogger,
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage([]),
        missionControl: missionControlFake.control,
        fleet: emptyFleetFake.fleet,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => "proj",
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      bridgeWithLogger.start();

      // Case 1: No linked agent found anywhere
      const req1 = commentRequest(config.humanUserId, "Hello?", "evt-warn-1");
      await bridgeWithLogger.handleWebhookRequest(req1);
      expect(hasWarnReason("no_linked_agent")).toBe(true);

      // Case 2: Agent found on peer, but bucket is not needs_you (e.g. running)
      warnLogs.length = 0;
      const runningFleetFake = createFakeFleet(
        { agentId: "peer-running", host: "blrofc3" },
        { bucket: "running" },
      );
      const bridgeRunning = new ItsaplanBridge({
        logger: testLogger,
        serverId: "server-1",
        agentManager: agentManagerFake.manager,
        agentStorage: createFakeAgentStorage([]),
        missionControl: missionControlFake.control,
        fleet: runningFleetFake.fleet,
        projectStore,
        getConfig: () => config,
        resolvePaseoProjectKey: async () => "proj",
        deliverMachineryPrompt,
        steerWorkerPrompt,
      });
      bridgeRunning.start();
      const req2 = commentRequest(config.humanUserId, "Hello running agent?", "evt-warn-2");
      await bridgeRunning.handleWebhookRequest(req2);
      expect(hasWarnReason("agent_not_in_needs_you")).toBe(true);

      // Case 3: Empty body
      warnLogs.length = 0;
      const req3 = commentRequest(config.humanUserId, "   ", "evt-warn-3");
      await bridgeRunning.handleWebhookRequest(req3);
      expect(hasWarnReason("empty_comment_body")).toBe(true);
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

    test("direct answer in Paseo: convergence comment says so and assignee unassigns when commander is unknown", async () => {
      await projectStore.upsert({
        paseoProjectKey: "proj",
        itsaplanProjectId: PROJECT_ID,
        itsaplanProjectKey: PROJECT_KEY,
        createdAt: new Date().toISOString(),
      });
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

    test("dispatches for an issue created directly in Todo", async () => {
      const request = webhookRequest("issue.created", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2, // Todo column (stateType "unstarted")
        title: "Directly created in Todo",
        description: "Must be picked up by Commander",
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-42");
      expect(prompt).toContain("Directly created in Todo");
      expect(prompt).toContain("Must be picked up by Commander");
      expect(prompt).toContain(`"${ITSAPLAN_ISSUE_LABEL_KEY}": "${ISSUE_ID}"`);
    });

    test("ignores an issue created directly in Backlog", async () => {
      const request = webhookRequest("issue.created", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 1, // Backlog (stateType "backlog")
        title: "Created in Backlog",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
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
        assigneeUserId: "bot-user-1",
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
        assigneeUserId: "bot-user-1",
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
        assigneeUserId: "bot-user-1",
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

    test("dispatches ticket with initiative name and description from webhook payload", async () => {
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Fix the bug",
        description: "Steps to reproduce...",
        initiative: {
          id: 10,
          title: "Infrastructure Modernization",
          description: "Upgrade all agent runners and bridges",
        },
      });

      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Initiative: Infrastructure Modernization");
      expect(prompt).toContain("Initiative description: Upgrade all agent runners and bridges");
      expect(prompt).toContain("Ticket: ENG-42 — Fix the bug");
    });

    test("dispatches ticket with initiative fetched by id from server when description omitted in payload", async () => {
      initiatives.set(15, {
        id: 15,
        projectId: PROJECT_ID,
        title: "Core Platform",
        description: "Robust execution engine",
        status: "active",
      });
      issues.get(ISSUE_ID)!.initiative = {
        id: 15,
        title: "Core Platform",
      };

      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Fix the bug",
        description: "Steps to reproduce...",
        initiativeId: 15,
      });

      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Initiative: Core Platform");
      expect(prompt).toContain("Initiative description: Robust execution engine");
    });

    test("dispatches ticket images natively and leaves non-image files as links", async () => {
      const png = Buffer.from("screenshot-bytes");
      attachments.set(ISSUE_ID, [
        {
          id: "att-img-1",
          filename: "screenshot-error.png",
          contentType: "image/png",
          sizeBytes: png.length,
          url: "/attachments/att-img-1/raw",
          bytes: png,
        },
        {
          id: "att-file-2",
          filename: "stacktrace.log",
          contentType: "text/plain",
          sizeBytes: 512,
          url: "/attachments/att-file-2/raw",
        },
      ]);

      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Fix the bug",
        description: "Check attached screenshot",
      });

      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      const images = deliverMachineryPrompt.mock.calls[0]?.[1] as
        | Array<{ data: string; mimeType: string }>
        | undefined;
      expect(prompt).toContain("1 image attached natively");
      expect(prompt).toContain("File attachments:");
      expect(prompt).not.toContain("screenshot-error.png:");
      expect(prompt).toContain(`- stacktrace.log: ${config.baseUrl}/attachments/att-file-2/raw`);
      expect(images).toEqual([{ data: png.toString("base64"), mimeType: "image/png" }]);
    });

    test("strips markdown /media/ image embeds from the body when the image is attached natively", async () => {
      const png = Buffer.from("paseo-24-bytes");
      attachments.set(ISSUE_ID, [
        {
          id: "66d0fd2f-a849-4730-bf8a-083aa1f94000",
          filename: "image.png",
          contentType: "image/png",
          sizeBytes: png.length,
          url: "/attachments/66d0fd2f-a849-4730-bf8a-083aa1f94000/raw",
          bytes: png,
        },
      ]);

      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 24,
        columnId: 2,
        title: "Test image",
        description:
          "![image.png](/media/attachments/66d0fd2f-a849-4730-bf8a-083aa1f94000/raw)Describe the image",
      });

      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      const images = deliverMachineryPrompt.mock.calls[0]?.[1] as
        | Array<{ data: string; mimeType: string }>
        | undefined;
      expect(prompt).toContain("1 image attached natively");
      expect(prompt).toContain("Describe the image");
      expect(prompt).not.toContain("/media/attachments/");
      expect(prompt).not.toContain("![image.png]");
      expect(images).toEqual([{ data: png.toString("base64"), mimeType: "image/png" }]);
    });

    test("dispatches ticket with both initiative and attachments", async () => {
      initiatives.set(20, {
        id: 20,
        projectId: PROJECT_ID,
        title: "Mobile App V2",
        description: "New redesign",
        status: "active",
      });
      issues.get(ISSUE_ID)!.initiative = {
        id: 20,
        title: "Mobile App V2",
        description: "New redesign",
      };
      attachments.set(ISSUE_ID, [
        {
          id: "mockup-1",
          filename: "design.png",
          contentType: "image/png",
          url: "/attachments/mockup-1/raw",
          bytes: Buffer.from("design-bytes"),
        },
      ]);

      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Build new screen",
        description: "See design",
      });

      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Initiative: Mobile App V2");
      expect(prompt).toContain("Initiative description: New redesign");
      expect(prompt).toContain("1 image attached natively");
      expect(prompt).not.toContain("File attachments:");
    });

    test("dependent issue dispatch includes initiative and attachments when unblocked", async () => {
      initiatives.set(30, {
        id: 30,
        projectId: PROJECT_ID,
        title: "Backend API",
        description: "Service endpoints",
        status: "active",
      });
      attachments.set(200, [
        {
          id: "spec-doc",
          filename: "openapi.json",
          url: "/attachments/spec-doc/raw",
        },
      ]);

      issues.get(ISSUE_ID)!.columnId = 2;
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 20,
        columnId: 2, // Todo
        title: "Blocked Issue B",
        description: "Depends on A",
        assigneeUserId: "bot-user-1",
        initiativeId: 30,
        links: [{ id: 1, kind: "blocks", direction: "inward", issue: { id: ISSUE_ID } }],
      });
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "outward", issue: { id: 200 } },
      ];

      // Issue A moves to Done (column 4)
      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-20");
      expect(prompt).toContain("Initiative: Backend API");
      expect(prompt).toContain("Initiative description: Service endpoints");
      expect(prompt).toContain("File attachments:");
      expect(prompt).toContain(`- openapi.json: ${config.baseUrl}/attachments/spec-doc/raw`);
    });

    test("skips dispatch when issue in Todo is assigned to a human and has no delegate", async () => {
      issues.get(ISSUE_ID)!.assigneeUserId = "vaibhav";
      issues.get(ISSUE_ID)!.delegateUserId = null;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Assigned to vaibhav",
        description: null,
        assigneeUserId: "vaibhav",
        delegateUserId: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("skips dispatch when issue in Todo is unassigned and has no delegate", async () => {
      issues.get(ISSUE_ID)!.assigneeUserId = null;
      issues.get(ISSUE_ID)!.delegateUserId = null;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Unassigned ticket",
        description: null,
        assigneeUserId: null,
        delegateUserId: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("dispatches when issue in Todo is assigned to vaibhav but delegated to Commander", async () => {
      issues.get(ISSUE_ID)!.assigneeUserId = "vaibhav";
      issues.get(ISSUE_ID)!.delegateUserId = "bot-user-1";
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Assigned to vaibhav, delegated to commander",
        description: "Must dispatch",
        assigneeUserId: "vaibhav",
        delegateUserId: "bot-user-1",
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-42");
    });

    test("dispatches when issue.assigned event reassigns an unstarted issue to Commander", async () => {
      issues.get(ISSUE_ID)!.assigneeUserId = "bot-user-1";
      issues.get(ISSUE_ID)!.delegateUserId = null;
      const request = webhookRequest("issue.assigned", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Reassigned to commander",
        description: "Should trigger dispatch on assignment",
        assigneeUserId: "bot-user-1",
        delegateUserId: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
    });

    test("skips dispatch on issue.assigned event if reassigned to another human", async () => {
      issues.get(ISSUE_ID)!.assigneeUserId = "human-2";
      issues.get(ISSUE_ID)!.delegateUserId = null;
      const request = webhookRequest("issue.assigned", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 2,
        title: "Reassigned to human-2",
        description: null,
        assigneeUserId: "human-2",
        delegateUserId: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("skips releasing unblocked dependent if dependent is assigned to a human without Commander delegation", async () => {
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 20,
        columnId: 2,
        title: "B (dependent human)",
        description: "Depends on A, but assigned to vaibhav",
        assigneeUserId: "vaibhav",
        delegateUserId: null,
        links: [{ id: 1, kind: "blocks", direction: "inward", issue: { id: ISSUE_ID } }],
      });
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "outward", issue: { id: 200 } },
      ];
      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).not.toHaveBeenCalled();
    });

    test("releases unblocked dependent if dependent is delegated to Commander even when assigned to a human", async () => {
      issues.set(200, {
        id: 200,
        projectId: PROJECT_ID,
        sequenceNumber: 20,
        columnId: 2,
        title: "B (dependent delegated)",
        description: "Depends on A, assigned to vaibhav, delegated to commander",
        assigneeUserId: "vaibhav",
        delegateUserId: "bot-user-1",
        links: [{ id: 1, kind: "blocks", direction: "inward", issue: { id: ISSUE_ID } }],
      });
      issues.get(ISSUE_ID)!.links = [
        { id: 1, kind: "blocks", direction: "outward", issue: { id: 200 } },
      ];
      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(deliverMachineryPrompt).toHaveBeenCalledTimes(1);
      const prompt = deliverMachineryPrompt.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("ENG-20");
    });
  });

  describe("Done / completed column -> agent lifecycle (reverse edge)", () => {
    test("Done webhook (completed column) updates linked agent lifecycle to done", async () => {
      agentStorageRecords.push({
        id: "agent-done-1",
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("ready");

      // Issue moved to Done (columnId: 4, stateType: "completed")
      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toEqual([
        { agentId: "agent-done-1", action: "done" },
      ]);
      expect(await missionControlFake.control.getLifecycleBucket("agent-done-1")).toBe("done");
    });

    test("idempotent and no loop/bounce: repeated Done webhook or subsequent agent_state does not cycle or re-move columns", async () => {
      agentStorageRecords.push({
        id: "agent-bounce-1",
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("ready");

      // First webhook delivery
      issues.get(ISSUE_ID)!.columnId = 4; // Done
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      request.headers["x-itsaplan-event-id"] = "evt-done-1";
      const first = await bridge.handleWebhookRequest(request);
      expect(first.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toHaveLength(1);

      // Second webhook delivery with same event id (deduped by event id)
      const second = await bridge.handleWebhookRequest(request);
      expect(second.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toHaveLength(1);

      // Third webhook delivery with different event id (loop guard: bucket already done)
      const request2 = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      request2.headers["x-itsaplan-event-id"] = "evt-done-2";
      const third = await bridge.handleWebhookRequest(request2);
      expect(third.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toHaveLength(1);

      // Subsequent agent_state event from Mission Control/daemon (bucket is now "done")
      // does not post dispatch comments, does not re-move ticket to Ready to review or In Progress
      const commentCountBefore = fakeServer.comments.length;
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-bounce-1", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });

      // Column remains Done (4), no extra comments posted
      expect(issues.get(ISSUE_ID)?.columnId).toBe(4);
      expect(fakeServer.comments.length).toBe(commentCountBefore);
    });

    test("resolves latest attempt when multiple agents share an issue label", async () => {
      agentStorageRecords.push(
        {
          id: "agent-old-attempt",
          labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
          updatedAt: "2026-01-01T10:00:00.000Z",
        },
        {
          id: "agent-latest-attempt",
          labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
          updatedAt: "2026-01-01T12:00:00.000Z",
        },
      );
      missionControlFake.setBucket("ready");

      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toEqual([
        { agentId: "agent-latest-attempt", action: "done" },
      ]);
    });

    test("ignores completed webhook when no agent is linked to the issue", async () => {
      // agentStorageRecords is empty — no agent with this label
      issues.get(ISSUE_ID)!.columnId = 4;
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 4,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toHaveLength(0);
    });

    test("Canceled webhook releases dependents but does NOT mark agent lifecycle done", async () => {
      agentStorageRecords.push({
        id: "agent-canceled-1",
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
      });
      missionControlFake.setBucket("running");

      issues.get(ISSUE_ID)!.columnId = 5; // Canceled (stateType: "canceled")
      const request = webhookRequest("issue.state_changed", {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        sequenceNumber: 42,
        columnId: 5,
        title: "Fix the bug",
        description: null,
      });
      const result = await bridge.handleWebhookRequest(request);
      expect(result.status).toBe(200);
      expect(missionControlFake.lifecycleActions).toHaveLength(0);
      expect(await missionControlFake.control.getLifecycleBucket("agent-canceled-1")).toBe(
        "running",
      );
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
        {
          issueId: ISSUE_ID,
          body: "Dispatched: [Agent agent-1](paseo://h/server-1/agent/agent-1)",
          apiKey: "itp_test_key",
        },
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
      await waitForIssueColumn(issues, ISSUE_ID, readyColumn!.id);
      await waitForLastCommentContaining(fakeServer.comments, "PR: https://example.test/pr/1");
    });

    test("projects column to In Progress when an agent is created on a host with NO project mapping", async () => {
      const UNMAPPED_PROJECT_ID = 99;
      const UNMAPPED_PROJECT_KEY = "UNMAPPED";
      const UNMAPPED_ISSUE_ID = 9901;

      projectIdByKey.set(UNMAPPED_PROJECT_KEY, UNMAPPED_PROJECT_ID);
      columns.set(991, {
        id: 991,
        projectId: UNMAPPED_PROJECT_ID,
        name: "Todo",
        stateType: "unstarted",
      });
      columns.set(992, {
        id: 992,
        projectId: UNMAPPED_PROJECT_ID,
        name: "In Progress",
        stateType: "started",
      });

      issues.set(UNMAPPED_ISSUE_ID, {
        id: UNMAPPED_ISSUE_ID,
        projectId: UNMAPPED_PROJECT_ID,
        sequenceNumber: 1,
        identifier: `${UNMAPPED_PROJECT_KEY}-1`,
        columnId: 991,
        title: "Peer host task",
        description: null,
        assigneeUserId: null,
        links: [],
      });

      expect(projectStore.getByItsaplanProjectId(UNMAPPED_PROJECT_ID)).toBeNull();

      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-peer-1", {
          [ITSAPLAN_ISSUE_LABEL_KEY]: String(UNMAPPED_ISSUE_ID),
        }),
      });

      await waitForIssueColumn(issues, UNMAPPED_ISSUE_ID, 992);
      expect(fakeServer.comments).toContainEqual({
        issueId: UNMAPPED_ISSUE_ID,
        body: "Dispatched: [Agent agent-peer-1](paseo://h/server-1/agent/agent-peer-1)",
        apiKey: "itp_test_key",
      });
    });

    test("projects report_status finished to Ready to review on a host with NO project mapping", async () => {
      const UNMAPPED_PROJECT_ID = 99;
      const UNMAPPED_PROJECT_KEY = "UNMAPPED";
      const UNMAPPED_ISSUE_ID = 9902;

      projectIdByKey.set(UNMAPPED_PROJECT_KEY, UNMAPPED_PROJECT_ID);
      columns.set(991, {
        id: 991,
        projectId: UNMAPPED_PROJECT_ID,
        name: "Todo",
        stateType: "unstarted",
      });
      columns.set(992, {
        id: 992,
        projectId: UNMAPPED_PROJECT_ID,
        name: "In Progress",
        stateType: "started",
      });

      issues.set(UNMAPPED_ISSUE_ID, {
        id: UNMAPPED_ISSUE_ID,
        projectId: UNMAPPED_PROJECT_ID,
        sequenceNumber: 2,
        identifier: `${UNMAPPED_PROJECT_KEY}-2`,
        columnId: 992,
        title: "Peer host task 2",
        description: null,
        assigneeUserId: null,
        links: [],
      });

      expect(projectStore.getByItsaplanProjectId(UNMAPPED_PROJECT_ID)).toBeNull();

      agentManagerFake.setAgent(
        fakeAgent("agent-peer-2", {
          [ITSAPLAN_ISSUE_LABEL_KEY]: String(UNMAPPED_ISSUE_ID),
        }),
      );

      missionControlFake.emitSelfReport({
        id: "mce_peer",
        ts: new Date().toISOString(),
        seq: 1,
        agentId: "agent-peer-2",
        agentName: "agent-peer-2",
        agentTitle: "Agent Peer 2",
        kind: "finished",
        source: "self",
        severity: "info",
        headline: "Done",
        proof: [{ kind: "pr", url: "https://example.test/pr/99", label: "PR" }],
      } as unknown as MissionControlEvent);

      await waitForCreatedColumn(fakeServer.createdColumns, {
        projectKey: UNMAPPED_PROJECT_KEY,
        name: "Ready to review",
        stateType: "started",
      });
      const readyCol = findColumnByNameAndProject(columns, UNMAPPED_PROJECT_ID, "Ready to review");
      await waitForIssueColumn(issues, UNMAPPED_ISSUE_ID, readyCol!.id);
    });

    test("projects review-ready lifecycle state to Ready to review when an agent finishes WITHOUT report_status", async () => {
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-event-only", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, 3);
      expect(fakeServer.comments).toEqual([
        {
          issueId: ISSUE_ID,
          body: "Dispatched: [Agent agent-event-only](paseo://h/server-1/agent/agent-event-only)",
          apiKey: "itp_test_key",
        },
      ]);

      // Agent transitions to idle/ready WITHOUT emitting any self-report
      missionControlFake.setBucket("ready");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-event-only", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });

      await waitForCreatedColumn(fakeServer.createdColumns, {
        projectKey: PROJECT_KEY,
        name: "Ready to review",
        stateType: "started",
      });
      const readyColumn = findColumnByName(columns, "Ready to review");
      await waitForIssueColumn(issues, ISSUE_ID, readyColumn!.id);
      await waitForLastCommentBody(fakeServer.comments, "Ready for review.");
    });

    test("is idempotent: repeated review-ready events and subsequent finished self-report do not bounce or duplicate comments", async () => {
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-idempotent", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, 3);

      // 1. Agent reaches review-ready lifecycle state (idle)
      missionControlFake.setBucket("ready");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-idempotent", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });

      await waitForCreatedColumn(fakeServer.createdColumns, {
        projectKey: PROJECT_KEY,
        name: "Ready to review",
        stateType: "started",
      });
      const readyColumn = findColumnByName(columns, "Ready to review");
      await waitForIssueColumn(issues, ISSUE_ID, readyColumn!.id);
      await waitForLastCommentBody(fakeServer.comments, "Ready for review.");
      const commentCountAfterFirstReady = fakeServer.comments.length;

      // 2. Deliver the exact same transition a second time (duplicate agent_state)
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-idempotent", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      await flushAsync();

      // Must remain in Ready to review and must NOT duplicate comments
      expect(issues.get(ISSUE_ID)?.columnId).toBe(readyColumn?.id);
      expect(fakeServer.comments.length).toBe(commentCountAfterFirstReady);

      // 3. A subsequent finished self-report arrives with PR proof
      missionControlFake.emitSelfReport({
        id: "mce_subsequent",
        ts: new Date().toISOString(),
        seq: 2,
        agentId: "agent-idempotent",
        agentName: "agent-idempotent",
        agentTitle: "Agent Idempotent",
        kind: "finished",
        source: "self",
        severity: "info",
        headline: "Completed work",
        proof: [{ kind: "pr", url: "https://example.test/pr/77", label: "PR" }],
      } as unknown as MissionControlEvent);

      await waitForLastCommentContaining(fakeServer.comments, "PR: https://example.test/pr/77");
      expect(issues.get(ISSUE_ID)?.columnId).toBe(readyColumn?.id);
      const commentCountAfterSelfReport = fakeServer.comments.length;
      expect(commentCountAfterSelfReport).toBe(commentCountAfterFirstReady + 1);

      // 4. Another agent_state arrives after the self-report
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-idempotent", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      await flushAsync();

      // Must stay in Ready to review and not add comments
      expect(issues.get(ISSUE_ID)?.columnId).toBe(readyColumn?.id);
      expect(fakeServer.comments.length).toBe(commentCountAfterSelfReport);
    });

    test("does not move to Ready to review when agent is stopped by user or errors", async () => {
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-user-stopped", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, 3);

      // User stopped agent -> bucket is "done", not "ready"
      missionControlFake.setBucket("done");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-user-stopped", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      await flushAsync();

      // Column must remain In Progress (3), not move to Ready to review
      expect(issues.get(ISSUE_ID)?.columnId).toBe(3);
    });

    test("moves the ticket back to In Progress when a ready agent is re-prompted to run again, then back to Ready to review when done", async () => {
      // 1. First run: created and running -> In Progress (column 3)
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-reprompt", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, 3);
      expect(fakeServer.comments.filter(isDispatchComment)).toHaveLength(1);

      // 2. Finished first run -> Ready to review
      missionControlFake.setBucket("ready");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-reprompt", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForCreatedColumn(fakeServer.createdColumns, {
        projectKey: PROJECT_KEY,
        name: "Ready to review",
        stateType: "started",
      });
      const readyCol = findColumnByName(columns, "Ready to review")!;
      await waitForIssueColumn(issues, ISSUE_ID, readyCol.id);

      // 3. User re-prompts agent -> bucket becomes "running"
      missionControlFake.setBucket("running");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-reprompt", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, 3);
      // No duplicate Dispatched comment on re-prompt
      expect(fakeServer.comments.filter(isDispatchComment)).toHaveLength(1);

      // Repeated agent_state while running does not issue additional column moves
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-reprompt", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      expect(issues.get(ISSUE_ID)?.columnId).toBe(3);

      // 4. Second run finishes -> back to Ready to review
      missionControlFake.setBucket("ready");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent("agent-reprompt", { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await waitForIssueColumn(issues, ISSUE_ID, readyCol.id);
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
          body: `Dispatched: [Feature implementation](paseo://h/server-1/agent/${agentId})`,
          apiKey: "itp_test_key",
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
  describe("workspace archival", () => {
    test("moves associated ticket to Done when workspace is archived", async () => {
      const workspaceId = "ws-archive-1";
      agentStorageRecords.push({
        id: "agent-in-ws-1",
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
        workspaceId,
      });
      // Issue is currently in In Progress (3)
      issues.get(ISSUE_ID)!.columnId = 3;

      await bridge.handleWorkspaceArchived(workspaceId);

      // Done column is 4 (stateType: "completed")
      expect(issues.get(ISSUE_ID)?.columnId).toBe(4);
    });

    test("does not move or fail if the ticket is already in Done when workspace is archived", async () => {
      const workspaceId = "ws-archive-2";
      agentStorageRecords.push({
        id: "agent-in-ws-2",
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
        workspaceId,
      });
      // Issue is already in Done (4)
      issues.get(ISSUE_ID)!.columnId = 4;

      await bridge.handleWorkspaceArchived(workspaceId);

      expect(issues.get(ISSUE_ID)?.columnId).toBe(4);
    });

    test("moves multiple tickets associated with multiple agents in the workspace", async () => {
      const workspaceId = "ws-archive-multi";
      issues.set(201, {
        id: 201,
        projectId: PROJECT_ID,
        sequenceNumber: 43,
        columnId: 3,
        title: "Another bug",
        description: null,
        assigneeUserId: null,
        links: [],
      });
      agentStorageRecords.push(
        {
          id: "agent-multi-1",
          labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
          updatedAt: new Date().toISOString(),
          workspaceId,
        },
        {
          id: "agent-multi-2",
          labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: "201" },
          updatedAt: new Date().toISOString(),
          workspaceId,
        },
      );
      issues.get(ISSUE_ID)!.columnId = 3;

      await bridge.handleWorkspaceArchived(workspaceId);

      expect(issues.get(ISSUE_ID)?.columnId).toBe(4);
      expect(issues.get(201)?.columnId).toBe(4);
    });

    test("no-ops safely when no agents in the workspace have itsaplan labels", async () => {
      const workspaceId = "ws-archive-empty";
      agentStorageRecords.push({
        id: "agent-no-label",
        labels: {},
        updatedAt: new Date().toISOString(),
        workspaceId,
      });
      issues.get(ISSUE_ID)!.columnId = 3;

      await bridge.handleWorkspaceArchived(workspaceId);

      expect(issues.get(ISSUE_ID)?.columnId).toBe(3);
    });

    test("subsequent agent_state events from an archived agent do not move ticket back to Ready to review", async () => {
      const workspaceId = "ws-archive-race";
      const agentId = "agent-archived-race";
      agentStorageRecords.push({
        id: agentId,
        labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
        updatedAt: new Date().toISOString(),
        archivedAt: new Date().toISOString(),
        workspaceId,
      });
      issues.get(ISSUE_ID)!.columnId = 3;

      await bridge.handleWorkspaceArchived(workspaceId);
      expect(issues.get(ISSUE_ID)?.columnId).toBe(4); // Done

      // An agent_state event arrives after workspace archival (e.g. from agent teardown)
      missionControlFake.setBucket("ready");
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
      await flushAsync();
      await flushAsync();

      // Ticket must remain in Done (4), not move back to Ready to review
      expect(issues.get(ISSUE_ID)?.columnId).toBe(4);
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

describe("extractProjectKeyFromIdentifier", () => {
  test("extracts project key from standard itsaplan identifiers", () => {
    expect(extractProjectKeyFromIdentifier("AMBIENTAISTA-9")).toBe("AMBIENTAISTA");
    expect(extractProjectKeyFromIdentifier("ENG-42")).toBe("ENG");
    expect(extractProjectKeyFromIdentifier("REPO-1A2B-12")).toBe("REPO-1A2B");
    expect(extractProjectKeyFromIdentifier("  PASEO-100  ")).toBe("PASEO");
  });

  test("returns null for identifiers without sequence numbers or hyphens", () => {
    expect(extractProjectKeyFromIdentifier("NO_HYPHEN")).toBeNull();
    expect(extractProjectKeyFromIdentifier("INVALID-ABC")).toBeNull();
    expect(extractProjectKeyFromIdentifier("-123")).toBeNull();
    expect(extractProjectKeyFromIdentifier("")).toBeNull();
  });
});

describe("buildDispatchPrompt", () => {
  test("builds plain prompt with no initiative and no attachments", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "ENG-10",
      title: "Fix crash on launch",
      body: "Stacktrace in logs",
      url: "http://10.7.0.1:3000/project/ENG/issues/10",
      projectKey: "paseo",
    });

    expect(prompt).toContain(
      "itsaplan ticket moved to Todo with zero open blockers — ready to dispatch.",
    );
    expect(prompt).toContain("Project: paseo");
    expect(prompt).toContain("Ticket: ENG-10 — Fix crash on launch");
    expect(prompt).toContain("URL: http://10.7.0.1:3000/project/ENG/issues/10");
    expect(prompt).toContain("Stacktrace in logs");
    expect(prompt).toContain(`Label the new agent "${ITSAPLAN_ISSUE_LABEL_KEY}": "42"`);
    expect(prompt).not.toContain("Initiative:");
    expect(prompt).not.toContain("Attachments:");
  });

  test("builds prompt with (no description) when body is empty", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "ENG-10",
      title: "Empty body ticket",
      body: "   ",
      url: "http://10.7.0.1:3000/project/ENG/issues/10",
      projectKey: "paseo",
    });

    expect(prompt).toContain("(no description)");
  });

  test("includes initiative title and description when provided", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "ENG-10",
      title: "Speed up tests",
      body: "Run in parallel",
      url: "http://10.7.0.1:3000/project/ENG/issues/10",
      projectKey: "paseo",
      initiative: {
        title: "Test Speedup Q3",
        description: "Cut test suite run time in half",
      },
    });

    expect(prompt).toContain("Initiative: Test Speedup Q3");
    expect(prompt).toContain("Initiative description: Cut test suite run time in half");
  });

  test("includes initiative title without description line when description is empty or null", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "ENG-10",
      title: "Speed up tests",
      body: "Run in parallel",
      url: "http://10.7.0.1:3000/project/ENG/issues/10",
      projectKey: "paseo",
      initiative: {
        title: "Test Speedup Q3",
        description: null,
      },
    });

    expect(prompt).toContain("Initiative: Test Speedup Q3");
    expect(prompt).not.toContain("Initiative description:");
  });

  test("lists non-image files as links and notes native images separately", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "ENG-10",
      title: "UI alignment bug",
      body: "See screenshots",
      url: "http://10.7.0.1:3000/project/ENG/issues/10",
      projectKey: "paseo",
      nativeImageCount: 2,
      attachments: [
        {
          filename: "notes.txt",
          url: "http://10.7.0.1:3000/attachments/notes/raw",
        },
      ],
    });

    expect(prompt).toContain("2 images attached natively");
    expect(prompt).toContain("File attachments:");
    expect(prompt).toContain("- notes.txt: http://10.7.0.1:3000/attachments/notes/raw");
  });

  test("strips markdown image embeds from the body when native images are attached", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "PASEO-24",
      title: "Test image",
      body: "![image.png](/media/attachments/abc/raw)Describe the image",
      url: "http://10.7.0.1:3000/project/PASEO/issues/24",
      projectKey: "paseo",
      nativeImageCount: 1,
    });

    expect(prompt).toContain("Describe the image");
    expect(prompt).toContain("1 image attached natively");
    expect(prompt).not.toContain("/media/attachments/");
    expect(prompt).not.toContain("![image.png]");
  });

  test("includes both initiative and file attachments formatted in expected sections", () => {
    const prompt = buildDispatchPrompt({
      issueId: 42,
      ticketKey: "ENG-10",
      title: "Add dark mode toggle",
      body: "Toggle in settings pane",
      url: "http://10.7.0.1:3000/project/ENG/issues/10",
      projectKey: "paseo",
      initiative: {
        title: "Theme Refresh",
        description: "Support multiple themes",
      },
      nativeImageCount: 1,
      attachments: [
        {
          filename: "spec.pdf",
          url: "http://10.7.0.1:3000/attachments/spec/raw",
        },
      ],
    });

    expect(prompt).toContain("Initiative: Theme Refresh");
    expect(prompt).toContain("Initiative description: Support multiple themes");
    expect(prompt).toContain("Toggle in settings pane");
    expect(prompt).toContain("1 image attached natively");
    expect(prompt).toContain(
      "File attachments:\n- spec.pdf: http://10.7.0.1:3000/attachments/spec/raw",
    );
  });
});

describe("itsaplan comment author attribution, deduplication, and link formatting", () => {
  let fakeServer: FakeItsaplanServerHandle;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let projectStore: ItsaplanProjectStore;
  let agentManagerFake: FakeAgentManagerHandle;
  let agentStorageRecords: StoredAgentRecord[];
  let missionControlFake: FakeMissionControlHandle;
  let issues: Map<number, FakeIssue>;
  let columns: Map<number, FakeColumn>;
  let projectIdByKey: Map<string, number>;
  let bridge: ItsaplanBridge;

  const PROJECT_ID = 10;
  const PROJECT_KEY = "PROJ";
  const ISSUE_ID = 101;

  beforeEach(async () => {
    issues = new Map<number, FakeIssue>([
      [
        ISSUE_ID,
        {
          id: ISSUE_ID,
          projectId: PROJECT_ID,
          sequenceNumber: 1,
          columnId: 2, // Todo
          title: "Attribution test issue",
          description: "Test description",
          assigneeUserId: null,
          links: [],
        },
      ],
    ]);
    columns = new Map<number, FakeColumn>([
      [1, { id: 1, projectId: PROJECT_ID, name: "Backlog", stateType: "backlog" }],
      [2, { id: 2, projectId: PROJECT_ID, name: "Todo", stateType: "unstarted" }],
      [3, { id: 3, projectId: PROJECT_ID, name: "In Progress", stateType: "started" }],
    ]);
    projectIdByKey = new Map([[PROJECT_KEY, PROJECT_ID]]);

    fakeServer = startFakeItsaplanServer({
      apiKey: "itp_admin_user_key",
      allowedApiKeys: ["itp_admin_user_key", "itp_commander_bot_key"],
      issues,
      columns,
      projectIdByKey,
    });
    handle = await listen(fakeServer.server);
    config = {
      baseUrl: handle.baseUrl,
      apiKey: "itp_admin_user_key",
      webhookSecret: "whsec_test",
      humanUserId: "human-user-1",
    };

    projectStore = new ItsaplanProjectStore({
      paseoHome: `/tmp/itsaplan-attr-test-${Math.random()}`,
      logger: createTestLogger(),
    });
    await projectStore.upsert({
      paseoProjectKey: "proj",
      itsaplanProjectId: PROJECT_ID,
      itsaplanProjectKey: PROJECT_KEY,
      createdAt: new Date().toISOString(),
      commanderAgentId: 99,
      commanderUsername: "commander",
      commanderApiKey: "itp_commander_bot_key",
      commanderUserId: "bot-user-commander",
    });

    agentManagerFake = createFakeAgentManager();
    agentStorageRecords = [];
    missionControlFake = createFakeMissionControl("running");

    bridge = new ItsaplanBridge({
      serverId: "srv_test",
      agentManager: agentManagerFake.manager,
      agentStorage: createFakeAgentStorage(agentStorageRecords),
      missionControl: missionControlFake.control,
      projectStore,
      getConfig: () => config,
      deliverMachineryPrompt: async () => true,
      steerWorkerPrompt: async () => {},
      resolvePaseoProjectKey: async () => "proj",
      logger: createTestLogger(),
    });
    bridge.start();
  });
  afterEach(async () => {
    bridge?.stop();
    await handle?.close();
  });

  test("posts comments with Commander API key when commanderApiKey is present in mapping", async () => {
    const agentId = "agent-bot-auth";
    agentStorageRecords.push({
      id: agentId,
      title: "Task with bot author",
      shortDescription: "Working on task",
      labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
      updatedAt: new Date().toISOString(),
    });
    agentManagerFake.emit({
      type: "agent_state",
      agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
    });

    await waitForIssueColumn(issues, ISSUE_ID, 3);
    const dispatchComment = fakeServer.comments.find((c) => c.body.startsWith("Dispatched:"));
    expect(dispatchComment).toBeDefined();
    expect(dispatchComment?.apiKey).toBe("itp_commander_bot_key");
    expect(dispatchComment?.body).toBe(
      "Dispatched: [Task with bot author](paseo://h/srv_test/agent/agent-bot-auth)",
    );
  });

  test("suppresses consecutive duplicate comments posted to the same issue within deduplication window", async () => {
    const agentId = "agent-dedup-test";
    agentStorageRecords.push({
      id: agentId,
      title: "Dedup Agent",
      shortDescription: "Working on task",
      labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
      updatedAt: new Date().toISOString(),
    });

    // 1. Initial dispatch comment
    agentManagerFake.emit({
      type: "agent_state",
      agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
    });
    await waitForIssueColumn(issues, ISSUE_ID, 3);
    expect(fakeServer.comments.filter((c) => c.body.startsWith("Dispatched:"))).toHaveLength(1);

    // 2. Transition to ready
    missionControlFake.setBucket("ready");
    agentManagerFake.emit({
      type: "agent_state",
      agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
    });

    await waitForCreatedColumn(fakeServer.createdColumns, {
      projectKey: PROJECT_KEY,
      name: "Ready to review",
      stateType: "started",
    });
    const readyColumn = findColumnByName(columns, "Ready to review");
    await waitForIssueColumn(issues, ISSUE_ID, readyColumn!.id);
    await waitForLastCommentBody(fakeServer.comments, "Ready for review.");

    const readyCommentCount = fakeServer.comments.filter(
      (c) => c.body === "Ready for review.",
    ).length;
    expect(readyCommentCount).toBe(1);

    // 3. Emit 5 more rapid agent_state events in ready state -> must NOT duplicate "Ready for review."
    for (let i = 0; i < 5; i++) {
      agentManagerFake.emit({
        type: "agent_state",
        agent: fakeAgent(agentId, { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) }),
      });
    }
    await flushAsync();
    await flushAsync();

    const readyCommentsAfter = fakeServer.comments.filter(
      (c) => c.body === "Ready for review.",
    ).length;
    expect(readyCommentsAfter).toBe(1);
  });

  test("formats paseo:// links inside proofs as markdown links", async () => {
    const agentId = "agent-proof-link";
    agentStorageRecords.push({
      id: agentId,
      title: "Proof Link Agent",
      shortDescription: "Working on task",
      labels: { [ITSAPLAN_ISSUE_LABEL_KEY]: String(ISSUE_ID) },
      updatedAt: new Date().toISOString(),
    });

    missionControlFake.emitSelfReport({
      id: "mce_proof_1",
      ts: new Date().toISOString(),
      seq: 1,
      agentId,
      agentName: agentId,
      agentTitle: "Proof Link Agent",
      kind: "finished",
      source: "self",
      severity: "info",
      headline: "Done",
      proof: [
        { kind: "url", url: "paseo://h/srv_test/agent/child-123", label: "Inspector" },
        { kind: "pr", url: "https://github.com/org/repo/pull/42", label: "PR #42" },
      ],
    } as unknown as MissionControlEvent);

    await waitForLastCommentContaining(
      fakeServer.comments,
      "[Inspector](paseo://h/srv_test/agent/child-123)",
    );
    const lastComment = fakeServer.comments.at(-1);
    expect(lastComment?.body).toContain("- [Inspector](paseo://h/srv_test/agent/child-123)");
    expect(lastComment?.body).toContain("- PR #42: https://github.com/org/repo/pull/42");
    expect(lastComment?.apiKey).toBe("itp_commander_bot_key");
  });
});
