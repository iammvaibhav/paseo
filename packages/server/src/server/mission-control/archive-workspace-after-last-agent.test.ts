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

describe("MissionControlService archives a workspace after its last agent is archived", () => {
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
      listAll: vi.fn(async () => Array.from(workspaces.values())),
    } as unknown as WorkspaceRegistry;

    const projectRegistry = {
      get: vi.fn(async (projectId: string) => projects.get(projectId) ?? null),
      list: vi.fn(async () => Array.from(projects.values())),
    } as unknown as ProjectRegistry;

    const agentStorage = {
      get: vi.fn(async (agentId: string) => storedRecords.get(agentId) ?? null),
      listAll: vi.fn(async () => Array.from(storedRecords.values())),
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
      workspaceRegistry,
      projectRegistry,
      archiveWorkspace: archiveWorkspaceSpy,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  function addAgent(agentId: string, workspaceId: string | undefined, archivedAt: string | null) {
    storedRecords.set(agentId, createStoredRecord(agentId, { workspaceId, archivedAt }));
    if (!archivedAt) liveAgents.set(agentId, createLiveAgent(agentId, { workspaceId }));
  }

  function addWorkspace(workspaceId: string, archivedAt: string | null = null) {
    workspaces.set(workspaceId, { workspaceId, cwd: `/tmp/repo/${workspaceId}`, archivedAt });
  }

  test("marking the only agent Done leaves its workspace alone", async () => {
    addWorkspace("ws-done");
    addAgent("agent-done", "ws-done", null);

    expect(await service.setLifecycle({ agentId: "agent-done", action: "done" })).toEqual({
      ok: true,
    });
    await service.setReviewState("agent-done", "done", {
      verdict: { by: "verifier", summary: "Verified done", at: new Date().toISOString() },
    });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("clearing (archiving) the last active agent archives its workspace", async () => {
    addWorkspace("ws-last");
    addAgent("agent-last", "ws-last", null);
    addAgent("agent-old", "ws-last", "2026-01-01T12:00:00.000Z");

    expect(await service.setLifecycle({ agentId: "agent-last", action: "clear" })).toEqual({
      ok: true,
    });

    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceSpy).toHaveBeenCalledWith(
      "ws-last",
      expect.stringContaining("archive-workspace-last-agent-agent-last"),
    );
  });

  test("archiving an agent keeps the workspace while another agent is still active", async () => {
    addWorkspace("ws-shared");
    addAgent("agent-1", "ws-shared", null);
    addAgent("agent-2", "ws-shared", null);

    await service.setLifecycle({ agentId: "agent-1", action: "clear" });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("a repeated last-agent check archives the workspace once", async () => {
    addWorkspace("ws-direct");
    addAgent("agent-direct", "ws-direct", "2026-01-02T00:00:00.000Z");

    await service.archiveWorkspaceIfLastAgentArchived("agent-direct");
    await service.archiveWorkspaceIfLastAgentArchived("agent-direct");

    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
  });

  test("does nothing for an agent that is not archived", async () => {
    addWorkspace("ws-live");
    addAgent("agent-live", "ws-live", null);

    await service.archiveWorkspaceIfLastAgentArchived("agent-live");

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("never archives a project's base workspace", async () => {
    addWorkspace("ws-base");
    projects.set("prj-1", { projectId: "prj-1", baseWorkspaceId: "ws-base", archivedAt: null });
    addAgent("agent-base", "ws-base", null);

    await service.setLifecycle({ agentId: "agent-base", action: "clear" });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("skips a workspace that is already archived, and an agent with no workspace", async () => {
    addWorkspace("ws-gone", "2026-01-01T00:00:00.000Z");
    addAgent("agent-in-gone", "ws-gone", null);
    addAgent("agent-nowhere", undefined, null);

    await service.setLifecycle({ agentId: "agent-in-gone", action: "clear" });
    await service.setLifecycle({ agentId: "agent-nowhere", action: "clear" });

    expect(archiveWorkspaceSpy).not.toHaveBeenCalled();
  });

  test("a failing workspace archive does not fail the agent's Clear", async () => {
    addWorkspace("ws-failing");
    addAgent("agent-failing", "ws-failing", null);
    archiveWorkspaceSpy.mockRejectedValueOnce(new Error("Git worktree lock error"));

    expect(await service.setLifecycle({ agentId: "agent-failing", action: "clear" })).toEqual({
      ok: true,
    });
    expect(archiveWorkspaceSpy).toHaveBeenCalledTimes(1);
  });
});
