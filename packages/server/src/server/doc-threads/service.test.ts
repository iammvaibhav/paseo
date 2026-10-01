import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocThread, DocThreadAnchor } from "@getpaseo/protocol/doc-threads/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DocThreadsError, DocThreadsService, type DocThreadChangedEvent } from "./service.js";
import { DocThreadStore, newDocThreadId } from "./store.js";
import { DocThreadsSession, formatDocThreadPrompt, type DocThreadsHost } from "./session.js";
import { registerDocThreadTools } from "./tools.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { SessionOutboundMessage } from "../messages.js";

let directory: string;
let store: DocThreadStore;
let service: DocThreadsService;
const agentWorkspaces = new Map<string, { workspaceId: string; cwd: string }>();

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-doc-threads-"));
  const opened = await DocThreadStore.open({ directory, logger: createTestLogger() });
  if (!opened) {
    throw new Error("node:sqlite is required for the doc-threads tests");
  }
  store = opened;
  agentWorkspaces.clear();
  agentWorkspaces.set("ag-1", { workspaceId: "ws-1", cwd: "/repo" });
  agentWorkspaces.set("ag-2", { workspaceId: "ws-1", cwd: "/repo" });

  service = new DocThreadsService({
    store,
    logger: createTestLogger(),
    agents: {
      async getAgentWorkspace(agentId) {
        return agentWorkspaces.get(agentId) ?? null;
      },
    },
  });
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe("DocThreadStore & Anchoring", () => {
  it("generates random thread ids", () => {
    const id1 = newDocThreadId();
    const id2 = newDocThreadId();
    expect(id1).toMatch(/^dth_[0-9a-f]{16}$/);
    expect(id2).toMatch(/^dth_[0-9a-f]{16}$/);
    expect(id1).not.toBe(id2);
  });

  it("inserts and hydrates a thread with anchor fields", () => {
    const id = newDocThreadId();
    const now = new Date().toISOString();
    const anchor: DocThreadAnchor = {
      quote: "const x = 1;",
      startLine: 10,
      endLine: 12,
      before: "function foo() {\n",
      after: "\n  return x;\n}",
    };

    store.insertThread({
      id,
      agentId: "ag-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      path: "src/foo.ts",
      anchor,
      status: "open",
      createdAt: now,
      updatedAt: now,
      firstMessage: { author: "user", body: "Is this correct?", ts: now },
    });

    const thread = store.getThread(id);
    expect(thread).not.toBeNull();
    expect(thread?.id).toBe(id);
    expect(thread?.agentId).toBe("ag-1");
    expect(thread?.path).toBe("src/foo.ts");
    expect(thread?.status).toBe("open");
    expect(thread?.anchor).toEqual(anchor);
    expect(thread?.messages).toEqual([{ author: "user", body: "Is this correct?", ts: now }]);

    const record = store.getThreadRecord(id);
    expect(record?.workspaceId).toBe("ws-1");
    expect(record?.cwd).toBe("/repo");
  });

  it("appends messages and updates thread status", () => {
    const id = newDocThreadId();
    const t0 = new Date(1000).toISOString();
    const t1 = new Date(2000).toISOString();
    const t2 = new Date(3000).toISOString();

    store.insertThread({
      id,
      agentId: "ag-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      path: "README.md",
      anchor: { quote: "intro", startLine: 1, endLine: 1 },
      status: "open",
      createdAt: t0,
      updatedAt: t0,
      firstMessage: { author: "user", body: "first", ts: t0 },
    });

    store.appendMessage({
      threadId: id,
      message: { author: "agent", body: "second", ts: t1 },
      updatedAt: t1,
    });

    let thread = store.getThread(id);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[1]).toEqual({ author: "agent", body: "second", ts: t1 });
    expect(thread?.updatedAt).toBe(t1);

    store.setStatus(id, "resolved", t2);
    thread = store.getThread(id);
    expect(thread?.status).toBe("resolved");
    expect(thread?.updatedAt).toBe(t2);
  });

  it("lists thread records filtered by agent, workspace, and optional path", () => {
    const t0 = new Date(1000).toISOString();
    store.insertThread({
      id: "t1",
      agentId: "ag-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      path: "a.ts",
      anchor: { quote: "a", startLine: 1, endLine: 1 },
      status: "open",
      createdAt: t0,
      updatedAt: t0,
      firstMessage: { author: "user", body: "msg", ts: t0 },
    });
    store.insertThread({
      id: "t2",
      agentId: "ag-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      path: "b.ts",
      anchor: { quote: "b", startLine: 1, endLine: 1 },
      status: "open",
      createdAt: t0,
      updatedAt: t0,
      firstMessage: { author: "user", body: "msg", ts: t0 },
    });
    store.insertThread({
      id: "t3",
      agentId: "ag-2",
      workspaceId: "ws-1",
      cwd: "/repo",
      path: "a.ts",
      anchor: { quote: "a", startLine: 1, endLine: 1 },
      status: "open",
      createdAt: t0,
      updatedAt: t0,
      firstMessage: { author: "user", body: "msg", ts: t0 },
    });

    const ag1All = store.listThreadRecords({ agentId: "ag-1", workspaceId: "ws-1" });
    expect(ag1All.map((r) => r.id)).toEqual(["t1", "t2"]);

    const ag1PathA = store.listThreadRecords({
      agentId: "ag-1",
      workspaceId: "ws-1",
      path: "a.ts",
    });
    expect(ag1PathA.map((r) => r.id)).toEqual(["t1"]);

    const ag2PathA = store.listThreadRecords({
      agentId: "ag-2",
      workspaceId: "ws-1",
      path: "a.ts",
    });
    expect(ag2PathA.map((r) => r.id)).toEqual(["t3"]);
  });
});

describe("DocThreadsService", () => {
  it("creates, replies, and resolves threads with change event emissions", async () => {
    const changes: DocThreadChangedEvent[] = [];
    service.onChange((e) => changes.push(e));

    const thread = await service.createThread({
      cwd: "/repo",
      agentId: "ag-1",
      path: "docs/spec.md",
      anchor: { quote: "hello", startLine: 3, endLine: 4 },
      body: "Please clarify this.",
    });

    expect(thread.id).toMatch(/^dth_/);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].author).toBe("user");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ agentId: "ag-1", path: "docs/spec.md", threadIds: [thread.id] });

    const replied = await service.replyToThread(
      { cwd: "/repo", threadId: thread.id, body: "Done!" },
      "agent",
      "ag-1",
    );
    expect(replied.messages).toHaveLength(2);
    expect(replied.messages[1].author).toBe("agent");
    expect(changes).toHaveLength(2);

    const resolved = await service.resolveThread({
      cwd: "/repo",
      threadId: thread.id,
      resolved: true,
    });
    expect(resolved.status).toBe("resolved");
    expect(changes).toHaveLength(3);
  });

  it("supports commentOnFile for agent-initiated threads", async () => {
    const thread = await service.commentOnFile({
      agentId: "ag-1",
      path: "src/main.ts",
      anchor: { quote: "fn main()", startLine: 1, endLine: 1 },
      body: "I refactored this function.",
    });

    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].author).toBe("agent");
    expect(thread.messages[0].body).toBe("I refactored this function.");
  });

  it("enforces expectedAgentId on replyToThread", async () => {
    const thread = await service.createThread({
      cwd: "/repo",
      agentId: "ag-1",
      path: "index.ts",
      anchor: { quote: "test", startLine: 1, endLine: 1 },
      body: "Check this",
    });

    await expect(
      service.replyToThread(
        { cwd: "/repo", threadId: thread.id, body: "Hacked!" },
        "agent",
        "ag-2",
      ),
    ).rejects.toThrow(DocThreadsError);
  });

  it("validates threadsForSend and rejects invalid/resolved/cross-agent threads", async () => {
    const t1 = await service.createThread({
      cwd: "/repo",
      agentId: "ag-1",
      path: "1.ts",
      anchor: { quote: "q1", startLine: 1, endLine: 1 },
      body: "b1",
    });
    const t2 = await service.createThread({
      cwd: "/repo",
      agentId: "ag-1",
      path: "2.ts",
      anchor: { quote: "q2", startLine: 1, endLine: 1 },
      body: "b2",
    });
    const t3 = await service.createThread({
      cwd: "/repo",
      agentId: "ag-2",
      path: "3.ts",
      anchor: { quote: "q3", startLine: 1, endLine: 1 },
      body: "b3",
    });

    const forSend = await service.threadsForSend({
      cwd: "/repo",
      agentId: "ag-1",
      threadIds: [t1.id, t2.id, t1.id], // duplicates deduplicated
    });
    expect(forSend.map((t) => t.id)).toEqual([t1.id, t2.id]);

    await expect(
      service.threadsForSend({ cwd: "/repo", agentId: "ag-1", threadIds: [t3.id] }),
    ).rejects.toThrow(/belongs to another agent/);

    await service.resolveThread({ cwd: "/repo", threadId: t1.id, resolved: true });
    await expect(
      service.threadsForSend({ cwd: "/repo", agentId: "ag-1", threadIds: [t1.id] }),
    ).rejects.toThrow(/is resolved/);
  });

  it("normalizes and rejects invalid paths", async () => {
    await expect(
      service.createThread({
        cwd: "/repo",
        agentId: "ag-1",
        path: "../outside.ts",
        anchor: { quote: "q", startLine: 1, endLine: 1 },
        body: "bad path",
      }),
    ).rejects.toThrow(/Invalid thread path/);

    await expect(
      service.createThread({
        cwd: "/repo",
        agentId: "ag-1",
        path: "/absolute/path.ts",
        anchor: { quote: "q", startLine: 1, endLine: 1 },
        body: "bad path",
      }),
    ).rejects.toThrow(/Invalid thread path/);
  });

  it("rejects operations for unknown agents", async () => {
    await expect(service.listThreads({ cwd: "/repo", agentId: "nonexistent" })).rejects.toThrow(
      /Agent not found on this host/,
    );
  });
});

describe("DocThreadsSession RPCs & Prompt Formatting", () => {
  it("formats multi-thread prompts with thread ID, file path, anchor and history", () => {
    const prompt = formatDocThreadPrompt([
      {
        id: "dth-123",
        agentId: "ag-1",
        workspaceId: "ws-1",
        cwd: "/repo",
        path: "src/app.ts",
        anchor: { quote: "const a = 42;", startLine: 5, endLine: 5, before: "// preamble\n" },
        messages: [
          { author: "user", body: "Why 42?", ts: "2026-10-01T00:00:00Z" },
          { author: "agent", body: "The answer.", ts: "2026-10-01T00:01:00Z" },
        ],
        status: "open",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:01:00Z",
      },
    ]);

    expect(prompt).toContain("## Thread 1: src/app.ts");
    expect(prompt).toContain("Thread ID: dth-123");
    expect(prompt).toContain("Anchor (lines 5-5):");
    expect(prompt).toContain("> const a = 42;");
    expect(prompt).toContain("Before:\n// preamble");
    expect(prompt).toContain("[user @ 2026-10-01T00:00:00Z]\nWhy 42?");
    expect(prompt).toContain("[agent @ 2026-10-01T00:01:00Z]\nThe answer.");
  });

  it("dispatches RPC messages and emits correlated responses", async () => {
    const emitted: SessionOutboundMessage[] = [];

    const mockAgentManager = {
      hasInFlightRun: () => false,
      getAgent: () => ({ provider: "codex" }),
    } as unknown as AgentManager;

    const mockAgentStorage = {} as unknown as AgentStorage;

    const host: DocThreadsHost = {
      service,
      delivery: {
        agentManager: mockAgentManager,
        agentStorage: mockAgentStorage,
        logger: createTestLogger(),
      },
    };

    const session = new DocThreadsSession({
      emit: (msg) => emitted.push(msg),
      host,
      logger: createTestLogger(),
    });

    // 1. Create thread RPC
    await session.dispatch({
      type: "doc_threads.create.request",
      requestId: "r1",
      cwd: "/repo",
      agentId: "ag-1",
      path: "main.go",
      anchor: { quote: "package main", startLine: 1, endLine: 1 },
      body: "Initial comment",
    });

    expect(emitted).toHaveLength(1);
    const createResp = emitted[0];
    expect(createResp.type).toBe("doc_threads.create.response");
    if (createResp.type !== "doc_threads.create.response") throw new Error("wrong type");
    const thread = createResp.payload.thread;
    expect(thread).not.toBeNull();
    expect(thread?.id).toMatch(/^dth_/);
    expect(createResp.payload.error).toBeNull();

    // 2. List threads RPC
    await session.dispatch({
      type: "doc_threads.list.request",
      requestId: "r2",
      cwd: "/repo",
      agentId: "ag-1",
      path: "main.go",
    });

    expect(emitted).toHaveLength(2);
    const listResp = emitted[1];
    expect(listResp.type).toBe("doc_threads.list.response");
    if (listResp.type !== "doc_threads.list.response") throw new Error("wrong type");
    expect(listResp.payload.threads).toHaveLength(1);

    // 3. Reply thread RPC
    await session.dispatch({
      type: "doc_threads.reply.request",
      requestId: "r3",
      cwd: "/repo",
      threadId: thread!.id,
      body: "Another user comment",
    });

    expect(emitted).toHaveLength(3);
    const replyResp = emitted[2];
    expect(replyResp.type).toBe("doc_threads.reply.response");
    if (replyResp.type !== "doc_threads.reply.response") throw new Error("wrong type");
    expect(replyResp.payload.thread?.messages).toHaveLength(2);

    // 4. Resolve thread RPC
    await session.dispatch({
      type: "doc_threads.resolve.request",
      requestId: "r4",
      cwd: "/repo",
      threadId: thread!.id,
      resolved: true,
    });

    expect(emitted).toHaveLength(4);
    const resolveResp = emitted[3];
    expect(resolveResp.type).toBe("doc_threads.resolve.response");
    if (resolveResp.type !== "doc_threads.resolve.response") throw new Error("wrong type");
    expect(resolveResp.payload.thread?.status).toBe("resolved");
  });

  it("dispatches send_all, waiting for in-flight run to become idle before delivery", async () => {
    const emitted: SessionOutboundMessage[] = [];
    let inFlightRuns = 2; // simulates busy agent for 2 iterations
    const runsStarted: Array<{ agentId: string; prompt: unknown }> = [];

    const thread = await service.createThread({
      cwd: "/repo",
      agentId: "ag-1",
      path: "queued.ts",
      anchor: { quote: "busy", startLine: 1, endLine: 1 },
      body: "User comment to queue",
    });

    const mockAgentManager = {
      hasInFlightRun: () => {
        if (inFlightRuns > 0) {
          inFlightRuns--;
          return true;
        }
        return false;
      },
      getAgent: () => ({ provider: "codex" }),
      tryRunOutOfBand: (_id: string, prompt: unknown) => {
        runsStarted.push({ agentId: "ag-1", prompt });
        return true;
      },
    } as unknown as AgentManager;

    const host: DocThreadsHost = {
      service,
      delivery: {
        agentManager: mockAgentManager,
        agentStorage: {} as unknown as AgentStorage,
        logger: createTestLogger(),
      },
    };

    const session = new DocThreadsSession({
      emit: (msg) => emitted.push(msg),
      host,
      logger: createTestLogger(),
    });

    await session.dispatch({
      type: "doc_threads.send_all.request",
      requestId: "s1",
      cwd: "/repo",
      agentId: "ag-1",
      threadIds: [thread.id],
    });

    expect(emitted).toHaveLength(1);
    const resp = emitted[0];
    expect(resp.type).toBe("doc_threads.send_all.response");
    if (resp.type !== "doc_threads.send_all.response") throw new Error("wrong type");
    expect(resp.payload.sent).toBe(true);
    expect(resp.payload.error).toBeNull();
    expect(runsStarted).toHaveLength(1);
    expect(inFlightRuns).toBe(0);
  });
});

describe("MCP Tools (reply_to_thread, list_threads, comment_on_file)", () => {
  it("registers tools and enforces callerAgentId scoping", async () => {
    const tools = new Map<string, PaseoToolDefinition>();
    registerDocThreadTools({
      registerTool: (name, config, handler) => {
        tools.set(name, { name, description: config.description ?? "", ...config, handler });
      },
      resolveService: () => service,
      callerAgentId: "ag-1",
    });

    expect(tools.has("reply_to_thread")).toBe(true);
    expect(tools.has("list_threads")).toBe(true);
    expect(tools.has("comment_on_file")).toBe(true);

    // 1. comment_on_file
    const commentTool = tools.get("comment_on_file");
    expect(commentTool).toBeDefined();
    const commentRes = await commentTool!.handler(
      {
        path: "lib.rs",
        anchor: { quote: "fn helper()", startLine: 10, endLine: 10 },
        body: "I changed helper signature",
      },
      {},
    );
    const commentData = commentRes.structuredContent as { ok: boolean; thread: DocThread };
    expect(commentData.ok).toBe(true);
    const thread = commentData.thread;
    expect(thread.agentId).toBe("ag-1");
    expect(thread.messages[0].author).toBe("agent");

    // 2. list_threads
    const listTool = tools.get("list_threads");
    expect(listTool).toBeDefined();
    const listRes = await listTool!.handler({ path: "lib.rs" }, {});
    const listData = listRes.structuredContent as { ok: boolean; threads: DocThread[] };
    expect(listData.ok).toBe(true);
    expect(listData.threads).toHaveLength(1);

    // 3. reply_to_thread
    const replyTool = tools.get("reply_to_thread");
    expect(replyTool).toBeDefined();
    const replyRes = await replyTool!.handler({ threadId: thread.id, body: "Acknowledged." }, {});
    const replyData = replyRes.structuredContent as { ok: boolean; thread: DocThread };
    expect(replyData.ok).toBe(true);
    expect(replyData.thread.messages).toHaveLength(2);
    expect(replyData.thread.messages[1].author).toBe("agent");
  });

  it("prevents calling doc-threads tools without agent context", async () => {
    const tools = new Map<string, PaseoToolDefinition>();
    registerDocThreadTools({
      registerTool: (name, config, handler) => {
        tools.set(name, { name, description: config.description ?? "", ...config, handler });
      },
      resolveService: () => service,
      callerAgentId: undefined,
    });

    const listTool = tools.get("list_threads");
    expect(listTool).toBeDefined();
    await expect(listTool!.handler({}, {})).rejects.toThrow(
      /Doc thread tools are only available to agent-scoped sessions/,
    );
  });
});
