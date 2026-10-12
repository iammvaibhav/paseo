import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { FleetAgentWaitResult } from "./fleet-wait.js";

const LOCAL_AGENT_ID = "5f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6a";
const OTHER_AGENT_ID = "6f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6b";
const PEER_AGENT_ID = "7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d";

interface LocalAgentState {
  lifecycle: "running" | "idle";
  activeTurnId: string | null;
}

/**
 * Live local agents whose timelines hold finished turns, plus a controllable
 * waitForAgentEvent. Agents not in `agents` are unknown locally.
 */
function createHarness(input: {
  agents?: Record<string, LocalAgentState>;
  turns?: Record<string, Array<{ turnId: string; item: AgentTimelineItem }>>;
  waitForAgentEvent?: AgentManager["waitForAgentEvent"];
  peerClient?: Partial<DaemonClient>;
}) {
  const store = new InMemoryAgentTimelineStore();
  for (const [agentId, rows] of Object.entries(input.turns ?? {})) {
    store.initialize(agentId);
    for (const row of rows) store.append(agentId, row.item, { turnId: row.turnId });
  }
  const agents = input.agents ?? {};
  const agentManager = {
    getAgent: (id: string) =>
      agents[id]
        ? { id, cwd: "/work", ...agents[id], activeForegroundTurnId: agents[id]!.activeTurnId }
        : null,
    listAgents: () => Object.keys(agents).map((id) => ({ id, name: id })),
    hasTimeline: (id: string) => store.has(id),
    fetchTimeline: (id: string, options: Parameters<InMemoryAgentTimelineStore["fetch"]>[1]) =>
      store.fetch(id, options),
    waitForAgentEvent:
      input.waitForAgentEvent ??
      vi.fn(async () => ({ status: "idle", permission: null, lastMessage: "done" })),
  } as unknown as AgentManager;
  const agentStorage = {
    get: async (id: string) => (agents[id] ? { id, title: `title ${id}` } : null),
    list: async () => [],
  } as unknown as AgentStorage;
  const client = {
    fetchAgents: vi.fn(async () => ({ entries: [] })),
    ...input.peerClient,
  } as unknown as DaemonClient;
  const peerManager = {
    getPeerStatus: (name: string) =>
      name === "macbook" ? { name, state: "online", lastSeenAt: null } : null,
    getPeerStatuses: () => [{ name: "macbook", state: "online", lastSeenAt: null, url: "ws://m" }],
    getPeerClient: (name: string) => (name === "macbook" ? client : null),
  } as unknown as PeerManager;
  const catalog = createPaseoToolCatalog({
    agentManager,
    agentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager,
    logger: createTestLogger(),
  });
  return { catalog, agentManager };
}

const waitResult = (fields: Partial<FleetAgentWaitResult>): FleetAgentWaitResult => ({
  ok: true,
  host: "local",
  agentId: PEER_AGENT_ID,
  status: "idle",
  finished: true,
  needsPermission: false,
  timedOut: false,
  turnId: null,
  title: null,
  bucket: null,
  lastMessage: null,
  error: null,
  ...fields,
});

const finishedTurn = (turnId: string, answer: string) => [
  { turnId, item: { type: "user_message", text: `ask ${turnId}` } as AgentTimelineItem },
  { turnId, item: { type: "assistant_message", text: answer } as AgentTimelineItem },
];

describe("fleet_wait_agent turn binding (local)", () => {
  test("a finished turn returns its own outcome at once, never the agent's latest run", async () => {
    const waitForAgentEvent = vi.fn();
    const { catalog } = createHarness({
      agents: { [LOCAL_AGENT_ID]: { lifecycle: "running", activeTurnId: "turn-3" } },
      turns: {
        [LOCAL_AGENT_ID]: [...finishedTurn("turn-1", "first"), ...finishedTurn("turn-2", "second")],
      },
      waitForAgentEvent,
    });

    const result = await catalog.executeTool("fleet_wait_agent", {
      agentId: LOCAL_AGENT_ID,
      turnId: "turn-1",
    });

    expect(waitForAgentEvent).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      status: "idle",
      finished: true,
      turnId: "turn-1",
      lastMessage: "first",
    });
  });

  test("a turn the agent has not started is pending, not finished", async () => {
    const { catalog } = createHarness({
      agents: { [LOCAL_AGENT_ID]: { lifecycle: "idle", activeTurnId: null } },
      turns: { [LOCAL_AGENT_ID]: finishedTurn("turn-1", "old answer") },
    });

    const result = await catalog.executeTool("fleet_wait_agent", {
      agentId: LOCAL_AGENT_ID,
      turnId: "turn-9",
    });

    expect(result.structuredContent).toMatchObject({
      status: "pending",
      finished: false,
      turnId: "turn-9",
      lastMessage: null,
    });
  });

  test("the active turn is waited on and reported by id", async () => {
    const waitForAgentEvent = vi.fn(async () => ({
      status: "idle" as const,
      permission: null,
      lastMessage: "new answer",
    }));
    const { catalog } = createHarness({
      agents: { [LOCAL_AGENT_ID]: { lifecycle: "running", activeTurnId: "turn-2" } },
      turns: { [LOCAL_AGENT_ID]: finishedTurn("turn-1", "old answer") },
      waitForAgentEvent,
    });

    const result = await catalog.executeTool("fleet_wait_agent", {
      agentId: LOCAL_AGENT_ID,
      turnId: "turn-2",
    });

    expect(waitForAgentEvent).toHaveBeenCalledWith(
      LOCAL_AGENT_ID,
      expect.objectContaining({ waitForActive: true }),
    );
    expect(result.structuredContent).toMatchObject({
      finished: true,
      turnId: "turn-2",
      lastMessage: "new answer",
    });
  });

  test("a permission block returns early, not finished", async () => {
    const { catalog } = createHarness({
      agents: { [LOCAL_AGENT_ID]: { lifecycle: "running", activeTurnId: "turn-2" } },
      waitForAgentEvent: vi.fn(async () => ({
        status: "running" as const,
        permission: { id: "perm-1" } as never,
        lastMessage: null,
      })),
    });

    const result = await catalog.executeTool("fleet_wait_agent", { agentId: LOCAL_AGENT_ID });

    expect(result.structuredContent).toMatchObject({
      status: "permission",
      finished: false,
      needsPermission: true,
      turnId: "turn-2",
    });
  });

  test("rejects a timeout above the 1800 s cap", async () => {
    const { catalog } = createHarness({});
    await expect(
      catalog.executeTool("fleet_wait_agent", { agentId: PEER_AGENT_ID, timeoutSeconds: 1801 }),
    ).rejects.toThrow();
  });
});

describe("fleet_wait_agent on a peer", () => {
  test("runs the wait on the peer in chunks, binding later chunks to the first chunk's turn", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const missionControlToolsExecute = vi.fn(
      async (input: { name: string; args?: Record<string, unknown> }) => {
        calls.push(input.args ?? {});
        const structuredContent =
          calls.length < 3
            ? waitResult({ status: "running", finished: false, timedOut: true, turnId: "p-1" })
            : waitResult({ turnId: "p-1", lastMessage: "done remotely" });
        return { ok: true, name: input.name, structuredContent };
      },
    );
    const { catalog } = createHarness({ peerClient: { missionControlToolsExecute } as never });

    const result = await catalog.executeTool("fleet_wait_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
      timeoutSeconds: 200,
    });

    expect(missionControlToolsExecute.mock.calls[0]![0]).toMatchObject({
      name: "fleet_wait_agent",
      args: { agentId: PEER_AGENT_ID, host: "local", timeoutSeconds: 45 },
    });
    expect(calls.map((args) => args.turnId)).toEqual([undefined, "p-1", "p-1"]);
    expect(result.structuredContent).toMatchObject({
      host: "macbook",
      finished: true,
      turnId: "p-1",
      lastMessage: "done remotely",
    });
  });

  test("falls back to wait_for_finish on a peer that predates turn-bound waits", async () => {
    const waitForFinish = vi.fn(async () => ({
      status: "idle" as const,
      final: { title: "Remote job", bucket: "ready", status: "idle" } as never,
      error: null,
      lastMessage: "done remotely",
    }));
    const missionControlToolsExecute = vi.fn(async () => ({
      ok: false,
      name: "fleet_wait_agent",
      error: 'Tool "fleet_wait_agent" is not on the Commander allowlist',
    }));
    const { catalog } = createHarness({
      peerClient: { waitForFinish, missionControlToolsExecute } as never,
    });

    const result = await catalog.executeTool("fleet_wait_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
      timeoutSeconds: 120,
    });

    expect(waitForFinish).toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      host: "macbook",
      finished: true,
      title: "Remote job",
      lastMessage: "done remotely",
      turnId: null,
    });
  });
});

/** A run that never ends on its own: rejects only when the wait is aborted. */
function runUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  signal?.addEventListener("abort", () => reject(new Error("aborted")));
  return promise;
}

describe("fleet_wait_agents", () => {
  test("any: returns when the first agent finishes; the other reports its running state", async () => {
    const waitForAgentEvent = vi.fn(async (agentId: string, options?: { signal?: AbortSignal }) =>
      agentId === LOCAL_AGENT_ID
        ? { status: "idle" as const, permission: null, lastMessage: "first done" }
        : runUntilAborted(options?.signal),
    );
    const { catalog } = createHarness({
      agents: {
        [LOCAL_AGENT_ID]: { lifecycle: "running", activeTurnId: "a-1" },
        [OTHER_AGENT_ID]: { lifecycle: "running", activeTurnId: "b-1" },
      },
      waitForAgentEvent: waitForAgentEvent as never,
    });

    const result = await catalog.executeTool("fleet_wait_agents", {
      agentIds: [LOCAL_AGENT_ID, OTHER_AGENT_ID],
      mode: "any",
      timeoutSeconds: 60,
    });

    expect(result.structuredContent).toMatchObject({
      mode: "any",
      done: true,
      timedOut: false,
      results: [
        { agentId: LOCAL_AGENT_ID, finished: true, turnId: "a-1", lastMessage: "first done" },
        { agentId: OTHER_AGENT_ID, finished: false, timedOut: false, turnId: "b-1" },
      ],
    });
  });

  test("all: returns once every agent finished, each bound to its own turn", async () => {
    const { catalog } = createHarness({
      agents: {
        [LOCAL_AGENT_ID]: { lifecycle: "running", activeTurnId: "a-1" },
        [OTHER_AGENT_ID]: { lifecycle: "idle", activeTurnId: null },
      },
      turns: { [OTHER_AGENT_ID]: finishedTurn("b-0", "earlier") },
    });

    const result = await catalog.executeTool("fleet_wait_agents", {
      agents: [{ agentId: LOCAL_AGENT_ID }, { agentId: OTHER_AGENT_ID, turnId: "b-0" }],
      mode: "all",
    });

    expect(result.structuredContent).toMatchObject({
      done: true,
      results: [
        { agentId: LOCAL_AGENT_ID, finished: true, turnId: "a-1" },
        { agentId: OTHER_AGENT_ID, finished: true, turnId: "b-0", lastMessage: "earlier" },
      ],
    });
  });

  test("all: a timeout returns partial results", async () => {
    const waitForAgentEvent = vi.fn(async (_agentId: string, options?: { signal?: AbortSignal }) =>
      runUntilAborted(options?.signal),
    );
    const { catalog } = createHarness({
      agents: { [LOCAL_AGENT_ID]: { lifecycle: "running", activeTurnId: "a-1" } },
      waitForAgentEvent: waitForAgentEvent as never,
    });

    const result = await catalog.executeTool("fleet_wait_agents", {
      agentIds: [LOCAL_AGENT_ID],
      mode: "all",
      timeoutSeconds: 1,
    });

    expect(result.structuredContent).toMatchObject({
      done: false,
      timedOut: true,
      results: [{ agentId: LOCAL_AGENT_ID, finished: false, timedOut: true, turnId: "a-1" }],
    });
  });
});
