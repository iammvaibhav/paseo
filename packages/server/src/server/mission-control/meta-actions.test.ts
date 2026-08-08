import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { MissionControlMetaPlan } from "@getpaseo/protocol/mission-control/types";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  applyMetaPlan,
  moveAgentToWorkspace,
  resolveExperimentsProject,
  type MetaActionsDependencies,
} from "./meta-actions.js";

/**
 * M5 meta actions unit tests: move-agent refusals/happy paths, per-action
 * validation refusal paths, and the promote flow against a fake in-memory
 * store (project + workspace registries + agent records).
 */

interface FakeLiveAgent {
  id: string;
  workspaceId?: string;
  lifecycle: "idle" | "running" | "closed" | "error";
  title?: string | null;
  name?: string;
  archivedAt?: string | null;
}

interface Harness {
  projects: Map<string, PersistedProjectRecord>;
  workspaces: Map<string, PersistedWorkspaceRecord>;
  storedAgents: Map<string, StoredAgentRecord>;
  liveAgents: Map<string, FakeLiveAgent>;
  deps: MetaActionsDependencies;
  archivedWorkspaceIds: string[];
  archivedAgentIds: string[];
  emittedStoredUpdates: StoredAgentRecord[];
  moves: Array<{ agentId: string; toWorkspaceId: string }>;
}

function storedAgent(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id: "agent-1",
    cwd: "/work/ws-a",
    workspaceId: "ws-a",
    createdAt: now,
    updatedAt: now,
    title: "Worker A",
    name: "glowing-otter",
    labels: {},
    lastStatus: "closed",
    ...overrides,
  };
}

function workspace(overrides: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  const now = new Date().toISOString();
  return {
    workspaceId: "ws-a",
    projectId: "prj-experiments",
    cwd: "/home/me/experiments/ws-a",
    kind: "directory",
    displayName: "ws-a",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  const now = new Date().toISOString();
  return {
    projectId: "prj-experiments",
    rootPath: "/home/me/experiments",
    kind: "non_git",
    displayName: "experiments",
    projectKey: null,
    customName: null,
    customIconRevision: null,
    description: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  };
}

function build(
  overrides: {
    projects?: PersistedProjectRecord[];
    workspaces?: PersistedWorkspaceRecord[];
    storedAgents?: StoredAgentRecord[];
    liveAgents?: FakeLiveAgent[];
  } = {},
): Harness {
  const harness: Harness = {
    projects: new Map(
      (overrides.projects ?? [project()]).map((record) => [record.projectId, record]),
    ),
    workspaces: new Map(
      (overrides.workspaces ?? [workspace()]).map((record) => [record.workspaceId, record]),
    ),
    storedAgents: new Map(
      (overrides.storedAgents ?? [storedAgent()]).map((record) => [record.id, record]),
    ),
    liveAgents: new Map((overrides.liveAgents ?? []).map((agent) => [agent.id, agent])),
    archivedWorkspaceIds: [],
    archivedAgentIds: [],
    emittedStoredUpdates: [],
    moves: [],
    deps: null as unknown as MetaActionsDependencies,
  };
  harness.deps = {
    serverId: "server-local",
    hostName: "dev-host",
    logger: createTestLogger(),
    agentManager: {
      getAgent: (agentId: string) => harness.liveAgents.get(agentId) ?? null,
      moveAgentWorkspace: async (agentId: string, toWorkspaceId: string) => {
        harness.moves.push({ agentId, toWorkspaceId });
        const stored = harness.storedAgents.get(agentId);
        if (!stored) {
          throw new Error(`Agent ${agentId} not found`);
        }
        const updated = {
          ...stored,
          workspaceId: toWorkspaceId,
          updatedAt: new Date().toISOString(),
        };
        harness.storedAgents.set(agentId, updated);
        return updated;
      },
      updateAgentMetadata: async (agentId: string, updates: { title?: string }) => {
        if (harness.liveAgents.has(agentId)) {
          const live = harness.liveAgents.get(agentId)!;
          if (updates.title) {
            live.title = updates.title;
          }
          return;
        }
        const stored = harness.storedAgents.get(agentId);
        if (!stored) {
          throw new Error(`Agent ${agentId} not found`);
        }
        harness.storedAgents.set(agentId, {
          ...stored,
          ...(updates.title ? { title: updates.title } : {}),
          updatedAt: new Date().toISOString(),
        });
      },
    },
    agentStorage: {
      get: async (agentId: string) => harness.storedAgents.get(agentId) ?? null,
      list: async () => Array.from(harness.storedAgents.values()),
    },
    workspaceRegistry: {
      get: async (workspaceId: string) => harness.workspaces.get(workspaceId) ?? null,
      update: async (workspaceId: string, updater) => {
        const existing = harness.workspaces.get(workspaceId);
        if (!existing) {
          return null;
        }
        const updated = updater(existing);
        harness.workspaces.set(workspaceId, updated);
        return updated;
      },
      upsert: async (record: PersistedWorkspaceRecord) => {
        harness.workspaces.set(record.workspaceId, record);
      },
      list: async () => Array.from(harness.workspaces.values()),
    },
    projectRegistry: {
      get: async (projectId: string) => harness.projects.get(projectId) ?? null,
      list: async () => Array.from(harness.projects.values()),
      getOrCreateActiveByRoot: async (input) => {
        const existing = Array.from(harness.projects.values()).find(
          (candidate) => !candidate.archivedAt && candidate.rootPath === input.rootPath,
        );
        if (existing) {
          return existing;
        }
        const record = project({
          projectId: `prj_test_${harness.projects.size + 1}`,
          rootPath: input.rootPath,
          kind: input.kind,
          displayName: input.displayName,
        });
        harness.projects.set(record.projectId, record);
        return record;
      },
      update: async (projectId: string, updater) => {
        const existing = harness.projects.get(projectId);
        if (!existing) {
          return null;
        }
        const updated = updater(existing);
        harness.projects.set(projectId, updated);
        return updated;
      },
      archive: async (projectId: string, archivedAt: string) => {
        const existing = harness.projects.get(projectId);
        if (existing) {
          harness.projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
        }
      },
    },
    archiveWorkspace: async (workspaceId: string) => {
      harness.archivedWorkspaceIds.push(workspaceId);
      const existing = harness.workspaces.get(workspaceId);
      if (existing) {
        harness.workspaces.set(workspaceId, { ...existing, archivedAt: new Date().toISOString() });
      }
      return { archivedAgentIds: [], archivedWorkspaceIds: [workspaceId], removedDirectory: false };
    },
    archiveAgent: async (agentId: string) => {
      harness.archivedAgentIds.push(agentId);
      const record = harness.storedAgents.get(agentId) ?? storedAgent({ id: agentId });
      const archived = { ...record, archivedAt: new Date().toISOString() };
      harness.storedAgents.set(agentId, archived);
      return { agentId, archivedAt: archived.archivedAt!, record: archived };
    },
    emitStoredAgentUpdate: async (record: StoredAgentRecord) => {
      harness.emittedStoredUpdates.push(record);
    },
  };
  return harness;
}

describe("moveAgentToWorkspace", () => {
  test("moves a stored agent record between workspaces and returns from/to", async () => {
    const h = build({
      workspaces: [workspace(), workspace({ workspaceId: "ws-b", cwd: "/work/ws-b" })],
    });
    const result = await moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-b" });
    expect(result).toMatchObject({
      agentId: "agent-1",
      fromWorkspaceId: "ws-a",
      toWorkspaceId: "ws-b",
      live: false,
    });
    expect(h.storedAgents.get("agent-1")?.workspaceId).toBe("ws-b");
    expect(h.moves).toEqual([{ agentId: "agent-1", toWorkspaceId: "ws-b" }]);
    // Every other identity field is untouched — name is write-once.
    const moved = h.storedAgents.get("agent-1")!;
    expect(moved.name).toBe("glowing-otter");
    expect(moved.title).toBe("Worker A");
    expect(moved.cwd).toBe("/work/ws-a");
  });

  test("moves an idle live agent", async () => {
    const h = build({
      workspaces: [workspace(), workspace({ workspaceId: "ws-b", cwd: "/work/ws-b" })],
      storedAgents: [storedAgent()],
      liveAgents: [
        { id: "agent-1", workspaceId: "ws-a", lifecycle: "idle", name: "glowing-otter" },
      ],
    });
    const result = await moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-b" });
    expect(result.live).toBe(true);
    expect(h.storedAgents.get("agent-1")?.workspaceId).toBe("ws-b");
  });

  test("is an idempotent no-op when already in the target workspace", async () => {
    const h = build();
    const before = h.storedAgents.get("agent-1");
    const result = await moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-a" });
    expect(result.toWorkspaceId).toBe("ws-a");
    expect(h.moves).toEqual([]);
    expect(h.storedAgents.get("agent-1")).toEqual(before);
  });

  test("refuses a missing agent", async () => {
    const h = build({ storedAgents: [] });
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: "ghost", workspaceId: "ws-b" }),
    ).rejects.toThrow("Agent ghost not found on this host");
  });

  test("refuses an archived agent", async () => {
    const h = build({ storedAgents: [storedAgent({ archivedAt: "2026-01-01T00:00:00.000Z" })] });
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-b" }),
    ).rejects.toThrow("Agent agent-1 is archived");
  });

  test("refuses a running agent", async () => {
    const h = build({
      storedAgents: [storedAgent()],
      liveAgents: [{ id: "agent-1", workspaceId: "ws-a", lifecycle: "running" }],
    });
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-b" }),
    ).rejects.toThrow("is running; stop it before moving");
    expect(h.moves).toEqual([]);
  });

  test("refuses a missing target workspace", async () => {
    const h = build({ workspaces: [] });
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-missing" }),
    ).rejects.toThrow("Workspace ws-missing not found on this host");
    expect(h.moves).toEqual([]);
  });

  test("refuses an archived target workspace", async () => {
    const h = build({
      workspaces: [workspace({ workspaceId: "ws-b", archivedAt: "2026-01-01T00:00:00.000Z" })],
    });
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "ws-b" }),
    ).rejects.toThrow("Workspace ws-b is archived");
    expect(h.moves).toEqual([]);
  });

  test("refuses empty ids", async () => {
    const h = build();
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: " ", workspaceId: "ws-b" }),
    ).rejects.toThrow("agentId is required");
    await expect(
      moveAgentToWorkspace(h.deps, { agentId: "agent-1", workspaceId: "" }),
    ).rejects.toThrow("workspaceId is required");
  });
});

describe("validateMetaPlan refusal paths", () => {
  const plan = (overrides: Partial<MissionControlMetaPlan>): MissionControlMetaPlan => ({
    action: "rename_project",
    ...overrides,
  });

  test("rename_project: missing target, missing project, empty newValue", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "rename_project", targetId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "rename_project requires a targetId",
    });
    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "rename_project", targetId: "prj-ghost", newValue: "x" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Project prj-ghost not found" });
    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "rename_project", targetId: "prj-experiments", newValue: "  " }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "rename_project requires a non-empty newValue",
    });
  });

  test("rename_workspace: missing target, missing workspace, empty newValue", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "rename_workspace", targetId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "rename_workspace requires a targetId",
    });
    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "rename_workspace", targetId: "ws-ghost", newValue: "x" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Workspace ws-ghost not found" });
    await expect(
      applyMetaPlan(h.deps, plan({ action: "rename_workspace", targetId: "ws-a", newValue: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "rename_workspace requires a non-empty newValue",
    });
  });

  test("rename_agent_title: missing target, missing agent, empty newValue", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "rename_agent_title", targetId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "rename_agent_title requires a targetId",
    });
    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "rename_agent_title", targetId: "agent-ghost", newValue: "x" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Agent agent-ghost not found" });
    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "rename_agent_title", targetId: "agent-1", newValue: "" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "rename_agent_title requires a non-empty newValue",
    });
  });

  test("archive_project / archive_workspace / archive_agent: missing target, missing record", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "archive_project", targetId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "archive_project requires a targetId",
    });
    await expect(
      applyMetaPlan(h.deps, plan({ action: "archive_project", targetId: "prj-ghost" })),
    ).resolves.toMatchObject({ ok: false, error: "Project prj-ghost not found" });
    await expect(
      applyMetaPlan(h.deps, plan({ action: "archive_workspace", targetId: "ws-ghost" })),
    ).resolves.toMatchObject({ ok: false, error: "Workspace ws-ghost not found" });
    await expect(
      applyMetaPlan(h.deps, plan({ action: "archive_agent", targetId: "agent-ghost" })),
    ).resolves.toMatchObject({ ok: false, error: "Agent agent-ghost not found" });
  });

  test("create_project: missing destination", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "create_project", destination: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "create_project requires a destination (project root path)",
    });
  });

  test("move_agent: missing ids, missing records, archived/running agent, archived workspace", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "move_agent", targetId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "move_agent requires a targetId (agent id)",
    });
    await expect(
      applyMetaPlan(h.deps, plan({ action: "move_agent", targetId: "agent-1", destination: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "move_agent requires a destination (target workspace id)",
    });
    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "move_agent", targetId: "agent-ghost", destination: "ws-b" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Agent agent-ghost not found" });

    const archivedAgent = build({
      storedAgents: [storedAgent({ archivedAt: "2026-01-01T00:00:00.000Z" })],
    });
    await expect(
      applyMetaPlan(
        archivedAgent.deps,
        plan({ action: "move_agent", targetId: "agent-1", destination: "ws-b" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Agent agent-1 is archived" });

    const running = build({
      liveAgents: [{ id: "agent-1", workspaceId: "ws-a", lifecycle: "running" }],
    });
    await expect(
      applyMetaPlan(
        running.deps,
        plan({ action: "move_agent", targetId: "agent-1", destination: "ws-b" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "Agent agent-1 is running; stop it before moving",
    });

    await expect(
      applyMetaPlan(
        h.deps,
        plan({ action: "move_agent", targetId: "agent-1", destination: "ws-ghost" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Workspace ws-ghost not found" });

    const archivedWs = build({
      workspaces: [workspace({ workspaceId: "ws-b", archivedAt: "2026-01-01T00:00:00.000Z" })],
    });
    await expect(
      applyMetaPlan(
        archivedWs.deps,
        plan({ action: "move_agent", targetId: "agent-1", destination: "ws-b" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Workspace ws-b is archived" });
  });

  test("promote_workspace: missing target, missing/archived workspace, no experiments project, not in experiments", async () => {
    const h = build();
    await expect(
      applyMetaPlan(h.deps, plan({ action: "promote_workspace", targetId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "promote_workspace requires a targetId (workspace id)",
    });
    await expect(
      applyMetaPlan(h.deps, plan({ action: "promote_workspace", targetId: "ws-ghost" })),
    ).resolves.toMatchObject({ ok: false, error: "Workspace ws-ghost not found" });
    await expect(
      applyMetaPlan(
        build({
          workspaces: [workspace({ archivedAt: "2026-01-01T00:00:00.000Z" })],
        }).deps,
        plan({ action: "promote_workspace", targetId: "ws-a" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "Workspace ws-a is archived" });

    // No experiments project on the host.
    const noExperiments = build({ projects: [] });
    await expect(
      applyMetaPlan(noExperiments.deps, plan({ action: "promote_workspace", targetId: "ws-a" })),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("no experiments project"),
    });

    // Workspace belongs to a non-experiments project while the host HAS an
    // experiments project (root /home/me/experiments).
    const otherProject = build({
      projects: [
        project(),
        project({ projectId: "prj-other", rootPath: "/home/me/other", displayName: "other" }),
      ],
      workspaces: [workspace({ projectId: "prj-other" })],
    });
    await expect(
      applyMetaPlan(otherProject.deps, plan({ action: "promote_workspace", targetId: "ws-a" })),
    ).resolves.toMatchObject({
      ok: false,
      error: "Workspace ws-a is not in the experiments project (it belongs to prj-other)",
    });
  });
});

describe("applyMetaPlan happy paths", () => {
  test("rename_project sets customName; rename_workspace sets title; rename_agent_title touches only title", async () => {
    const h = build();
    const renamed = await applyMetaPlan(h.deps, {
      action: "rename_project",
      targetId: "prj-experiments",
      newValue: "Experiments HQ",
    });
    expect(renamed).toMatchObject({ ok: true });
    expect(h.projects.get("prj-experiments")?.customName).toBe("Experiments HQ");

    await applyMetaPlan(h.deps, {
      action: "rename_workspace",
      targetId: "ws-a",
      newValue: "Backtesting lab",
    });
    expect(h.workspaces.get("ws-a")?.title).toBe("Backtesting lab");

    const agentResult = await applyMetaPlan(h.deps, {
      action: "rename_agent_title",
      targetId: "agent-1",
      newValue: "Backtest runner",
    });
    expect(agentResult).toMatchObject({ ok: true });
    const renamedAgent = h.storedAgents.get("agent-1")!;
    expect(renamedAgent.title).toBe("Backtest runner");
    // NAME IS WRITE-ONCE — never touched by a title rename.
    expect(renamedAgent.name).toBe("glowing-otter");
  });

  test("create_project allocates a project at the destination root", async () => {
    const h = build({ projects: [] });
    const result = await applyMetaPlan(h.deps, {
      action: "create_project",
      destination: "/home/me/new-work",
      newValue: "new-work",
    });
    expect(result).toMatchObject({ ok: true });
    const created = Array.from(h.projects.values()).find((p) => p.rootPath === "/home/me/new-work");
    expect(created).toBeDefined();
    expect(created?.displayName).toBe("new-work");
    expect(created?.archivedAt).toBeNull();
  });

  test("move_agent applies and emits the stored-agent update", async () => {
    const h = build({
      workspaces: [workspace(), workspace({ workspaceId: "ws-b", cwd: "/work/ws-b" })],
    });
    const result = await applyMetaPlan(h.deps, {
      action: "move_agent",
      targetId: "agent-1",
      destination: "ws-b",
    });
    expect(result).toMatchObject({ ok: true });
    expect(h.storedAgents.get("agent-1")?.workspaceId).toBe("ws-b");
    expect(h.emittedStoredUpdates.map((record) => record.id)).toContain("agent-1");
  });

  test("archive_agent archives the record; archive_workspace cascades; archive_project cascades + archives the project", async () => {
    const h = build();
    const archivedAgent = await applyMetaPlan(h.deps, {
      action: "archive_agent",
      targetId: "agent-1",
    });
    expect(archivedAgent).toMatchObject({ ok: true });
    expect(h.archivedAgentIds).toEqual(["agent-1"]);
    expect(h.storedAgents.get("agent-1")?.archivedAt).toBeTruthy();

    const wsResult = await applyMetaPlan(h.deps, { action: "archive_workspace", targetId: "ws-a" });
    expect(wsResult).toMatchObject({ ok: true });
    expect(h.archivedWorkspaceIds).toEqual(["ws-a"]);

    const h2 = build({
      projects: [project()],
      workspaces: [workspace({ workspaceId: "ws-a" }), workspace({ workspaceId: "ws-b" })],
    });
    const projectResult = await applyMetaPlan(h2.deps, {
      action: "archive_project",
      targetId: "prj-experiments",
    });
    expect(projectResult).toMatchObject({ ok: true });
    expect(h2.archivedWorkspaceIds.sort()).toEqual(["ws-a", "ws-b"]);
    expect(h2.projects.get("prj-experiments")?.archivedAt).toBeTruthy();
  });
});

describe("promote_workspace", () => {
  test("creates a project at the workspace root, reparents the workspace, leaves agents intact", async () => {
    const h = build({
      projects: [project()],
      workspaces: [workspace()],
      storedAgents: [
        storedAgent({ id: "agent-1", workspaceId: "ws-a", name: "glowing-otter" }),
        storedAgent({ id: "agent-2", workspaceId: "ws-a", name: "curious-crab" }),
        storedAgent({ id: "agent-3", workspaceId: "ws-other", name: "dormant-lion" }),
      ],
    });
    const beforeProject = h.projects.get("prj-experiments")!;
    const beforeWorkspace = h.workspaces.get("ws-a")!;
    const beforeAgents = Array.from(h.storedAgents.values()).map((record) =>
      Object.assign({}, record),
    );

    const result = await applyMetaPlan(h.deps, {
      action: "promote_workspace",
      targetId: "ws-a",
      newValue: "backtesting",
    });
    expect(result).toMatchObject({ ok: true });

    // Project created at the workspace's path root, named from newValue.
    const promoted = Array.from(h.projects.values()).find(
      (candidate) => candidate.rootPath === "/home/me/experiments/ws-a",
    );
    expect(promoted).toBeDefined();
    expect(promoted?.displayName).toBe("backtesting");
    expect(promoted?.archivedAt).toBeNull();

    // Workspace reparented; nothing else about it changed.
    const afterWorkspace = h.workspaces.get("ws-a")!;
    expect(afterWorkspace.projectId).toBe(promoted!.projectId);
    expect(afterWorkspace.workspaceId).toBe(beforeWorkspace.workspaceId);
    expect(afterWorkspace.cwd).toBe(beforeWorkspace.cwd);
    expect(afterWorkspace.title).toBe(beforeWorkspace.title);

    // The experiments project itself is untouched.
    expect(h.projects.get("prj-experiments")).toEqual(beforeProject);

    // Agents moved WITH the workspace: same workspaceId, names/titles intact,
    // unrelated agents untouched.
    const movedAgents = ["agent-1", "agent-2"].map((id) => h.storedAgents.get(id)!);
    for (const agent of movedAgents) {
      expect(agent.workspaceId).toBe("ws-a");
      expect(agent.name).toBe(beforeAgents.find((before) => before.id === agent.id)!.name);
      expect(agent.title).toBe(beforeAgents.find((before) => before.id === agent.id)!.title);
      expect(agent.cwd).toBe(beforeAgents.find((before) => before.id === agent.id)!.cwd);
    }
    expect(h.storedAgents.get("agent-3")).toEqual(beforeAgents[2]);
  });

  test("resolves the experiments project by root path", async () => {
    const h = build({ projects: [project()] });
    const resolved = await resolveExperimentsProject(h.deps);
    expect(resolved?.projectId).toBe("prj-experiments");
  });
});
