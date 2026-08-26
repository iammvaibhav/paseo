import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  ensureItsaplanProjectMapping,
  ItsaplanProjectStore,
  type ItsaplanCentralConfig,
  type ItsaplanProjectMapping,
  type ItsaplanProjectSyncDependencies,
} from "./projects.js";
import { ItsaplanChatRunner, type ItsaplanChatRunnerMissionControl } from "./chat-runner.js";

interface AgentRecord {
  id: number;
  projectKey: string;
  username: string;
  apiKey: string;
  triggerOnMention: boolean;
}

interface ChatMessageRecord {
  id: number;
  agentId: number;
  prompt: string;
  systemPrompt: string;
  events: Array<Record<string, unknown>>;
  heartbeats: number;
  result: { status: string; error: string | null } | null;
  canceled: boolean;
}

interface AgentRunRecord {
  id: number;
  agentId: number;
  trigger: string;
  prompt: string;
  systemPrompt: string;
  attempts: number;
  issueId: number | null;
  issueIdentifier: string | null;
  heartbeats: number;
  result: { status: string; output?: string | null; error?: string | null } | null;
}

/**
 * Fake itsaplan server covering both surfaces the chat-runner slice touches:
 * the project-admin surface (create project, register webhook, create/list
 * ai-agents, regenerate-key — auth: the project's own api key) and the
 * runner surface (agent-chats claim/events/heartbeat/result — auth: the
 * calling agent's OWN api key, per apps/api/src/modules/agents/runner-auth.ts
 * `runnerAgent` macro).
 */
function startFakeItsaplanServer(projectApiKey: string) {
  const createdProjects: Array<{ key: string; name: string }> = [];
  const registeredWebhooks: Array<{ projectKey: string; url: string; events: string[] }> = [];
  const agentsByProjectKey = new Map<string, AgentRecord[]>();
  const agentsByApiKey = new Map<string, AgentRecord>();
  const messagesById = new Map<number, ChatMessageRecord>();
  const pendingByAgentId = new Map<number, number[]>();
  const runsById = new Map<number, AgentRunRecord>();
  const pendingRunsByAgentId = new Map<number, number[]>();
  const postedComments: Array<{ issueId: number; body: string }> = [];
  let nextProjectId = 1;
  let nextAgentId = 1;
  let nextMessageId = 1;
  let nextRunId = 1;

  function agentByApiKey(req: {
    headers: Record<string, string | string[] | undefined>;
  }): AgentRecord | null {
    const key = req.headers["x-api-key"];
    return typeof key === "string" ? (agentsByApiKey.get(key) ?? null) : null;
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    // eslint-disable-next-line complexity -- in-test HTTP router
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      const send = (status: number, json?: unknown): void => {
        if (json === undefined) {
          res.writeHead(status);
          res.end();
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // --- runner surface: auth = the calling agent's OWN api key ---
      if (path === "/agent-chats/claim" && req.method === "POST") {
        const agent = agentByApiKey(req);
        if (!agent) {
          send(403, { error: "forbidden" });
          return;
        }
        const queue = pendingByAgentId.get(agent.id) ?? [];
        const id = queue.shift();
        if (id === undefined) {
          // A short stand-in for itsaplan's real ~25s long-poll wait, so the
          // runner's claim loop naturally paces itself between empty polls.
          setTimeout(() => send(200, { message: null }), 15);
          return;
        }
        const message = messagesById.get(id);
        if (!message) {
          send(200, { message: null });
          return;
        }
        send(200, {
          message: {
            id: message.id,
            threadId: `thread-${message.id}`,
            prompt: message.prompt,
            systemPrompt: message.systemPrompt,
            attempts: 1,
            sessionId: null,
          },
        });
        return;
      }
      const eventsMatch = /^\/agent-chats\/(\d+)\/events$/.exec(path);
      if (eventsMatch && req.method === "POST") {
        const agent = agentByApiKey(req);
        const message = messagesById.get(Number(eventsMatch[1]));
        if (!agent || !message || message.agentId !== agent.id) {
          send(404, { error: "not found" });
          return;
        }
        message.events.push(...((body.events as Array<Record<string, unknown>>) ?? []));
        send(200, { canceled: message.canceled });
        return;
      }
      const heartbeatMatch = /^\/agent-chats\/(\d+)\/heartbeat$/.exec(path);
      if (heartbeatMatch && req.method === "POST") {
        const agent = agentByApiKey(req);
        const message = messagesById.get(Number(heartbeatMatch[1]));
        if (!agent || !message || message.agentId !== agent.id) {
          send(404, { error: "not found" });
          return;
        }
        message.heartbeats += 1;
        send(200, { canceled: message.canceled });
        return;
      }
      const resultMatch = /^\/agent-chats\/(\d+)\/result$/.exec(path);
      if (resultMatch && req.method === "POST") {
        const agent = agentByApiKey(req);
        const message = messagesById.get(Number(resultMatch[1]));
        if (!agent || !message || message.agentId !== agent.id) {
          send(404, { error: "not found" });
          return;
        }
        message.result = {
          status: String(body.status),
          error: (body.error as string | null | undefined) ?? null,
        };
        send(204);
        return;
      }

      // --- runner surface: agent runs ---
      if (path === "/agent-runs/claim" && req.method === "POST") {
        const agent = agentByApiKey(req);
        if (!agent) {
          send(403, { error: "forbidden" });
          return;
        }
        const queue = pendingRunsByAgentId.get(agent.id) ?? [];
        const id = queue.shift();
        if (id === undefined) {
          setTimeout(() => send(200, { run: null }), 15);
          return;
        }
        const run = runsById.get(id);
        if (!run) {
          send(200, { run: null });
          return;
        }
        send(200, {
          run: {
            id: run.id,
            trigger: run.trigger,
            prompt: run.prompt,
            systemPrompt: run.systemPrompt,
            attempts: run.attempts,
            issueId: run.issueId,
            issueIdentifier: run.issueIdentifier,
          },
        });
        return;
      }
      const runHeartbeatMatch = /^\/agent-runs\/(\d+)\/heartbeat$/.exec(path);
      if (runHeartbeatMatch && req.method === "POST") {
        const agent = agentByApiKey(req);
        const run = runsById.get(Number(runHeartbeatMatch[1]));
        if (!agent || !run || run.agentId !== agent.id) {
          send(404, { error: "not found" });
          return;
        }
        run.heartbeats += 1;
        send(204);
        return;
      }
      const runResultMatch = /^\/agent-runs\/(\d+)\/result$/.exec(path);
      if (runResultMatch && req.method === "POST") {
        const agent = agentByApiKey(req);
        const run = runsById.get(Number(runResultMatch[1]));
        if (!agent || !run || run.agentId !== agent.id) {
          send(404, { error: "not found" });
          return;
        }
        run.result = {
          status: String(body.status),
          output: (body.output as string | null | undefined) ?? null,
          error: (body.error as string | null | undefined) ?? null,
        };
        send(204);
        return;
      }
      const commentMatch = /^\/issues\/(\d+)\/comments$/.exec(path);
      if (commentMatch && req.method === "POST") {
        postedComments.push({ issueId: Number(commentMatch[1]), body: String(body.body) });
        send(200, { id: postedComments.length });
        return;
      }
      // --- project-admin surface: auth = the project's own api key ---
      if (req.headers["x-api-key"] !== projectApiKey) {
        send(403, { error: "forbidden" });
        return;
      }
      if (path === "/projects" && req.method === "POST") {
        const created = { id: nextProjectId++, key: String(body.key), name: String(body.name) };
        createdProjects.push({ key: created.key, name: created.name });
        send(201, created);
        return;
      }
      const webhooksMatch = /^\/projects\/([^/]+)\/webhooks$/.exec(path);
      if (webhooksMatch && req.method === "POST") {
        const projectKey = decodeURIComponent(webhooksMatch[1]);
        registeredWebhooks.push({
          projectKey,
          url: String(body.url),
          events: body.events as string[],
        });
        send(201, {
          id: registeredWebhooks.length,
          projectId: 1,
          url: body.url,
          events: body.events,
          isActive: true,
          secret: "whsec_fake",
        });
        return;
      }
      const agentsMatch = /^\/projects\/([^/]+)\/ai-agents$/.exec(path);
      if (agentsMatch && req.method === "POST") {
        const projectKey = decodeURIComponent(agentsMatch[1]);
        const existing = agentsByProjectKey.get(projectKey) ?? [];
        const username = String(body.username);
        if (existing.some((agent) => agent.username.toLowerCase() === username.toLowerCase())) {
          send(409, { error: "An agent with this username already exists" });
          return;
        }
        const agent: AgentRecord = {
          id: nextAgentId++,
          projectKey,
          username,
          apiKey: `itp_agent_${nextAgentId}`,
          triggerOnMention: Boolean(body.triggerOnMention),
        };
        existing.push(agent);
        agentsByProjectKey.set(projectKey, existing);
        agentsByApiKey.set(agent.apiKey, agent);
        pendingByAgentId.set(agent.id, []);
        send(201, {
          agent: {
            id: agent.id,
            projectId: 1,
            userId: `user-${agent.id}`,
            username: agent.username,
            kind: "external",
          },
          apiKey: agent.apiKey,
        });
        return;
      }
      if (agentsMatch && req.method === "GET") {
        const projectKey = decodeURIComponent(agentsMatch[1]);
        const list = agentsByProjectKey.get(projectKey) ?? [];
        send(
          200,
          list.map((agent) => ({
            id: agent.id,
            projectId: 1,
            userId: `user-${agent.id}`,
            username: agent.username,
            kind: "external",
          })),
        );
        return;
      }
      const regenerateMatch = /^\/projects\/([^/]+)\/ai-agents\/(\d+)\/regenerate-key$/.exec(path);
      if (regenerateMatch && req.method === "POST") {
        const projectKey = decodeURIComponent(regenerateMatch[1]);
        const agentId = Number(regenerateMatch[2]);
        const agent = (agentsByProjectKey.get(projectKey) ?? []).find(
          (candidate) => candidate.id === agentId,
        );
        if (!agent) {
          send(404, { error: "not found" });
          return;
        }
        agentsByApiKey.delete(agent.apiKey);
        agent.apiKey = `itp_agent_regen_${agentId}`;
        agentsByApiKey.set(agent.apiKey, agent);
        send(200, { apiKey: agent.apiKey });
        return;
      }
      const agentPatchMatch = /^\/projects\/([^/]+)\/ai-agents\/(\d+)$/.exec(path);
      if (agentPatchMatch && req.method === "PATCH") {
        const projectKey = decodeURIComponent(agentPatchMatch[1]);
        const agentId = Number(agentPatchMatch[2]);
        const agent = (agentsByProjectKey.get(projectKey) ?? []).find((a) => a.id === agentId);
        if (!agent) {
          send(404, { error: "not found" });
          return;
        }
        if (body.triggerOnMention !== undefined) {
          agent.triggerOnMention = Boolean(body.triggerOnMention);
        }
        send(200, {
          id: agent.id,
          projectId: 1,
          userId: `user-${agent.id}`,
          username: agent.username,
          kind: "external",
          triggerOnMention: agent.triggerOnMention,
        });
        return;
      }
      send(404, { error: `unhandled ${req.method} ${path}` });
    });
  });

  return {
    server,
    createdProjects,
    registeredWebhooks,
    /** Pre-registers an agent directly (bypassing createAiAgent) so
     * chat-runner tests can seed a Commander identity without exercising the
     * project-sync flow, which is covered separately. */
    seedAgent(projectKey: string, username: string): AgentRecord {
      const agent: AgentRecord = {
        id: nextAgentId++,
        projectKey,
        username,
        apiKey: `itp_agent_seed_${projectKey}_${username}`,
        triggerOnMention: true,
      };
      const list = agentsByProjectKey.get(projectKey) ?? [];
      list.push(agent);
      agentsByProjectKey.set(projectKey, list);
      agentsByApiKey.set(agent.apiKey, agent);
      pendingByAgentId.set(agent.id, []);
      pendingRunsByAgentId.set(agent.id, []);
      return agent;
    },
    enqueueAgentRun(
      agentId: number,
      prompt: string,
      systemPrompt = "",
      issueId: number | null = null,
      issueIdentifier: string | null = null,
    ): number {
      const id = nextRunId++;
      runsById.set(id, {
        id,
        agentId,
        trigger: "mention",
        prompt,
        systemPrompt,
        attempts: 1,
        issueId,
        issueIdentifier,
        heartbeats: 0,
        result: null,
      });
      const queue = pendingRunsByAgentId.get(agentId) ?? [];
      queue.push(id);
      pendingRunsByAgentId.set(agentId, queue);
      return id;
    },
    getAgentRun(id: number): AgentRunRecord | undefined {
      return runsById.get(id);
    },
    postedComments,
    enqueueChat(agentId: number, prompt: string, systemPrompt = ""): number {
      const id = nextMessageId++;
      messagesById.set(id, {
        id,
        agentId,
        prompt,
        systemPrompt,
        events: [],
        heartbeats: 0,
        result: null,
        canceled: false,
      });
      const queue = pendingByAgentId.get(agentId) ?? [];
      queue.push(id);
      pendingByAgentId.set(agentId, queue);
      return id;
    },
    getMessage(id: number): ChatMessageRecord | undefined {
      return messagesById.get(id);
    },
    findAgent(projectKey: string, username: string): AgentRecord | undefined {
      return (agentsByProjectKey.get(projectKey) ?? []).find(
        (agent) => agent.username === username,
      );
    },
  };
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

function buildAnswerEvent(instructionId: string, body: string): MissionControlEvent {
  return {
    id: "mce_test_answer",
    ts: new Date().toISOString(),
    agentId: "commander-1",
    agentTitle: "Commander",
    kind: "answer",
    source: "system",
    severity: "info",
    headline: `Answer to ${instructionId}`,
    answer: {
      kind: "generic",
      headline: `Answer to ${instructionId}`,
      body,
      respondsTo: instructionId,
    },
  };
}

function createFakeMissionControl(
  deliver: (input: {
    text: string;
    source: "chat";
    messageId?: string;
  }) => Promise<
    { ok: true; instructionId: string; deliveredAs: "run" | "steer" } | { ok: false; error: string }
  >,
): {
  control: ItsaplanChatRunnerMissionControl;
  deliverCalls: Array<{ text: string; source: "chat"; messageId?: string }>;
  emit: (event: MissionControlEvent) => void;
} {
  const deliverCalls: Array<{ text: string; source: "chat"; messageId?: string }> = [];
  const listeners = new Set<(event: MissionControlEvent) => void>();
  return {
    control: {
      deliverCommanderInstruction: async (input) => {
        deliverCalls.push(input);
        return deliver(input);
      },
      subscribeEvents: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    deliverCalls,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe("itsaplan Commander agent auto-registration (project sync)", () => {
  let fakeServer: ReturnType<typeof startFakeItsaplanServer>;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig;
  let store: ItsaplanProjectStore;
  let paseoHome: string;
  let deps: ItsaplanProjectSyncDependencies;

  beforeEach(async () => {
    fakeServer = startFakeItsaplanServer("itp_admin_key");
    handle = await listen(fakeServer.server);
    config = { baseUrl: handle.baseUrl, apiKey: "itp_admin_key", webhookSecret: "whsec_central" };
    paseoHome = await mkdtemp(join(tmpdir(), "itsaplan-chat-runner-sync-test-"));
    store = new ItsaplanProjectStore({ paseoHome, logger: createTestLogger() });
    await store.initialize();
    deps = {
      store,
      getConfig: () => config,
      getWebhookUrl: () => "http://127.0.0.1:9999/api/itsaplan/webhook",
      paseoHome,
      isDesignatedSyncHost: () => true,
      logger: createTestLogger(),
    };
  });

  afterEach(async () => {
    await handle.close();
    await rm(paseoHome, { recursive: true, force: true });
  });

  function project(): {
    projectKey: string;
    displayName: string;
    customName: string | null;
    rootPath: string;
  } {
    return {
      projectKey: "ENG",
      displayName: "Engineering",
      customName: null,
      rootPath: "/repo/eng",
    };
  }

  test("creates a Commander external agent alongside the project mapping", async () => {
    const mapping = await ensureItsaplanProjectMapping(project(), deps);
    expect(mapping).toMatchObject({
      paseoProjectKey: "ENG",
      commanderUsername: "commander",
    });
    expect(mapping?.commanderAgentId).toEqual(expect.any(Number));
    expect(mapping?.commanderApiKey).toEqual(expect.any(String));
    // The agent is created under the DERIVED itsaplan key ("Engineering"
    // -> "ENGINEERING"), not the raw paseo projectKey.
    const created = fakeServer.findAgent("ENGINEERING", "commander");
    expect(created).toBeDefined();
    expect(created?.triggerOnMention).toBe(true);
    expect(created?.apiKey).toBe(mapping?.commanderApiKey);
  });

  test("is idempotent: a second sync creates no second Commander agent", async () => {
    const first = await ensureItsaplanProjectMapping(project(), deps);
    const second = await ensureItsaplanProjectMapping(project(), deps);
    expect(second).toEqual(first);
    expect(fakeServer.findAgent("ENGINEERING", "commander")).toBeDefined();
  });

  test("recovers via regenerate-key when the agent already exists on itsaplan but the store lost its key", async () => {
    // Simulate a mapping written before this field existed: the itsaplan
    // project + webhook already exist, but the store has no Commander
    // credentials, and itsaplan already has a "commander" agent from an
    // earlier (crashed) attempt.
    const created = fakeServer.seedAgent("ENG", "commander");
    const originalApiKey = created.apiKey;
    const staleMapping: ItsaplanProjectMapping = {
      paseoProjectKey: "ENG",
      itsaplanProjectId: 1,
      itsaplanProjectKey: "ENG",
      createdAt: new Date().toISOString(),
    };
    await store.upsert(staleMapping);

    const backfilled = await ensureItsaplanProjectMapping(project(), deps);
    expect(backfilled?.commanderAgentId).toBe(created.id);
    expect(backfilled?.commanderUsername).toBe("commander");
    // Recovered via regenerate-key, not the original seed key (which this
    // store never had a chance to capture).
    expect(backfilled?.commanderApiKey).not.toBe(originalApiKey);
    expect(backfilled?.commanderApiKey).toBe(fakeServer.findAgent("ENG", "commander")?.apiKey);
    // No duplicate project/webhook: the backfill path never re-creates them.
    expect(fakeServer.createdProjects).toHaveLength(0);
  });
});

describe("ItsaplanChatRunner", () => {
  let fakeServer: ReturnType<typeof startFakeItsaplanServer>;
  let handle: { baseUrl: string; close: () => Promise<void> };
  let config: ItsaplanCentralConfig | null;
  let paseoHome: string;
  let store: ItsaplanProjectStore;
  let commanderAgent: AgentRecord;
  let runner: ItsaplanChatRunner | null;

  beforeEach(async () => {
    fakeServer = startFakeItsaplanServer("itp_admin_key");
    handle = await listen(fakeServer.server);
    config = { baseUrl: handle.baseUrl, apiKey: "itp_admin_key", webhookSecret: "whsec_central" };
    paseoHome = await mkdtemp(join(tmpdir(), "itsaplan-chat-runner-test-"));
    store = new ItsaplanProjectStore({ paseoHome, logger: createTestLogger() });
    await store.initialize();
    commanderAgent = fakeServer.seedAgent("ENG", "commander");
    await store.upsert({
      paseoProjectKey: "ENG",
      itsaplanProjectId: 1,
      itsaplanProjectKey: "ENG",
      createdAt: new Date().toISOString(),
      commanderAgentId: commanderAgent.id,
      commanderUsername: commanderAgent.username,
      commanderApiKey: commanderAgent.apiKey,
    });
    runner = null;
  });

  afterEach(async () => {
    runner?.stop();
    await handle.close();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("is inert without central config: never claims even with a message queued", async () => {
    const fakeMC = createFakeMissionControl(async () => ({
      ok: true,
      instructionId: "#1",
      deliveredAs: "run",
    }));
    runner = new ItsaplanChatRunner({
      logger: createTestLogger(),
      projectStore: store,
      getConfig: () => null,
      missionControl: fakeMC.control,
      supervisorIntervalMs: 15,
    });
    runner.start();
    const messageId = fakeServer.enqueueChat(commanderAgent.id, "Hello?");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fakeServer.getMessage(messageId)?.result ?? null).toBeNull();
    expect(fakeMC.deliverCalls).toHaveLength(0);
  });

  test("claims a message, delivers it, heartbeats while pending, and reports the canned reply as the result", async () => {
    const fakeMC = createFakeMissionControl(async () => ({
      ok: true,
      instructionId: "#42",
      deliveredAs: "run",
    }));
    runner = new ItsaplanChatRunner({
      logger: createTestLogger(),
      projectStore: store,
      getConfig: () => config,
      missionControl: fakeMC.control,
      supervisorIntervalMs: 15,
      heartbeatIntervalMs: 15,
      replyWaitTimeoutMs: 5_000,
    });
    runner.start();

    const messageId = fakeServer.enqueueChat(
      commanderAgent.id,
      "What is the status?",
      "You are the Commander.",
    );
    await vi.waitFor(() => {
      expect(fakeMC.deliverCalls).toHaveLength(1);
    });
    expect(fakeMC.deliverCalls[0]).toMatchObject({ source: "chat" });
    expect(fakeMC.deliverCalls[0]?.text).toContain("What is the status?");
    expect(fakeMC.deliverCalls[0]?.text).toContain("You are the Commander.");

    // Heartbeats accumulate while the reply is still pending.
    await vi.waitFor(() => {
      expect(fakeServer.getMessage(messageId)?.heartbeats ?? 0).toBeGreaterThan(0);
    });
    expect(fakeServer.getMessage(messageId)?.result ?? null).toBeNull();

    fakeMC.emit(buildAnswerEvent("#42", "Everything is green."));

    await vi.waitFor(() => {
      expect(fakeServer.getMessage(messageId)?.result).toEqual({ status: "success", error: null });
    });
    const events = fakeServer.getMessage(messageId)?.events ?? [];
    expect(events).toContainEqual({ type: "RUN_STARTED" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "Everything is green." }),
    );
    expect(events).toContainEqual({ type: "RUN_FINISHED" });
  });

  test("reports the Commander unreachable when delivery fails, without leaving the claim hanging", async () => {
    const fakeMC = createFakeMissionControl(async () => ({
      ok: false,
      error: "No Commander agent on this host",
    }));
    runner = new ItsaplanChatRunner({
      logger: createTestLogger(),
      projectStore: store,
      getConfig: () => config,
      missionControl: fakeMC.control,
      supervisorIntervalMs: 15,
    });
    runner.start();

    const messageId = fakeServer.enqueueChat(commanderAgent.id, "Anyone there?");
    await vi.waitFor(() => {
      expect(fakeServer.getMessage(messageId)?.result).not.toBeNull();
    });
    expect(fakeServer.getMessage(messageId)?.result?.status).toBe("failed");
    expect(fakeServer.getMessage(messageId)?.result?.error).toContain("Commander unreachable");
    const events = fakeServer.getMessage(messageId)?.events ?? [];
    expect(events).toContainEqual(expect.objectContaining({ type: "RUN_ERROR" }));
  });

  test("reports the Commander unreachable when no reply arrives within the reply window", async () => {
    const fakeMC = createFakeMissionControl(async () => ({
      ok: true,
      instructionId: "#7",
      deliveredAs: "steer",
    }));
    runner = new ItsaplanChatRunner({
      logger: createTestLogger(),
      projectStore: store,
      getConfig: () => config,
      missionControl: fakeMC.control,
      supervisorIntervalMs: 15,
      heartbeatIntervalMs: 15,
      replyWaitTimeoutMs: 60,
    });
    runner.start();

    const messageId = fakeServer.enqueueChat(commanderAgent.id, "Ping");
    await vi.waitFor(() => {
      expect(fakeServer.getMessage(messageId)?.result).not.toBeNull();
    });
    expect(fakeServer.getMessage(messageId)?.result?.status).toBe("failed");
    expect(fakeServer.getMessage(messageId)?.result?.error).toContain("reply window");
  });

  test("claims an agent mention run, delivers it, heartbeats while pending, and reports success with reply output and comment on issue", async () => {
    const fakeMC = createFakeMissionControl(async () => ({
      ok: true,
      instructionId: "#run-42",
      deliveredAs: "run",
    }));
    runner = new ItsaplanChatRunner({
      logger: createTestLogger(),
      projectStore: store,
      getConfig: () => config,
      missionControl: fakeMC.control,
      supervisorIntervalMs: 15,
      heartbeatIntervalMs: 15,
      replyWaitTimeoutMs: 5_000,
    });
    runner.start();

    const runId = fakeServer.enqueueAgentRun(
      commanderAgent.id,
      "@commander please size this issue",
      "System context",
      10,
      "ENG-10",
    );

    await vi.waitFor(() => {
      expect(fakeMC.deliverCalls).toHaveLength(1);
    });
    expect(fakeMC.deliverCalls[0]?.text).toContain("@commander please size this issue");
    expect(fakeMC.deliverCalls[0]?.text).toContain("ENG-10");

    await vi.waitFor(() => {
      expect(fakeServer.getAgentRun(runId)?.heartbeats ?? 0).toBeGreaterThan(0);
    });
    expect(fakeServer.getAgentRun(runId)?.result ?? null).toBeNull();

    fakeMC.emit(buildAnswerEvent("#run-42", "Estimated at 3 points."));

    await vi.waitFor(() => {
      expect(fakeServer.getAgentRun(runId)?.result).toEqual({
        status: "success",
        output: "Estimated at 3 points.",
        error: null,
      });
    });
    expect(fakeServer.postedComments).toContainEqual({
      issueId: 10,
      body: "Estimated at 3 points.",
    });
  });

  test("reports agent run failed when Commander is unreachable", async () => {
    const fakeMC = createFakeMissionControl(async () => ({
      ok: false,
      error: "No Commander agent on this host",
    }));
    runner = new ItsaplanChatRunner({
      logger: createTestLogger(),
      projectStore: store,
      getConfig: () => config,
      missionControl: fakeMC.control,
      supervisorIntervalMs: 15,
    });
    runner.start();

    const runId = fakeServer.enqueueAgentRun(commanderAgent.id, "Do something", "", 11, "ENG-11");

    await vi.waitFor(() => {
      expect(fakeServer.getAgentRun(runId)?.result).not.toBeNull();
    });
    expect(fakeServer.getAgentRun(runId)?.result?.status).toBe("failed");
    expect(fakeServer.getAgentRun(runId)?.result?.error).toContain("Commander unreachable");
  });
});
