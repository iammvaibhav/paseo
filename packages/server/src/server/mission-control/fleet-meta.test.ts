import { describe, expect, test } from "vitest";
import type { MissionControlMetaPlan } from "@getpaseo/protocol/mission-control/types";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { buildFleetMetaProposalInput, classifyFleetMetaAction } from "./fleet-meta.js";
import type { MetaActionsLookupDependencies } from "./meta-actions.js";

/**
 * M5 fleet_meta tool builder tests: the tool validates a metaPlan against
 * live state BEFORE the approval gate sees it (a nonsense plan is a tool
 * error, never a card), and the resulting ProposalCreateInput carries
 * kind "meta" + the plan, with destructive classification for archives and
 * the M4 targetAgentId convention ("" for project/workspace actions, the
 * real agent id for agent-targeted ones).
 */

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

function buildLookup(
  overrides: {
    projects?: PersistedProjectRecord[];
    workspaces?: PersistedWorkspaceRecord[];
    agents?: StoredAgentRecord[];
    liveRunning?: string[];
  } = {},
): MetaActionsLookupDependencies {
  const agents = new Map(
    (overrides.agents ?? [storedAgent()]).map((record) => [record.id, record]),
  );
  const running = new Set(overrides.liveRunning ?? []);
  return {
    agentManager: {
      getAgent: (agentId: string) =>
        running.has(agentId)
          ? ({ id: agentId, workspaceId: "ws-a", lifecycle: "running" } as never)
          : null,
    },
    agentStorage: {
      get: async (agentId: string) => agents.get(agentId) ?? null,
    },
    workspaceRegistry: {
      get: async (workspaceId: string) =>
        (overrides.workspaces ?? [workspace()]).find(
          (record) => record.workspaceId === workspaceId,
        ) ?? null,
    },
    projectRegistry: {
      get: async (projectId: string) =>
        (overrides.projects ?? [project()]).find((record) => record.projectId === projectId) ??
        null,
      list: async () => overrides.projects ?? [project()],
    },
  };
}

function plan(overrides: Partial<MissionControlMetaPlan>): MissionControlMetaPlan {
  return { action: "rename_workspace", ...overrides };
}

describe("buildFleetMetaProposalInput", () => {
  test("throws on a plan that fails live-state validation (no proposal is created)", async () => {
    const lookup = buildLookup();
    await expect(
      buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup,
        metaPlan: plan({ action: "rename_project", targetId: "prj-ghost", newValue: "x" }),
      }),
    ).rejects.toThrow("Project prj-ghost not found");
    await expect(
      buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup,
        metaPlan: plan({ action: "rename_workspace", targetId: "ws-a", newValue: "" }),
      }),
    ).rejects.toThrow("rename_workspace requires a non-empty newValue");
    await expect(
      buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup,
        metaPlan: plan({ action: "promote_workspace", targetId: "ws-other" }),
      }),
    ).rejects.toThrow("Workspace ws-other not found");
    // Promote from a workspace that is NOT in the experiments project (the
    // host has an experiments project, the workspace belongs to another one).
    await expect(
      buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup: buildLookup({
          workspaces: [workspace({ projectId: "prj-other" })],
          projects: [
            project(),
            project({ projectId: "prj-other", rootPath: "/home/me/other", displayName: "other" }),
          ],
        }),
        metaPlan: plan({ action: "promote_workspace", targetId: "ws-a" }),
      }),
    ).rejects.toThrow("is not in the experiments project");
    // Running agent cannot be moved.
    await expect(
      buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup: buildLookup({ liveRunning: ["agent-1"] }),
        metaPlan: plan({ action: "move_agent", targetId: "agent-1", destination: "ws-b" }),
      }),
    ).rejects.toThrow("is running; stop it before moving");
  });

  test("builds a meta-kind proposal for a workspace rename with empty targetAgentId", async () => {
    const input = await buildFleetMetaProposalInput({
      serverId: "server-local",
      lookup: buildLookup(),
      metaPlan: plan({ action: "rename_workspace", targetId: "ws-a", newValue: "Lab" }),
    });
    expect(input).toMatchObject({
      origin: "commander",
      serverId: "server-local",
      targetAgentId: "",
      kind: "meta",
      classification: "normal",
      deliveryMode: "interrupt",
      metaPlan: { action: "rename_workspace", targetId: "ws-a", newValue: "Lab" },
    });
    expect(input.message).toContain("Rename workspace");
  });

  test("agent-targeted actions carry the real targetAgentId", async () => {
    const move = await buildFleetMetaProposalInput({
      serverId: "server-local",
      lookup: buildLookup({
        workspaces: [workspace(), workspace({ workspaceId: "ws-b", cwd: "/work/ws-b" })],
      }),
      metaPlan: plan({ action: "move_agent", targetId: "agent-1", destination: "ws-b" }),
    });
    expect(move.targetAgentId).toBe("agent-1");

    const renameTitle = await buildFleetMetaProposalInput({
      serverId: "server-local",
      lookup: buildLookup(),
      metaPlan: plan({ action: "rename_agent_title", targetId: "agent-1", newValue: "Runner" }),
    });
    expect(renameTitle.targetAgentId).toBe("agent-1");
  });

  test("archive actions classify destructive; rename/create/move/promote are normal", async () => {
    const lookup = buildLookup({
      workspaces: [workspace(), workspace({ workspaceId: "ws-b", cwd: "/work/ws-b" })],
    });
    const destructiveTargets: Record<string, string> = {
      archive_project: "prj-experiments",
      archive_workspace: "ws-a",
      archive_agent: "agent-1",
    };
    for (const action of ["archive_project", "archive_workspace", "archive_agent"] as const) {
      const input = await buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup,
        metaPlan: plan({ action, targetId: destructiveTargets[action] } as MissionControlMetaPlan),
      });
      expect(classifyFleetMetaAction(input.metaPlan!)).toBe("destructive");
      expect(input.classification).toBe("destructive");
    }
    const normalTargets: Record<string, Partial<MissionControlMetaPlan>> = {
      create_project: { destination: "/home/me/new" },
      promote_workspace: { targetId: "ws-a" },
      rename_project: { targetId: "prj-experiments", newValue: "x" },
      rename_workspace: { targetId: "ws-a", newValue: "x" },
      move_agent: { targetId: "agent-1", destination: "ws-b" },
      rename_agent_title: { targetId: "agent-1", newValue: "x" },
    };
    for (const action of [
      "rename_project",
      "rename_workspace",
      "rename_agent_title",
      "create_project",
      "move_agent",
      "promote_workspace",
    ] as const) {
      const metaPlan = plan({ action, ...normalTargets[action] });
      const input = await buildFleetMetaProposalInput({
        serverId: "server-local",
        lookup,
        metaPlan,
      });
      expect(classifyFleetMetaAction(input.metaPlan!)).toBe("normal");
      expect(input.classification).toBe("normal");
    }
  });
});
