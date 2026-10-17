import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { dedupeEquivalentProjectRoots } from "./dedupe-equivalent-project-roots.migration.js";

const NOW = "2026-10-13T00:00:00.000Z";

// Mirrors PASEO-66 on the dev host: ~/paseo is a symlink to /data/paseo, the
// long-lived project was registered under the link and a warm-pool worktree
// claim later registered the realpath as a second project.
describe.skipIf(process.platform === "win32")("dedupeEquivalentProjectRoots", () => {
  let home: string;
  let realRoot: string;
  let linkRoot: string;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-dedupe-")));
    realRoot = path.join(home, "data", "paseo");
    linkRoot = path.join(home, "home-paseo");
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, linkRoot, "dir");
    agentStorage = new AgentStorage(path.join(home, "agents"), createTestLogger());
    await agentStorage.initialize();
    projectRegistry = new FileBackedProjectRegistry(
      path.join(home, "projects", "projects.json"),
      createTestLogger(),
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(home, "projects", "workspaces.json"),
      createTestLogger(),
    );
    await Promise.all([projectRegistry.initialize(), workspaceRegistry.initialize()]);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function migrate() {
    return dedupeEquivalentProjectRoots({
      projectRegistry,
      workspaceRegistry,
      agentStorage,
      logger: createTestLogger(),
      now: () => NOW,
    });
  }

  async function seedProject(input: {
    projectId: string;
    rootPath: string;
    createdAt: string;
    baseWorkspaceId: string;
    customName?: string | null;
    description?: string | null;
  }) {
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        ...input,
        kind: "git",
        displayName: "paseo",
        projectKey: "remote:github.com/acme/paseo",
        updatedAt: input.createdAt,
      }),
    );
  }

  async function seedWorkspace(input: {
    workspaceId: string;
    projectId: string;
    cwd: string;
    createdAt: string;
    title?: string | null;
  }) {
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        ...input,
        kind: "local_checkout",
        displayName: "main",
        updatedAt: input.createdAt,
      }),
    );
  }

  async function seedAgent(id: string, workspaceId: string, cwd: string) {
    await agentStorage.upsert({
      id,
      provider: "codex",
      cwd,
      workspaceId,
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
      lastActivityAt: "2026-10-12T00:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });
  }

  async function seedPaseo66() {
    await seedProject({
      projectId: "prj_old",
      rootPath: linkRoot,
      createdAt: "2026-08-13T00:00:00.000Z",
      baseWorkspaceId: "wks_old_base",
      customName: "paseo",
      description: "Paseo fork",
    });
    await seedWorkspace({
      workspaceId: "wks_old_base",
      projectId: "prj_old",
      cwd: linkRoot,
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    await seedWorkspace({
      workspaceId: "wks_old_worktree",
      projectId: "prj_old",
      cwd: path.join(home, "worktrees", "paseo-41"),
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await seedProject({
      projectId: "prj_new",
      rootPath: realRoot,
      createdAt: "2026-10-12T22:50:23.056Z",
      baseWorkspaceId: "wks_new_base",
    });
    await seedWorkspace({
      workspaceId: "wks_new_base",
      projectId: "prj_new",
      cwd: realRoot,
      createdAt: "2026-10-12T22:50:23.951Z",
    });
    await seedWorkspace({
      workspaceId: "wks_new_worktree",
      projectId: "prj_new",
      cwd: path.join(home, "worktrees", "g4-project-dedupe"),
      createdAt: "2026-10-13T03:54:43.153Z",
      title: "Project dedupe",
    });
    await seedAgent("agent-on-new-base", "wks_new_base", realRoot);
    await seedAgent("agent-on-new-worktree", "wks_new_worktree", realRoot);
  }

  test("keeps the oldest project id and moves every duplicate workspace under it", async () => {
    await seedPaseo66();

    await migrate();

    const activeProjects = (await projectRegistry.list()).filter((p) => !p.archivedAt);
    expect(activeProjects.map((p) => p.projectId)).toEqual(["prj_old"]);
    expect(activeProjects[0]).toMatchObject({
      rootPath: realRoot,
      customName: "paseo",
      description: "Paseo fork",
      baseWorkspaceId: "wks_old_base",
      projectKey: "remote:github.com/acme/paseo",
    });
    const workspaces = await workspaceRegistry.list();
    expect(workspaces.every((w) => w.projectId === "prj_old")).toBe(true);
    expect((await workspaceRegistry.get("wks_new_worktree"))?.archivedAt).toBeNull();
  });

  test("folds the duplicate's base workspace and its agents into the surviving base", async () => {
    await seedPaseo66();

    await migrate();

    expect((await workspaceRegistry.get("wks_new_base"))?.archivedAt).toBe(NOW);
    expect((await agentStorage.get("agent-on-new-base"))?.workspaceId).toBe("wks_old_base");
    expect((await agentStorage.get("agent-on-new-worktree"))?.workspaceId).toBe("wks_new_worktree");
  });

  test("archives the duplicate project so ids that reference it still resolve", async () => {
    await seedPaseo66();

    await migrate();

    expect(await projectRegistry.get("prj_new")).toMatchObject({ archivedAt: NOW });
  });

  test("adopts duplicate metadata the surviving project lacks", async () => {
    await seedProject({
      projectId: "prj_old",
      rootPath: linkRoot,
      createdAt: "2026-08-13T00:00:00.000Z",
      baseWorkspaceId: "wks_old_base",
    });
    await seedProject({
      projectId: "prj_new",
      rootPath: realRoot,
      createdAt: "2026-10-12T00:00:00.000Z",
      baseWorkspaceId: "wks_new_base",
      customName: "Paseo",
      description: "Named later",
    });

    await migrate();

    expect(await projectRegistry.get("prj_old")).toMatchObject({
      customName: "Paseo",
      description: "Named later",
    });
  });

  test("leaves distinct roots and already-merged registries untouched", async () => {
    await seedPaseo66();
    const otherRoot = path.join(home, "data", "other");
    mkdirSync(otherRoot);
    await seedProject({
      projectId: "prj_other",
      rootPath: otherRoot,
      createdAt: "2026-09-01T00:00:00.000Z",
      baseWorkspaceId: "wks_other",
    });

    expect(await migrate()).toEqual([{ projectId: "prj_old", mergedProjectIds: ["prj_new"] }]);
    const projectsAfterFirstRun = await projectRegistry.list();
    const workspacesAfterFirstRun = await workspaceRegistry.list();

    expect(await migrate()).toEqual([]);
    expect(await projectRegistry.list()).toEqual(projectsAfterFirstRun);
    expect(await workspaceRegistry.list()).toEqual(workspacesAfterFirstRun);
    expect((await projectRegistry.get("prj_other"))?.rootPath).toBe(otherRoot);
  });
});
