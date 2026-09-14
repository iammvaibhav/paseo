import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type pino from "pino";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { WorkspaceRegistry, ProjectRegistry } from "../workspace-registry.js";
import { MissionControlService } from "./service.js";
import { createMissionControlPresenceSource } from "./presence.js";

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, Mock> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

function createLiveAgent(agentId: string, overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp/repo",
    lifecycle: "idle",
    labels: {},
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
    ...overrides,
  } as unknown as ManagedAgent;
}

function createStoredRecord(
  agentId: string,
  overrides: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  return {
    id: agentId,
    name: `Agent ${agentId}`,
    title: `Agent ${agentId} title`,
    provider: "omp",
    cwd: "/tmp/repo",
    status: "idle",
    lastStatus: "idle",
    labels: {},
    internal: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as StoredAgentRecord;
}
function filterRecordsByWorkspace(
  records: Iterable<StoredAgentRecord>,
  workspaceId: string,
): StoredAgentRecord[] {
  const matching: StoredAgentRecord[] = [];
  for (const record of records) {
    if (record.workspaceId === workspaceId) {
      matching.push(record);
    }
  }
  return matching;
}

describe("MissionControlService auto-archive workspace on agent Done (PASEO-21)", () => {
  let dir: string;
  let service: MissionControlService;
  let archiveWorkspaceSpy: Mock;
  let storedRecords: Map<string, StoredAgentRecord>;
  let liveAgents: Map<string, ManagedAgent>;
  let workspaces: Map<string, { workspaceId: string; cwd: string; archivedAt?: string | null }>;
  let projects: Map<
    string,
    { projectId: string; baseWorkspaceId: string; archivedAt?: string | null }
  >;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-auto-archive-test-"));
    archiveWorkspaceSpy = vi.fn(async (workspaceId: string) => {
      const ws = workspaces.get(workspaceId);
      if (ws) {
        workspaces.set(workspaceId, { ...ws, archivedAt: new Date().toISOString() });
      }
    });
    storedRecords = new Map();
    liveAgents = new Map();
    workspaces = new Map();
    projects = new Map();

    const workspaceRegistry = {
      get: vi.fn(async (workspaceId: string) => workspaces.get(workspaceId) ?? null),
      list: vi.fn(async () => Array.from(workspaces.values())),
    } as unknown as WorkspaceRegistry;

    const projectRegistry = {
      get: vi.fn(async (projectId: string) => projects.get(projectId) ?? null),
      list: vi.fn(async () => Array.from(projects.values())),
    } as unknown as ProjectRegistry;

    const agentStorage = {
      get: vi.fn(async (agentId: string) => storedRecords.get(agentId) ?? null),
      list: vi.fn(async () => Array.from(storedRecords.values())),
      listByWorkspace: vi.fn(async (workspaceId: string) =>
        filterRecordsByWorkspace(storedRecords.values(), workspaceId),
      ),
      upsert: vi.fn(async (record: StoredAgentRecord) => {
        storedRecords.set(record.id, record);
      }),
    } as unknown as AgentStorage;

    const agentManager = {
      getAgent: vi.fn((agentId: string) => liveAgents.get(agentId) ?? null),
      listAgents: vi.fn(() => Array.from(liveAgents.values())),
      notifyAgentState: vi.fn(),
      updateAgentMetadata: vi.fn(async () => undefined),
      hasInFlightRun: vi.fn(() => false),
      cancelAgentRun: vi.fn(async () => ({ status: "not_running" })),
      clearAgentAttention: vi.fn(async () => undefined),
      archiveAgent: vi.fn(async (agentId: string) => {
        const existing = storedRecords.get(agentId);
        if (existing) {
          storedRecords.set(agentId, { ...existing, archivedAt: new Date().toISOString() });
        }
        liveAgents.delete(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, archivedAt: string) => {
        const existing = storedRecords.get(agentId);
        if (existing) {
          const updated = { ...existing, archivedAt };
          storedRecords.set(agentId, updated);
          return updated;
        }
        return createStoredRecord(agentId, { archivedAt });
      }),
      subscribe: vi.fn(() => () => {}),
    } as unknown as AgentManager;

    service = new MissionControlService({
      paseoHome: dir,
      logger: createMockLogger(),
      agentManager,
      agentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      workspaceRegistry,
      projectRegistry,
      archiveWorkspace: archiveWorkspaceSpy,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("marking an agent as Done archives its workspace when it is the only agent in that workspace", async () => {
    const workspaceId = "ws-single-agent";
    workspaces.set(workspaceId, { workspaceId, cwd: "/tmp/repo/wks1", archivedAt: null });

    const agentId = "agent-single";
    const record = createStoredRecord(agentId, { workspaceId, archivedAt: null });
    storedRecords.set(agentId, record);
    liveAgents.set(agentId, createLiveAgent(agentId, { workspaceId }));

    const result = await service.setLifecycle({ agentId, action: "done" });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceSpy).toHaveBeenCalledWith(
      workspaceId,
      expect.stringContaining("auto-archive-workspace-agent-done-agent-single"),
    );
  });

  test("marking an agent as Done does NOT archive the workspace if other active agents remain in that workspace", async () => {
    const workspaceId = "ws-multi-agent";
    workspaces.set(workspaceId, { workspaceId, cwd: "/tmp/repo/wks2", archivedAt: null });

    const agent1 = "agent-1";
    const agent2 = "agent-2";
    storedRecords.set(agent1, createStoredRecord(agent1, { workspaceId, archivedAt: null }));
    storedRecords.set(agent2, createStoredRecord(agent2, { workspaceId, archivedAt: null }));
    liveAgents.set(agent1, createLiveAgent(agent1, { workspaceId }));
    liveAgents.set(agent2, createLiveAgent(agent2, { workspaceId }));

    const result = await service.setLifecycle({ agentId: agent1, action: "done" });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("marking an agent as Done archives the workspace when other agents in that workspace are already archived", async () => {
    const workspaceId = "ws-with-archived-sibling";
    workspaces.set(workspaceId, { workspaceId, cwd: "/tmp/repo/wks3", archivedAt: null });

    const agentActive = "agent-active";
    const agentArchived = "agent-archived";
    storedRecords.set(
      agentActive,
      createStoredRecord(agentActive, { workspaceId, archivedAt: null }),
    );
    storedRecords.set(
      agentArchived,
      createStoredRecord(agentArchived, { workspaceId, archivedAt: "2026-01-01T12:00:00.000Z" }),
    );
    liveAgents.set(agentActive, createLiveAgent(agentActive, { workspaceId }));

    const result = await service.setLifecycle({ agentId: agentActive, action: "done" });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceSpy).toHaveBeenCalledWith(workspaceId, expect.any(String));
  });

  test("setReviewState with done archives the workspace for a single-agent workspace", async () => {
    const workspaceId = "ws-review-done";
    workspaces.set(workspaceId, { workspaceId, cwd: "/tmp/repo/wks4", archivedAt: null });

    const agentId = "agent-review";
    storedRecords.set(agentId, createStoredRecord(agentId, { workspaceId, archivedAt: null }));

    await service.setReviewState(agentId, "done", {
      verdict: { by: "verifier", summary: "Verified done", at: new Date().toISOString() },
    });

    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceSpy).toHaveBeenCalledWith(workspaceId, expect.any(String));
  });
  test("does NOT archive workspace when setReviewState verdict is aged-out", async () => {
    const workspaceId = "ws-review-aged-out";
    workspaces.set(workspaceId, { workspaceId, cwd: "/tmp/repo/wks-aged-out", archivedAt: null });

    const agentId = "agent-aged-out";
    storedRecords.set(agentId, createStoredRecord(agentId, { workspaceId, archivedAt: null }));

    await service.setReviewState(agentId, "done", {
      verdict: { by: "user", summary: "aged-out", at: new Date().toISOString() },
    });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("does NOT archive base workspace of a project when agent in it is marked Done", async () => {
    const baseWorkspaceId = "ws-project-base";
    workspaces.set(baseWorkspaceId, {
      workspaceId: baseWorkspaceId,
      cwd: "/tmp/repo",
      archivedAt: null,
    });
    projects.set("prj-1", { projectId: "prj-1", baseWorkspaceId, archivedAt: null });

    const agentId = "agent-base";
    storedRecords.set(
      agentId,
      createStoredRecord(agentId, { workspaceId: baseWorkspaceId, archivedAt: null }),
    );

    const result = await service.setLifecycle({ agentId, action: "done" });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("does NOT archive workspace if workspace is already archived", async () => {
    const workspaceId = "ws-already-archived";
    workspaces.set(workspaceId, {
      workspaceId,
      cwd: "/tmp/repo/wks5",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });

    const agentId = "agent-in-archived-ws";
    storedRecords.set(agentId, createStoredRecord(agentId, { workspaceId, archivedAt: null }));

    const result = await service.setLifecycle({ agentId, action: "done" });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("does NOT archive anything if agent has no workspaceId", async () => {
    const agentId = "agent-no-workspace";
    storedRecords.set(
      agentId,
      createStoredRecord(agentId, { workspaceId: undefined, archivedAt: null }),
    );

    const result = await service.setLifecycle({ agentId, action: "done" });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("catches and logs errors if archiveWorkspace throws, without failing setLifecycle", async () => {
    const workspaceId = "ws-failing-archive";
    workspaces.set(workspaceId, { workspaceId, cwd: "/tmp/repo/wks6", archivedAt: null });

    const agentId = "agent-failing";
    storedRecords.set(agentId, createStoredRecord(agentId, { workspaceId, archivedAt: null }));

    archiveWorkspaceSpy.mockRejectedValueOnce(new Error("Git worktree lock error"));

    const result = await service.setLifecycle({ agentId, action: "done" });
    expect(result).toEqual({ ok: true });
    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
  });

  test("archives respective workspaces when multiple single-agent workspaces are marked Done in one batch", async () => {
    const wsA = "ws-batch-a";
    const wsB = "ws-batch-b";
    workspaces.set(wsA, { workspaceId: wsA, cwd: "/tmp/repo/wksA", archivedAt: null });
    workspaces.set(wsB, { workspaceId: wsB, cwd: "/tmp/repo/wksB", archivedAt: null });

    const agentA = "agent-a";
    const agentB = "agent-b";
    storedRecords.set(agentA, createStoredRecord(agentA, { workspaceId: wsA, archivedAt: null }));
    storedRecords.set(agentB, createStoredRecord(agentB, { workspaceId: wsB, archivedAt: null }));

    const result = await service.setLifecycle({
      agentId: agentA,
      agentIds: [agentB],
      action: "done",
    });
    expect(result).toEqual({ ok: true });

    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(2);
    expect(archiveWorkspaceSpy).toHaveBeenCalledWith(wsA, expect.any(String));
    expect(archiveWorkspaceSpy).toHaveBeenCalledWith(wsB, expect.any(String));
  });
});
