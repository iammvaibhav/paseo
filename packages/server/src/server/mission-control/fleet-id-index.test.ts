import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { WorkspaceRegistry, ProjectRegistry } from "../workspace-registry.js";
import type { PeerManager } from "../peers/peer-manager.js";
import { createFleetIdIndex, inferIdKind, formatShortId } from "./fleet-id-index.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
describe("fleet-id-index unit tests", () => {
  test("inferIdKind and formatShortId helper functions", () => {
    expect(inferIdKind("wks_1234567890abcdef")).toBe("workspace");
    expect(inferIdKind("prj_1234567890abcdef")).toBe("project");
    expect(inferIdKind("mcp_01JABCDEF1234567")).toBe("proposal");
    expect(inferIdKind("2b89a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c")).toBe("agent");

    expect(formatShortId("2b89a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c")).toBe("2b89…");
    expect(formatShortId("wks_1234567890abcdef")).toBe("wks_…");
    expect(formatShortId("short")).toBe("short");
  });

  test("resolution order: local registries beat cached peer snapshots", async () => {
    const localAgentId = "2b89a1c2-0000-0000-0000-000000000001";
    const localWorkspaceId = "wks_local_1";
    const localProjectId = "prj_local_1";
    const proposalId = "mcp_01JABCDEF1234567";

    const agentStorage = {
      get: vi.fn(async (id: string) => (id === localAgentId ? { id: localAgentId } : null)),
      list: vi.fn(async () => [{ id: localAgentId }]),
    } as unknown as AgentStorage;

    const workspaceRegistry = {
      get: vi.fn(async (id: string) =>
        id === localWorkspaceId ? { workspaceId: localWorkspaceId } : null,
      ),
      list: vi.fn(async () => [{ workspaceId: localWorkspaceId }]),
    } as unknown as WorkspaceRegistry;

    const projectRegistry = {
      get: vi.fn(async (id: string) =>
        id === localProjectId ? { projectId: localProjectId } : null,
      ),
      list: vi.fn(async () => [{ projectId: localProjectId }]),
    } as unknown as ProjectRegistry;

    const index = createFleetIdIndex({
      agentStorage,
      workspaceRegistry,
      projectRegistry,
      logger: createTestLogger(),
    });

    // Seed peer snapshot containing the duplicate id
    index.recordPeerSnapshot({
      peerName: "peer-host",
      fetchedAt: Date.now(),
      agents: new Set([localAgentId, "peer-agent-1"]),
      workspaces: new Set([localWorkspaceId, "wks_peer_1"]),
      projects: new Set([localProjectId, "prj_peer_1"]),
    });

    // Local beats cached peer
    const agentRes = await index.resolveFleetId(localAgentId);
    expect(agentRes).toEqual({ kind: "agent", host: "local" });

    const wksRes = await index.resolveFleetId(localWorkspaceId);
    expect(wksRes).toEqual({ kind: "workspace", host: "local" });

    const prjRes = await index.resolveFleetId(localProjectId);
    expect(prjRes).toEqual({ kind: "project", host: "local" });

    const propRes = await index.resolveFleetId(proposalId);
    expect(propRes).toEqual({ kind: "proposal", host: "local" });

    // Non-duplicate peer entities resolve to peer
    const peerAgentRes = await index.resolveFleetId("peer-agent-1");
    expect(peerAgentRes).toEqual({ kind: "agent", host: "peer-host" });

    const peerWksRes = await index.resolveFleetId("wks_peer_1");
    expect(peerWksRes).toEqual({ kind: "workspace", host: "peer-host" });

    const peerPrjRes = await index.resolveFleetId("prj_peer_1");
    expect(peerPrjRes).toEqual({ kind: "project", host: "peer-host" });
  });

  test("miss handling: refresh -> found on peer after refresh", async () => {
    const peerAgentId = "2b89a1c2-peer-after-refresh";

    const fleetContext = vi.fn(async () => {
      return {
        hosts: [
          {
            hostName: "blrofc3",
            serverId: "srv-blrofc3",
            machineName: null,
            alias: null,
            reachable: true,
            lastSeenAt: null,
            inventory: { projects: [] },
            models: {},
            recentAgents: [{ agentId: peerAgentId, hostServerId: "srv-blrofc3" }],
          },
        ],
        defaultHost: null,
      };
    });

    const index = createFleetIdIndex({
      fleetContext,
      logger: createTestLogger(),
    });

    const res = await index.resolveFleetId(peerAgentId);
    expect(fleetContext).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ kind: "agent", host: "blrofc3" });
  });

  test("miss handling: refresh -> unknown guidance naming unreachable hosts", async () => {
    const unknownAgentId = "2b89a1c2-unknown-agent";
    const peerManager = {
      getPeerStatuses: () => [
        { name: "macbook", state: "online" as const, lastSeenAt: null },
        { name: "blrofc3", state: "unreachable" as const, lastSeenAt: "2026-08-16T12:00:00Z" },
      ],
      getPeerClient: () => null,
    } as unknown as PeerManager;

    const fleetContext = vi.fn(async () => ({
      hosts: [],
      defaultHost: null,
    }));

    const index = createFleetIdIndex({
      peerManager,
      fleetContext,
      logger: createTestLogger(),
    });

    const res = await index.resolveFleetId(unknownAgentId);
    expect(res.kind).toBe("unknown");
    if (res.kind === "unknown") {
      expect(res.guidance).toBe(
        "agent 2b89… not found on any reachable host (blrofc3 unreachable — it may live there). Call fleet_list_agents to resolve.",
      );
    }
  });

  test("miss handling: refresh -> unknown guidance when all peers reachable", async () => {
    const unknownWorkspaceId = "wks_missing_123456";
    const peerManager = {
      getPeerStatuses: () => [{ name: "macbook", state: "online" as const, lastSeenAt: null }],
      getPeerClient: () => null,
    } as unknown as PeerManager;

    const fleetContext = vi.fn(async () => ({
      hosts: [],
      defaultHost: null,
    }));

    const index = createFleetIdIndex({
      peerManager,
      fleetContext,
      logger: createTestLogger(),
    });

    const res = await index.resolveFleetId(unknownWorkspaceId);
    expect(res.kind).toBe("unknown");
    if (res.kind === "unknown") {
      expect(res.guidance).toBe(
        "workspace wks_… not found on any reachable host. Call fleet_list_inventory to resolve.",
      );
    }
  });
});

describe("fleet tools with fleet-id-index integration", () => {
  function createCatalogHarness(
    options: {
      localAgents?: string[];
      localWorkspaces?: string[];
      peerEntities?: {
        peerName: string;
        agents?: string[];
        workspaces?: string[];
      };
      unreachablePeers?: string[];
    } = {},
  ) {
    const localAgents = options.localAgents ?? ["local-agent-1"];
    const localWorkspaces = options.localWorkspaces ?? ["wks_local_1"];
    const peerName = options.peerEntities?.peerName ?? "macbook";
    const peerAgents = options.peerEntities?.agents ?? ["peer-agent-1"];
    const peerWorkspaces = options.peerEntities?.workspaces ?? ["wks_peer_1"];
    const unreachablePeers = options.unreachablePeers ?? [];

    const agentStorage = {
      get: vi.fn(async (id: string) => (localAgents.includes(id) ? { id } : null)),
      list: vi.fn(async () => localAgents.map((id) => ({ id }))),
    } as unknown as AgentStorage;

    const agentManager = {
      getAgent: vi.fn((id: string) =>
        localAgents.includes(id)
          ? ({
              id,
              lifecycle: "idle",
              pendingPermissions: new Map(),
            } as unknown as import("../agent/agent-manager.js").ManagedAgent)
          : null,
      ),
      listAgents: vi.fn(() =>
        localAgents.map(
          (id) =>
            ({
              id,
              lifecycle: "idle",
              pendingPermissions: new Map(),
            }) as unknown as import("../agent/agent-manager.js").ManagedAgent,
        ),
      ),
      sendPromptToAgent: vi.fn(async () => undefined),
      hasInFlightRun: vi.fn(() => false),
      expectPromptClassification: vi.fn(),
      tryRunOutOfBand: vi.fn(() => false),
      streamAgent: vi.fn(() => (async function* () {})()),
      replaceAgentRun: vi.fn(async () => (async function* () {})()),
      loadAgent: vi.fn(async () => ({
        id: localAgents[0],
        lifecycle: "idle",
        pendingPermissions: new Map(),
      })),
      startAgentRun: vi.fn(async () => ({ status: "started" })),
    } as unknown as AgentManager;

    const workspaceRegistry = {
      get: vi.fn(async (id: string) => (localWorkspaces.includes(id) ? { workspaceId: id } : null)),
      list: vi.fn(async () =>
        localWorkspaces.map((id) => ({
          workspaceId: id,
          projectId: "prj_1",
          cwd: "/cwd",
          kind: "directory",
          displayName: "WS",
        })),
      ),
    } as unknown as WorkspaceRegistry;

    const client = {
      fetchAgentTimeline: vi.fn(async () => ({
        requestId: "req-1",
        agentId: peerAgents[0],
        agent: { id: peerAgents[0], currentModeId: "auto" },
        direction: "tail",
        projection: "projected",
        epoch: "e1",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
        startCursor: null,
        endCursor: null,
        hasOlder: false,
        hasNewer: false,
        mergeWindow: false,
        entries: [
          {
            provider: "omp",
            item: { type: "assistant_message", text: "Peer activity timeline" },
            timestamp: "2026-08-16T00:00:00.000Z",
            seqStart: 0,
            seqEnd: 0,
            sourceSeqRanges: [],
            collapsed: [],
          },
        ],
        error: null,
      })),
      sendAgentMessage: vi.fn(async () => undefined),
      createAgent: vi.fn(async () => ({
        id: "new-peer-agent",
        provider: "codex",
        status: "idle",
        cwd: "/cwd",
        workspaceId: peerWorkspaces[0],
        currentModeId: "auto",
        availableModes: [],
        pendingPermissions: [],
      })),
      fetchWorkspaces: vi.fn(async () => ({
        entries: peerWorkspaces.map((id) => ({
          id,
          title: "Peer Workspace",
          name: "Peer Workspace",
          projectDisplayName: "Peer Project",
        })),
      })),
      missionControlContextRecords: vi.fn(async () => ({
        ok: true,
        runRecords: [{ id: "mcr_1", agentId: peerAgents[0], outcome: "success" }],
      })),
    } as unknown as DaemonClient;

    const statuses = [
      { name: peerName, state: "online" as const, lastSeenAt: null },
      ...unreachablePeers.map((name) => ({
        name,
        state: "unreachable" as const,
        lastSeenAt: "2026-08-16T00:00:00Z",
      })),
    ];

    const peerManager = {
      getPeerStatus: (name: string) => statuses.find((s) => s.name === name) ?? null,
      getPeerStatuses: () =>
        statuses.map((s) => ({
          name: s.name,
          state: s.state,
          url: `ws://${s.name}`,
          lastSeenAt: s.lastSeenAt,
        })),
      getPeerClient: (name: string) => (name === peerName ? client : null),
    } as unknown as PeerManager;

    const fleetIdIndex = createFleetIdIndex({
      agentStorage,
      agentManager,
      workspaceRegistry,
      peerManager,
      logger: createTestLogger(),
    });

    // Record peer snapshot
    fleetIdIndex.recordPeerSnapshot({
      peerName,
      fetchedAt: Date.now(),
      agents: new Set(peerAgents),
      workspaces: new Set(peerWorkspaces),
      projects: new Set(["prj_peer_1"]),
    });

    const catalog = createPaseoToolCatalog({
      agentManager,
      agentStorage,
      workspaceRegistry,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      peerManager,
      fleetIdIndex,
      logger: createTestLogger(),
    });

    return {
      catalog,
      client,
      agentManager,
      peerName,
      peerAgents,
      localAgents,
      localWorkspaces,
      peerWorkspaces,
    };
  }

  test("fleet_send_prompt callable without host against local agent", async () => {
    const { catalog } = createCatalogHarness({
      localAgents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01"],
    });

    const result = await catalog.executeTool("fleet_send_prompt", {
      agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01",
      prompt: "Continue the task",
    });

    expect(result.structuredContent).toMatchObject({
      success: true,
      deliveryMode: expect.any(String),
    });
  });

  test("fleet_send_prompt callable without host against peer agent", async () => {
    const { catalog, client } = createCatalogHarness({
      peerEntities: { peerName: "macbook", agents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02"] },
    });

    const result = await catalog.executeTool("fleet_send_prompt", {
      agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
      prompt: "Peer task update",
    });

    expect(client.sendAgentMessage).toHaveBeenCalledWith(
      "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
      "Peer task update",
      expect.objectContaining({ dispatchMode: "interrupt" }),
    );
    expect(result.structuredContent).toMatchObject({
      success: true,
      deliveryMode: "interrupt",
    });
  });

  test("fleet_send_prompt host-hint mismatch throws helpful error naming actual host", async () => {
    const { catalog } = createCatalogHarness({
      localAgents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01"],
      peerEntities: { peerName: "macbook", agents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02"] },
    });

    // User claims 7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01 is on macbook
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "macbook",
        agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01",
        prompt: "Hello",
      }),
    ).rejects.toThrow(
      'Agent "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01" is on host "local", not "macbook"',
    );

    // User claims 7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02 is on local
    await expect(
      catalog.executeTool("fleet_send_prompt", {
        host: "local",
        agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
        prompt: "Hello",
      }),
    ).rejects.toThrow(
      'Agent "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02" is on host "macbook", not "local"',
    );
  });

  test("fleet_get_agent_activity callable without host against local and peer agents", async () => {
    const { catalog, client } = createCatalogHarness({
      localAgents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01"],
      peerEntities: { peerName: "macbook", agents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02"] },
    });

    // Peer without host
    const peerResult = await catalog.executeTool("fleet_get_agent_activity", {
      agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
    });
    expect(client.fetchAgentTimeline).toHaveBeenCalledWith(
      "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
      expect.any(Object),
    );
    expect(peerResult.structuredContent).toMatchObject({
      agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
      content: expect.stringContaining("Peer activity timeline"),
    });

    // Host hint mismatch
    await expect(
      catalog.executeTool("fleet_get_agent_activity", {
        host: "macbook",
        agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01",
      }),
    ).rejects.toThrow(
      'Agent "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f01" is on host "local", not "macbook"',
    );
  });

  test("fleet_create_agent: workspaceId present derives host, omitted workspaceId requires host", async () => {
    const { catalog, client } = createCatalogHarness({
      localWorkspaces: ["wks_local_test"],
      peerEntities: { peerName: "macbook", workspaces: ["wks_peer_test"] },
    });

    // Workspace on peer -> host derived automatically as macbook
    const peerSpawn = await catalog.executeTool("fleet_create_agent", {
      title: "Peer task agent",
      workspaceId: "wks_peer_test",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work in peer workspace",
    });
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "wks_peer_test" }),
    );
    expect(peerSpawn.structuredContent).toMatchObject({
      agentId: "new-peer-agent",
      workspaceId: "wks_peer_test",
    });

    // Host mismatch with workspace
    await expect(
      catalog.executeTool("fleet_create_agent", {
        title: "Mismatch test agent",
        host: "local",
        workspaceId: "wks_peer_test",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow('Workspace "wks_peer_test" is on host "macbook", not "local"');

    // No workspaceId and no host -> requires host
    await expect(
      catalog.executeTool("fleet_create_agent", {
        title: "Unplaced agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "New agent without placement",
      }),
    ).rejects.toThrow(/host is required when workspaceId is omitted/);
  });

  test("fleet_context routes via index to peer when targetId lives on peer", async () => {
    const { catalog, client } = createCatalogHarness({
      peerEntities: { peerName: "macbook", agents: ["7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02"] },
    });

    const result = await catalog.executeTool("fleet_context", {
      agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
    });
    expect(client.missionControlContextRecords).toHaveBeenCalledWith({
      agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02",
    });
    expect(result.structuredContent).toMatchObject({
      runRecords: expect.arrayContaining([
        expect.objectContaining({ id: "mcr_1", agentId: "7c3a0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f02" }),
      ]),
    });
  });
});

describe("in-process daemon integration tests", () => {
  test("fleet_send_prompt and fleet_get_agent_activity callable without host against a local agent", async () => {
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

      // Create local agent. The agent registers in the live manager
      // synchronously, but the persisted agent store load can lag a
      // freshly-created record — the index's local lookup may briefly miss
      // and return "not found on any reachable host". Retry briefly so the
      // assertion observes the settled state, not the registration race.
      const agent = await client.createAgent({
        provider: "claude",
        cwd: tmpdir(),
        title: "Local Daemon Agent",
      });

      let sendResult: { ok: boolean; error?: string } | null = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        const result = await client.missionControlToolsExecute({
          name: "fleet_send_prompt",
          args: {
            agentId: agent.id,
            prompt: "Hello from test",
          },
        });
        if (result.ok) {
          sendResult = result;
          break;
        }
        // Real delay required: this integration test drives a separate
        // in-process daemon whose agent-store registration is genuinely
        // asynchronous — deterministic fake timers cannot advance another
        // process's event loop.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
      }
      expect(sendResult?.ok, `sendResult error: ${sendResult?.error}`).toBe(true);

      // Execute fleet_get_agent_activity without host
      const activityResult = await client.missionControlToolsExecute({
        name: "fleet_get_agent_activity",
        args: {
          agentId: agent.id,
        },
      });
      expect(activityResult.ok).toBe(true);
      expect(activityResult.structuredContent).toMatchObject({
        agentId: agent.id,
      });
    } finally {
      await client.close();
      await daemon.close();
    }
  });
});
