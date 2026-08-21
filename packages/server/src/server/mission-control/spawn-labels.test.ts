import { describe, expect, test, vi } from "vitest";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type { Logger } from "../../logger.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import { resolveLocalSpawnLabels, type SpawnLabelsDependencies } from "./spawn-labels.js";

function workspace(overrides: Partial<PersistedWorkspaceRecord>): PersistedWorkspaceRecord {
  return {
    workspaceId: "wks_workspace",
    projectId: "prj_project",
    cwd: "/repo",
    kind: "local_checkout",
    displayName: "main",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<PersistedProjectRecord>): PersistedProjectRecord {
  return {
    projectId: "prj_project",
    rootPath: "/repo",
    kind: "git",
    displayName: "repo",
    projectKey: null,
    customName: null,
    customIconRevision: null,
    description: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function checkout(
  cwd: string,
  currentBranch: string | null,
  isGit = true,
): ProjectCheckoutLitePayload {
  return {
    cwd,
    isGit,
    currentBranch,
    remoteUrl: isGit ? "git@github.com:acme/repo.git" : null,
    worktreeRoot: isGit ? cwd : null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: isGit ? cwd : null,
  } as ProjectCheckoutLitePayload;
}

interface LabelHarness {
  deps: SpawnLabelsDependencies;
  workspaces: Map<string, PersistedWorkspaceRecord>;
  projects: Map<string, PersistedProjectRecord>;
  getCheckout: ReturnType<typeof vi.fn>;
}

function buildHarness(): LabelHarness {
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const projects = new Map<string, PersistedProjectRecord>();
  const getCheckout = vi.fn();
  const deps: SpawnLabelsDependencies = {
    workspaceRegistry: {
      list: async () => Array.from(workspaces.values()),
      get: async (id: string) => workspaces.get(id) ?? null,
    },
    projectRegistry: {
      list: async () => Array.from(projects.values()),
      get: async (id: string) => projects.get(id) ?? null,
    },
    workspaceGitService: { getCheckout },
    logger: { warn: vi.fn() } as unknown as Logger,
  };
  return { deps, workspaces, projects, getCheckout };
}

describe("resolveLocalSpawnLabels", () => {
  test("existing workspaceId resolves workspace title and project custom name", async () => {
    const h = buildHarness();
    h.workspaces.set("wks_ws", workspace({ title: "Payments work" }));
    h.projects.set(
      "prj_project",
      project({ customName: "Acme Payments", rootPath: "/repo/payments" }),
    );
    await expect(resolveLocalSpawnLabels(h.deps, { workspaceId: "wks_ws" })).resolves.toEqual({
      workspace: "Payments work",
      project: "Acme Payments",
    });
  });

  test("workspaceId falls back to the derived display name without a title", async () => {
    const h = buildHarness();
    h.workspaces.set("wks_ws", workspace({ title: null, displayName: "main" }));
    h.projects.set("prj_project", project({ displayName: "repo" }));
    await expect(resolveLocalSpawnLabels(h.deps, { workspaceId: "wks_ws" })).resolves.toEqual({
      workspace: "main",
      project: "repo",
    });
  });

  test("unknown or archived workspaceId resolves nothing", async () => {
    const h = buildHarness();
    h.workspaces.set("wks_ws", workspace({ archivedAt: "2026-08-02T00:00:00.000Z" }));
    await expect(
      resolveLocalSpawnLabels(h.deps, { workspaceId: "wks_missing" }),
    ).resolves.toBeUndefined();
    await expect(
      resolveLocalSpawnLabels(h.deps, { workspaceId: "wks_ws" }),
    ).resolves.toBeUndefined();
  });

  test("cwd mapping to an existing workspace prefers that workspace's title and project", async () => {
    const h = buildHarness();
    h.workspaces.set("wks_ws", workspace({ workspaceId: "wks_ws", cwd: "/repo", title: "Titled" }));
    h.projects.set("prj_project", project({ rootPath: "/repo", customName: "Named repo" }));
    await expect(resolveLocalSpawnLabels(h.deps, { cwd: "/repo" })).resolves.toEqual({
      newWorkspace: "Titled",
      project: "Named repo",
    });
  });

  test("new workspace derives the name from the checked-out branch", async () => {
    const h = buildHarness();
    h.getCheckout.mockResolvedValue(checkout("/new/thing", "feature/alpha"));
    await expect(resolveLocalSpawnLabels(h.deps, { cwd: "/new/thing" })).resolves.toEqual({
      newWorkspace: "feature/alpha",
      newProject: "thing",
    });
  });

  test("new workspace falls back to the cwd basename without a checkout", async () => {
    const h = buildHarness();
    h.getCheckout.mockRejectedValue(new Error("no repo"));
    await expect(resolveLocalSpawnLabels(h.deps, { cwd: "/new/thing" })).resolves.toEqual({
      newWorkspace: "thing",
      newProject: "thing",
    });
  });

  test("a pre-created project at the exact root is reused (custom name wins, never newProject)", async () => {
    const h = buildHarness();
    h.projects.set(
      "prj_created",
      project({
        projectId: "prj_created",
        rootPath: "/new/work",
        displayName: "work",
        customName: "My New Project",
        kind: "non_git",
      }),
    );
    await expect(resolveLocalSpawnLabels(h.deps, { cwd: "/new/work" })).resolves.toEqual({
      newWorkspace: "work",
      project: "My New Project",
    });
  });

  test("an archived project at the root falls back to newProject", async () => {
    const h = buildHarness();
    h.projects.set(
      "prj_archived",
      project({
        projectId: "prj_archived",
        rootPath: "/new/work",
        displayName: "work",
        kind: "non_git",
        archivedAt: "2026-08-02T00:00:00.000Z",
      }),
    );
    await expect(resolveLocalSpawnLabels(h.deps, { cwd: "/new/work" })).resolves.toEqual({
      newWorkspace: "work",
      newProject: "work",
    });
  });

  test("no cwd and no workspaceId resolves nothing", async () => {
    await expect(resolveLocalSpawnLabels(buildHarness().deps, {})).resolves.toBeUndefined();
  });
});
