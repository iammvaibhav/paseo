import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const LOCAL_AGENT_ID = "5f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6a";
const PEER_AGENT_ID = "7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d";

function createFakePeerHarness(
  overrides: {
    client?: Partial<DaemonClient>;
    statuses?: Array<{ name: string; state: "online" | "unreachable"; lastSeenAt: string | null }>;
  } = {},
) {
  const statuses = overrides.statuses ?? [
    { name: "macbook", state: "online" as const, lastSeenAt: null },
  ];
  const client = {
    cancelAgent: vi.fn(async () => undefined),
    deleteAgent: vi.fn(async () => undefined),
    setAgentMode: vi.fn(async () => null),
    setAgentModel: vi.fn(async () => undefined),
    setAgentThinkingOption: vi.fn(async () => null),
    setAgentFeature: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => undefined),
    fetchAgents: vi.fn(async () => ({ entries: [] })),
    fetchAgentTimeline: vi.fn(async () => ({ entries: [], error: null })),
    ...overrides.client,
  } as unknown as DaemonClient;

  const peerManager = {
    getPeerStatus: (name: string) => statuses.find((s) => s.name === name) ?? null,
    getPeerStatuses: () =>
      statuses.map((s) => Object.assign({}, s, { name: s.name, url: `ws://${s.name}` })),
    getPeerClient: (name: string) => (name === "macbook" ? client : null),
  } as unknown as PeerManager;

  return { client, peerManager };
}

function createCatalog(
  peerManager: PeerManager,
  agentManager?: AgentManager,
  hostIdentity: { serverId?: string; hostAlias?: string | null } = {},
  agentStorage?: AgentStorage,
) {
  return createPaseoToolCatalog({
    agentManager: agentManager ?? ({} as unknown as AgentManager),
    agentStorage:
      agentStorage ??
      ({
        get: async () => null,
        list: async () => [],
      } as unknown as AgentStorage),
    providerSnapshotManager: createProviderSnapshotManagerStub()
      .manager as unknown as ProviderSnapshotManager,
    peerManager,
    serverId: hostIdentity.serverId,
    hostAlias: hostIdentity.hostAlias,
    logger: createTestLogger(),
  });
}

describe("fleet_cancel_agent", () => {
  test("cancels a running local agent via cancelAgentRunCommand", async () => {
    const { peerManager } = createFakePeerHarness();
    const cancelAgentRun = vi.fn(async () => ({ status: "settled" as const }));
    const agentManager = {
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle: "running" as const } : null,
      hasInFlightRun: (id: string) => id === LOCAL_AGENT_ID,
      cancelAgentRun,
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "worker" }],
    } as unknown as AgentManager;

    const catalog = createCatalog(peerManager, agentManager);
    const result = await catalog.executeTool("fleet_cancel_agent", {
      agentId: LOCAL_AGENT_ID,
    });

    expect(cancelAgentRun).toHaveBeenCalledWith(LOCAL_AGENT_ID);
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "local",
      agentId: LOCAL_AGENT_ID,
      cancelled: true,
    });
  });

  test("returns cancelled: false with guidance when local agent is not running", async () => {
    const { peerManager } = createFakePeerHarness();
    const cancelAgentRun = vi.fn();
    const agentManager = {
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle: "idle" as const } : null,
      hasInFlightRun: () => false,
      cancelAgentRun,
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "idle-worker" }],
    } as unknown as AgentManager;

    const catalog = createCatalog(peerManager, agentManager);
    const result = await catalog.executeTool("fleet_cancel_agent", {
      host: "local",
      agentId: LOCAL_AGENT_ID,
    });

    expect(cancelAgentRun).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "local",
      agentId: LOCAL_AGENT_ID,
      cancelled: false,
      guidance: "Agent was not running",
    });
  });

  test("proxies cancel to peer host via client.cancelAgent RPC", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_cancel_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });

    expect(client.cancelAgent).toHaveBeenCalledWith(PEER_AGENT_ID);
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
  });

  test("returns ok: false and guidance when host hint mismatches owning host", async () => {
    const { peerManager } = createFakePeerHarness();
    const agentManager = {
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle: "running" as const } : null,
      hasInFlightRun: () => true,
      cancelAgentRun: vi.fn(),
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "worker" }],
    } as unknown as AgentManager;

    const catalog = createCatalog(peerManager, agentManager);
    const result = await catalog.executeTool("fleet_cancel_agent", {
      host: "macbook",
      agentId: LOCAL_AGENT_ID,
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      host: "local",
      agentId: LOCAL_AGENT_ID,
      error: expect.stringContaining(
        'Agent "' + LOCAL_AGENT_ID + '" is on host "local", not "macbook"',
      ),
      guidance: expect.stringContaining("Target host"),
    });
  });

  test("returns ok: false and guidance when agent is unknown across fleet", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_cancel_agent", {
      agentId: "unknown-agent-id",
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      host: "unknown",
      agentId: "unknown-agent-id",
      error: expect.stringContaining("not found on any reachable host"),
      guidance: expect.any(String),
    });
  });
});

describe("fleet_kill_agent", () => {
  test("terminates local agent via closeAgentCommand", async () => {
    const { peerManager } = createFakePeerHarness();
    const closeAgent = vi.fn(async () => undefined);
    const agentManager = {
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle: "idle" as const } : null,
      closeAgent,
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "worker" }],
    } as unknown as AgentManager;

    const catalog = createCatalog(peerManager, agentManager);
    const result = await catalog.executeTool("fleet_kill_agent", {
      agentId: LOCAL_AGENT_ID,
    });

    expect(closeAgent).toHaveBeenCalledWith(LOCAL_AGENT_ID);
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "local",
      agentId: LOCAL_AGENT_ID,
    });
  });

  test("proxies kill to peer host via client.deleteAgent RPC", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_kill_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });

    expect(client.deleteAgent).toHaveBeenCalledWith(PEER_AGENT_ID);
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
  });

  test("returns ok: false with guidance when peer is unreachable", async () => {
    const { peerManager } = createFakePeerHarness({
      statuses: [{ name: "macbook", state: "unreachable", lastSeenAt: "2026-08-08T00:00:00.000Z" }],
    });
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_kill_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      host: "macbook",
      agentId: PEER_AGENT_ID,
      error: expect.stringContaining("unreachable"),
      guidance: expect.stringContaining("fleet_list_inventory"),
    });
  });
});

describe("fleet_update_agent", () => {
  test("updates mode, model, thinking, features, title and labels on local agent", async () => {
    const { peerManager } = createFakePeerHarness();
    const setAgentMode = vi.fn(async () => null);
    const setAgentModel = vi.fn(async () => undefined);
    const setAgentThinkingOption = vi.fn(async () => null);
    const setAgentFeature = vi.fn(async () => undefined);
    const updateAgentMetadata = vi.fn(async () => undefined);

    const agentManager = {
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle: "idle" as const } : null,
      setAgentMode,
      setAgentModel,
      setAgentThinkingOption,
      setAgentFeature,
      updateAgentMetadata,
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "worker" }],
    } as unknown as AgentManager;

    const catalog = createCatalog(peerManager, agentManager);
    const result = await catalog.executeTool("fleet_update_agent", {
      agentId: LOCAL_AGENT_ID,
      title: "Worker 2.0",
      labels: { environment: "staging", priority: 1 },
      modeId: "bypassPermissions",
      model: "claude-3-5-sonnet",
      thinkingOptionId: "deep",
      features: { webSearch: true },
    });

    expect(setAgentMode).toHaveBeenCalledWith(LOCAL_AGENT_ID, "bypassPermissions");
    expect(setAgentModel).toHaveBeenCalledWith(LOCAL_AGENT_ID, "claude-3-5-sonnet");
    expect(setAgentThinkingOption).toHaveBeenCalledWith(LOCAL_AGENT_ID, "deep");
    expect(setAgentFeature).toHaveBeenCalledWith(LOCAL_AGENT_ID, "webSearch", true);
    expect(updateAgentMetadata).toHaveBeenCalledWith(LOCAL_AGENT_ID, {
      title: "Worker 2.0",
      labels: { environment: "staging", priority: "1" },
    });
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "local",
      agentId: LOCAL_AGENT_ID,
    });
  });

  test("proxies mode, model, thinking, features, title and labels to peer via DaemonClient RPCs", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_update_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
      title: "Peer Worker",
      labels: { team: "infra" },
      modeId: "plan",
      model: "gpt-4o",
      thinkingOptionId: "off",
      features: { bash: true },
    });

    expect(client.setAgentMode).toHaveBeenCalledWith(PEER_AGENT_ID, "plan");
    expect(client.setAgentModel).toHaveBeenCalledWith(PEER_AGENT_ID, "gpt-4o");
    expect(client.setAgentThinkingOption).toHaveBeenCalledWith(PEER_AGENT_ID, "off");
    expect(client.setAgentFeature).toHaveBeenCalledWith(PEER_AGENT_ID, "bash", true);
    expect(client.updateAgent).toHaveBeenCalledWith(PEER_AGENT_ID, {
      title: "Peer Worker",
      labels: { team: "infra" },
    });
    expect(result.structuredContent).toEqual({
      ok: true,
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
  });

  test("returns ok: false and guidance when no update fields are provided", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_update_agent", {
      agentId: LOCAL_AGENT_ID,
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      agentId: LOCAL_AGENT_ID,
      error: "No updates provided",
      guidance: expect.stringContaining("Provide at least one of"),
    });
  });

  test("returns ok: false and guidance when host is unconfigured peer", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_update_agent", {
      host: "nonexistent-peer",
      agentId: PEER_AGENT_ID,
      modeId: "plan",
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      host: "nonexistent-peer",
      agentId: PEER_AGENT_ID,
      error: expect.stringContaining("not a configured peer"),
      guidance: expect.any(String),
    });
  });
});

describe("non-Commander caller access", () => {
  test("tools are accessible directly without Commander labels and without creating proposals", async () => {
    const { client, peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);

    // Call as an unprivileged / regular agent caller without MISSION_CONTROL labels
    const cancelResult = await catalog.executeTool("fleet_cancel_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
    expect(cancelResult.structuredContent).toEqual({
      ok: true,
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
    expect(client.cancelAgent).toHaveBeenCalledWith(PEER_AGENT_ID);

    const killResult = await catalog.executeTool("fleet_kill_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
    expect(killResult.structuredContent).toEqual({
      ok: true,
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
    expect(client.deleteAgent).toHaveBeenCalledWith(PEER_AGENT_ID);

    const updateResult = await catalog.executeTool("fleet_update_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
      modeId: "code",
    });
    expect(updateResult.structuredContent).toEqual({
      ok: true,
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });
    expect(client.setAgentMode).toHaveBeenCalledWith(PEER_AGENT_ID, "code");
  });
});

describe("fleet_wait_agent", () => {
  const localAgentManager = (
    waitForAgentEvent: AgentManager["waitForAgentEvent"],
    lifecycle: "running" | "idle" = "running",
  ) =>
    ({
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle, lastError: undefined } : null,
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "worker" }],
      waitForAgentEvent,
    }) as unknown as AgentManager;

  const storageWithTitle = {
    get: async (id: string) => (id === LOCAL_AGENT_ID ? { id, title: "Essay writer" } : null),
    list: async () => [],
  } as unknown as AgentStorage;

  test("returns the final state of a local agent once its run ends", async () => {
    const { peerManager } = createFakePeerHarness();
    const waitForAgentEvent = vi.fn(async () => ({
      status: "idle" as const,
      permission: null,
      lastMessage: "Here is the essay.",
    }));
    const catalog = createCatalog(
      peerManager,
      localAgentManager(waitForAgentEvent),
      {},
      storageWithTitle,
    );

    const result = await catalog.executeTool("fleet_wait_agent", { agentId: LOCAL_AGENT_ID });

    expect(waitForAgentEvent).toHaveBeenCalledWith(
      LOCAL_AGENT_ID,
      expect.objectContaining({ waitForActive: true }),
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      host: "local",
      agentId: LOCAL_AGENT_ID,
      status: "idle",
      finished: true,
      needsPermission: false,
      timedOut: false,
      title: "Essay writer",
      lastMessage: "Here is the essay.",
    });
  });

  test("returns early, not finished, when the local agent needs a permission", async () => {
    const { peerManager } = createFakePeerHarness();
    const waitForAgentEvent = vi.fn(async () => ({
      status: "running" as const,
      permission: { id: "perm-1" } as never,
      lastMessage: null,
    }));
    const catalog = createCatalog(peerManager, localAgentManager(waitForAgentEvent));

    const result = await catalog.executeTool("fleet_wait_agent", { agentId: LOCAL_AGENT_ID });

    expect(result.structuredContent).toMatchObject({
      status: "permission",
      finished: false,
      needsPermission: true,
    });
  });

  test("waits on a peer agent through the peer's wait_for_finish RPC", async () => {
    const waitForFinish = vi.fn(async () => ({
      status: "idle" as const,
      final: { title: "Remote job", bucket: "ready", status: "idle" } as never,
      error: null,
      lastMessage: "done remotely",
    }));
    const { peerManager } = createFakePeerHarness({ client: { waitForFinish } });
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_wait_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
      timeoutSeconds: 120,
    });

    expect(waitForFinish).toHaveBeenCalledWith(PEER_AGENT_ID, 120_000);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      host: "macbook",
      status: "idle",
      finished: true,
      timedOut: false,
      title: "Remote job",
      bucket: "ready",
      lastMessage: "done remotely",
    });
  });

  test("reports timedOut when the peer's wait times out", async () => {
    const waitForFinish = vi.fn(async () => ({
      status: "timeout" as const,
      final: { title: "Remote job", bucket: "running", status: "running" } as never,
      error: null,
      lastMessage: null,
    }));
    const { peerManager } = createFakePeerHarness({ client: { waitForFinish } });
    const catalog = createCatalog(peerManager);

    const result = await catalog.executeTool("fleet_wait_agent", {
      host: "macbook",
      agentId: PEER_AGENT_ID,
    });

    expect(waitForFinish).toHaveBeenCalledWith(PEER_AGENT_ID, 600_000);
    expect(result.structuredContent).toMatchObject({
      status: "running",
      finished: false,
      timedOut: true,
    });
  });

  test("rejects a timeout above the 1800 s cap", async () => {
    const { peerManager } = createFakePeerHarness();
    const catalog = createCatalog(peerManager);
    await expect(
      catalog.executeTool("fleet_wait_agent", { agentId: PEER_AGENT_ID, timeoutSeconds: 1801 }),
    ).rejects.toThrow();
  });
});
