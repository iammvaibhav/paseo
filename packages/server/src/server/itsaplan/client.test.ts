import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ItsaplanApiError, ItsaplanClient } from "./client.js";
import {
  MAX_TICKET_IMAGE_BYTES,
  resolveTicketAttachments,
  rewriteMarkdownAttachmentUrls,
  stripNativeMarkdownImages,
} from "./ticket-images.js";

interface State {
  issue: {
    id: number;
    projectId: number;
    sequenceNumber: number;
    columnId: number;
    title: string;
    description: string | null;
    assigneeUserId: string | null;
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
  };
  columns: Array<{ id: number; projectId: number; name: string; stateType: string }>;
  labels: Array<{ id: number; projectId: number; name: string; color?: string }>;
  attachments?: Array<{
    id: string;
    filename: string;
    contentType?: string;
    sizeBytes?: number;
    createdAt?: string;
    url: string;
    bytes?: Buffer;
  }>;
  initiatives?: Map<
    number,
    { id: number; projectId: number; title: string; description?: string | null; status?: string }
  >;
  webhooks: Array<{
    id: number;
    projectId: number;
    url: string;
    events: string[];
    isActive: boolean;
  }>;
  claimedRun: {
    id: number;
    trigger: string;
    prompt: string;
    systemPrompt: string;
    attempts: number;
    issueId?: number | null;
    issueIdentifier?: string | null;
  } | null;
}

function startServer(apiKey: string, state: State) {
  const posts: {
    comments: Array<{ issueId: number; body: string }>;
    projects: Array<{ key: string; name: string }>;
    webhooks: Array<Record<string, unknown>>;
    createdIssues: Array<Record<string, unknown>>;
    runHeartbeats: number[];
    runResults: Array<{ runId: number; result: Record<string, unknown> }>;
  } = {
    comments: [],
    projects: [],
    webhooks: [],
    createdIssues: [],
    runHeartbeats: [],
    runResults: [],
  };
  let nextColumnId = 500;
  let nextLabelId = 200;
  let nextIssueId = 800;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    // eslint-disable-next-line complexity -- in-test HTTP router
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers["x-api-key"] !== apiKey) {
        send(403, { error: "forbidden" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/issues/1") {
        send(200, state.issue);
        return;
      }
      if (req.method === "GET" && path === "/issues/1/attachments") {
        send(200, state.attachments ?? []);
        return;
      }
      const rawAttachmentMatch = /^\/attachments\/([^/]+)\/raw$/.exec(path);
      if (req.method === "GET" && rawAttachmentMatch) {
        const id = rawAttachmentMatch[1];
        const att = (state.attachments ?? []).find((candidate) => candidate.id === id);
        if (!att || !att.bytes) {
          send(404, { error: "not found" });
          return;
        }
        res.writeHead(200, { "content-type": att.contentType ?? "application/octet-stream" });
        res.end(att.bytes);
        return;
      }
      const initiativeMatch = /^\/initiatives\/(\d+)$/.exec(path);
      if (req.method === "GET" && initiativeMatch) {
        const init = state.initiatives?.get(Number(initiativeMatch[1]));
        if (init) {
          send(200, init);
        } else {
          send(404, { error: "not found" });
        }
        return;
      }
      if (req.method === "GET" && path === "/issues/404") {
        send(404, { error: "not found" });
        return;
      }
      if (req.method === "PATCH" && path === "/issues/1") {
        Object.assign(state.issue, body);
        send(200, state.issue);
        return;
      }
      if (req.method === "POST" && path === "/issues/1/comments") {
        posts.comments.push({ issueId: 1, body: String(body.body) });
        send(200, { id: 1 });
        return;
      }
      if (req.method === "GET" && path === "/projects/ENG") {
        send(200, {
          id: 1,
          key: "ENG",
          name: "Engineering",
          columns: state.columns,
          labels: state.labels,
        });
        return;
      }
      if (req.method === "POST" && path === "/projects/ENG/labels") {
        const label = {
          id: nextLabelId++,
          projectId: 1,
          name: String(body.name),
          color: body.color ? String(body.color) : undefined,
        };
        state.labels.push(label);
        send(201, label);
        return;
      }
      if (req.method === "POST" && path === "/projects/ENG/issues") {
        const issue = {
          id: nextIssueId++,
          projectId: 1,
          sequenceNumber: 99,
          columnId: Number(body.columnId),
          title: String(body.title),
          description: (body.description as string | null | undefined) ?? null,
          assigneeUserId: null,
          labelIds: (body.labelIds as number[] | undefined) ?? [],
          links: [],
        };
        posts.createdIssues.push(body);
        send(201, issue);
        return;
      }
      const aiAgentPatchMatch = /^\/projects\/([^/]+)\/ai-agents\/(\d+)$/.exec(path);
      if (req.method === "PATCH" && aiAgentPatchMatch) {
        send(200, {
          id: Number(aiAgentPatchMatch[2]),
          projectId: 1,
          userId: "user-agent",
          username: "commander",
          kind: "external",
          ...body,
        });
        return;
      }
      if (req.method === "POST" && path === "/agent-runs/claim") {
        send(200, { run: state.claimedRun });
        return;
      }
      const runHeartbeatMatch = /^\/agent-runs\/(\d+)\/heartbeat$/.exec(path);
      if (req.method === "POST" && runHeartbeatMatch) {
        posts.runHeartbeats.push(Number(runHeartbeatMatch[1]));
        send(204);
        return;
      }
      const runResultMatch = /^\/agent-runs\/(\d+)\/result$/.exec(path);
      if (req.method === "POST" && runResultMatch) {
        posts.runResults.push({ runId: Number(runResultMatch[1]), result: body });
        send(204);
        return;
      }
      if (req.method === "POST" && path === "/projects/ENG/columns") {
        const column = {
          id: nextColumnId++,
          projectId: 1,
          name: String(body.name),
          stateType: String(body.stateType),
        };
        state.columns.push(column);
        send(201, column);
        return;
      }
      if (req.method === "POST" && path === "/projects") {
        posts.projects.push({ key: String(body.key), name: String(body.name) });
        send(201, { id: 42, key: body.key, name: body.name });
        return;
      }
      if (req.method === "POST" && path === "/projects/ENG/webhooks") {
        posts.webhooks.push(body);
        send(201, { id: 1, projectId: 1, url: body.url, events: body.events, isActive: true });
        return;
      }
      if (req.method === "GET" && path === "/projects/ENG/webhooks") {
        send(200, state.webhooks);
        return;
      }
      const patchWebhookMatch = /^\/webhooks\/(\d+)$/.exec(path);
      if (req.method === "PATCH" && patchWebhookMatch) {
        const webhook = state.webhooks.find((w) => w.id === Number(patchWebhookMatch[1]));
        if (!webhook) {
          send(404, { error: "not found" });
          return;
        }
        Object.assign(webhook, body);
        send(200, webhook);
        return;
      }
      send(404, { error: `unhandled ${req.method} ${path}` });
    });
  });

  return { server, posts };
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

describe("ItsaplanClient", () => {
  let state: State;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let serverHandle: ReturnType<typeof startServer>;
  let client: ItsaplanClient;

  beforeEach(async () => {
    state = {
      issue: {
        id: 1,
        projectId: 1,
        sequenceNumber: 7,
        columnId: 10,
        title: "Do the thing",
        description: "details",
        assigneeUserId: null,
        links: [
          {
            id: 5,
            kind: "blocks",
            direction: "inward",
            issue: { id: 2, sequenceNumber: 3, title: "Blocker" },
          },
          { id: 6, kind: "relates", direction: "outward", issue: { id: 9 } },
        ],
      },
      columns: [
        { id: 10, projectId: 1, name: "Todo", stateType: "unstarted" },
        { id: 11, projectId: 1, name: "In Progress", stateType: "started" },
      ],
      labels: [
        { id: 100, projectId: 1, name: "bug" },
        { id: 101, projectId: 1, name: "auto-chain" },
      ],
      webhooks: [
        {
          id: 7,
          projectId: 1,
          url: "http://example.test/webhook",
          events: ["issue.state_changed"],
          isActive: true,
        },
      ],
      claimedRun: null,
    };
    serverHandle = startServer("itp_key", state);
    handle = await listen(serverHandle.server);
    client = new ItsaplanClient({ baseUrl: handle.baseUrl, apiKey: "itp_key" });
  });

  afterEach(async () => {
    await handle.close();
  });
  test("listIssueLinks normalizes the wire shape to stored rows", async () => {
    const links = await client.listIssueLinks(1);
    // inward: the other end (2) is the source blocking this issue (1).
    // outward: this issue (1) is the source relating to the other end (9).
    expect(links).toEqual([
      { id: 5, kind: "blocks", sourceIssueId: 2, targetIssueId: 1 },
      { id: 6, kind: "relates", sourceIssueId: 1, targetIssueId: 9 },
    ]);
  });

  test("getIssue returns the parsed issue", async () => {
    const issue = await client.getIssue(1);
    expect(issue).toMatchObject({ id: 1, title: "Do the thing", columnId: 10 });
  });

  test("getIssue returns initiative when present", async () => {
    state.issue.initiative = { id: 50, title: "Core Platform", status: "active" };
    state.issue.initiativeId = 50;
    const issue = await client.getIssue(1);
    expect(issue.initiative).toEqual({ id: 50, title: "Core Platform", status: "active" });
    expect(issue.initiativeId).toBe(50);
  });

  test("listIssueAttachments returns attachments for an issue", async () => {
    state.attachments = [
      {
        id: "att-1",
        filename: "diagram.png",
        contentType: "image/png",
        sizeBytes: 1024,
        createdAt: "2026-08-30T10:00:00Z",
        url: "/attachments/att-1/raw",
      },
      {
        id: "att-2",
        filename: "notes.txt",
        url: "/attachments/att-2/raw",
      },
    ];
    const attachments = await client.listIssueAttachments(1);
    expect(attachments).toEqual(state.attachments);
  });

  test("downloadAttachment returns raw bytes and content type", async () => {
    const png = Buffer.from("png-bytes");
    state.attachments = [
      {
        id: "att-1",
        filename: "diagram.png",
        contentType: "image/png",
        url: "/attachments/att-1/raw",
        bytes: png,
      },
    ];
    const downloaded = await client.downloadAttachment("/attachments/att-1/raw");
    expect(downloaded.bytes.equals(png)).toBe(true);
    expect(downloaded.contentType).toMatch(/^image\/png/);
  });

  test("resolveTicketAttachments attaches raster images natively and leaves other files as links", async () => {
    const png = Buffer.from("hello-png");
    state.attachments = [
      {
        id: "att-img",
        filename: "screenshot.png",
        contentType: "image/png",
        url: "/attachments/att-img/raw",
        bytes: png,
      },
      {
        id: "att-log",
        filename: "stacktrace.log",
        contentType: "text/plain",
        url: "/attachments/att-log/raw",
      },
      {
        id: "att-svg",
        filename: "icon.svg",
        contentType: "image/svg+xml",
        url: "/attachments/att-svg/raw",
      },
    ];
    const resolved = await resolveTicketAttachments(client, 1, handle.baseUrl);
    expect(resolved.images).toEqual([{ data: png.toString("base64"), mimeType: "image/png" }]);
    expect(resolved.files).toEqual([
      { filename: "stacktrace.log", url: `${handle.baseUrl}/attachments/att-log/raw` },
      { filename: "icon.svg", url: `${handle.baseUrl}/attachments/att-svg/raw` },
    ]);
  });

  test("resolveTicketAttachments keeps oversized images as file links", async () => {
    state.attachments = [
      {
        id: "att-huge",
        filename: "huge.png",
        contentType: "image/png",
        sizeBytes: MAX_TICKET_IMAGE_BYTES + 1,
        url: "/attachments/att-huge/raw",
      },
    ];
    const resolved = await resolveTicketAttachments(client, 1, handle.baseUrl);
    expect(resolved.images).toEqual([]);
    expect(resolved.files).toEqual([
      { filename: "huge.png", url: `${handle.baseUrl}/attachments/att-huge/raw` },
    ]);
  });

  test("rewriteMarkdownAttachmentUrls maps /media/attachments to /attachments", () => {
    const rewritten = rewriteMarkdownAttachmentUrls(
      "![image.png](/media/attachments/abc/raw)Describe the image",
    );
    expect(rewritten).toBe("![image.png](/attachments/abc/raw)Describe the image");
  });

  test("stripNativeMarkdownImages drops markdown image embeds", () => {
    const stripped = stripNativeMarkdownImages(
      "![image.png](/media/attachments/abc/raw)Describe the image",
    );
    expect(stripped).toBe("Describe the image");
  });

  test("getInitiative returns initiative details including description", async () => {
    state.initiatives = new Map([
      [
        42,
        {
          id: 42,
          projectId: 1,
          title: "Speed Up Agent Lifecycle",
          description: "Improve response time and latency",
          status: "active",
        },
      ],
    ]);
    const initiative = await client.getInitiative(42);
    expect(initiative).toEqual({
      id: 42,
      projectId: 1,
      title: "Speed Up Agent Lifecycle",
      description: "Improve response time and latency",
      status: "active",
    });
  });

  test("moveIssueColumn PATCHes the columnId", async () => {
    const updated = await client.moveIssueColumn(1, 11);
    expect(updated.columnId).toBe(11);
  });

  test("updateAssignee PATCHes the assigneeUserId", async () => {
    const updated = await client.updateAssignee(1, "user-9");
    expect(updated.assigneeUserId).toBe("user-9");
  });

  test("postComment posts the body text", async () => {
    await client.postComment(1, "hello");
    expect(serverHandle.posts.comments).toEqual([{ issueId: 1, body: "hello" }]);
  });

  test("listProjectColumns extracts columns from the project scaffold", async () => {
    const columns = await client.listProjectColumns("ENG");
    expect(columns).toHaveLength(2);
    expect(columns.map((c) => c.name)).toEqual(["Todo", "In Progress"]);
  });

  test("listProjectColumns accepts the live nested GET /projects/:key scaffold", async () => {
    // Live itsaplan returns { project, columns, labels }, not a flat project row.
    const nestedServer = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "itp_test_key") {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          project: { id: 2, key: "ENG", name: "Engineering" },
          columns: [
            { id: 6, projectId: 2, name: "Backlog", stateType: "backlog" },
            { id: 7, projectId: 2, name: "Todo", stateType: "unstarted" },
          ],
          labels: [],
        }),
      );
    });
    const listening = Promise.withResolvers<{ port: number }>();
    nestedServer.listen(0, "127.0.0.1", () => {
      const { port } = nestedServer.address() as AddressInfo;
      listening.resolve({ port });
    });
    const { port } = await listening.promise;
    const nestedClient = new ItsaplanClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "itp_test_key",
    });
    try {
      const columns = await nestedClient.listProjectColumns("ENG");
      expect(columns.map((column) => column.name)).toEqual(["Backlog", "Todo"]);
    } finally {
      const closed = Promise.withResolvers<void>();
      nestedServer.close(() => closed.resolve());
      await closed.promise;
    }
  });

  test("ensureColumn returns an existing column by name without creating one", async () => {
    const column = await client.ensureColumn("ENG", "In Progress", "started");
    expect(column.id).toBe(11);
    expect(state.columns).toHaveLength(2);
  });

  test("ensureColumn creates a column when no matching name exists", async () => {
    const column = await client.ensureColumn("ENG", "Ready to review", "started");
    expect(column.name).toBe("Ready to review");
    expect(column.stateType).toBe("started");
    expect(state.columns).toHaveLength(3);
  });

  test("createProject posts key and name", async () => {
    const created = await client.createProject({ key: "NEW", name: "New Project" });
    expect(created).toEqual({ id: 42, key: "NEW", name: "New Project" });
    expect(serverHandle.posts.projects).toEqual([{ key: "NEW", name: "New Project" }]);
  });

  test("registerWebhook posts the url, events, and secret", async () => {
    const webhook = await client.registerWebhook("ENG", {
      url: "http://example.test/webhook",
      events: ["issue.state_changed"],
      secret: "whsec_abc",
    });
    expect(webhook.url).toBe("http://example.test/webhook");
    expect(serverHandle.posts.webhooks).toEqual([
      { url: "http://example.test/webhook", events: ["issue.state_changed"], secret: "whsec_abc" },
    ]);
  });

  test("listWebhooks returns the project's registered webhooks", async () => {
    const webhooks = await client.listWebhooks("ENG");
    expect(webhooks).toEqual([
      {
        id: 7,
        projectId: 1,
        url: "http://example.test/webhook",
        events: ["issue.state_changed"],
        isActive: true,
      },
    ]);
  });

  test("updateWebhook PATCHes the event set", async () => {
    const updated = await client.updateWebhook(7, {
      events: ["issue.state_changed", "comment.created"],
    });
    expect(updated.events).toEqual(["issue.state_changed", "comment.created"]);
    expect(state.webhooks[0]?.events).toEqual(["issue.state_changed", "comment.created"]);
  });

  test("listProjectLabels extracts labels from project scaffold", async () => {
    const labels = await client.listProjectLabels("ENG");
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.name)).toEqual(["bug", "auto-chain"]);
  });

  test("createLabel posts a new label", async () => {
    const created = await client.createLabel("ENG", { name: "urgent", color: "#ff0000" });
    expect(created).toMatchObject({ name: "urgent", color: "#ff0000" });
    expect(state.labels).toContainEqual(expect.objectContaining({ name: "urgent" }));
  });

  test("ensureLabel returns existing label without re-creating", async () => {
    const existing = await client.ensureLabel("ENG", "auto-chain");
    expect(existing).toMatchObject({ id: 101, name: "auto-chain" });
    expect(state.labels).toHaveLength(2);
  });

  test("ensureLabel creates a label when absent", async () => {
    const created = await client.ensureLabel("ENG", "frontend");
    expect(created.name).toBe("frontend");
    expect(state.labels).toHaveLength(3);
  });

  test("createIssue posts a new issue with labelIds and columnId", async () => {
    const issue = await client.createIssue("ENG", {
      columnId: 10,
      title: "New Ticket",
      description: "Description",
      labelIds: [101],
    });
    expect(issue).toMatchObject({
      id: 800,
      title: "New Ticket",
      columnId: 10,
      labelIds: [101],
    });
    expect(serverHandle.posts.createdIssues).toHaveLength(1);
  });

  test("updateAiAgent PATCHes agent configuration", async () => {
    const updated = await client.updateAiAgent("ENG", 5, { triggerOnMention: true });
    expect(updated).toMatchObject({ id: 5, triggerOnMention: true });
  });

  test("claimAgentRun, heartbeatAgentRun, and postAgentRunResult drain runs", async () => {
    state.claimedRun = {
      id: 77,
      trigger: "mention",
      prompt: "Fix bug",
      systemPrompt: "System",
      attempts: 1,
      issueId: 1,
      issueIdentifier: "ENG-7",
    };
    const claimed = await client.claimAgentRun();
    expect(claimed).toEqual(state.claimedRun);

    await client.heartbeatAgentRun(77);
    expect(serverHandle.posts.runHeartbeats).toEqual([77]);

    await client.postAgentRunResult(77, { status: "success", output: "Fixed" });
    expect(serverHandle.posts.runResults).toEqual([
      { runId: 77, result: { status: "success", output: "Fixed" } },
    ]);
  });
  test("throws ItsaplanApiError with status/method/path on a non-2xx response", async () => {
    await expect(client.getIssue(404)).rejects.toMatchObject({
      name: "ItsaplanApiError",
      status: 404,
      method: "GET",
      path: "/issues/404",
    });
    await expect(client.getIssue(404)).rejects.toBeInstanceOf(ItsaplanApiError);
  });

  test("rejects when the api key is wrong", async () => {
    const badClient = new ItsaplanClient({ baseUrl: handle.baseUrl, apiKey: "wrong" });
    await expect(badClient.getIssue(1)).rejects.toMatchObject({ status: 403 });
  });
});
