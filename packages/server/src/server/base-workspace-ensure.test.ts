import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";

// ADR 0001 (project-anchored base workspaces): every active project gets a
// base workspace over its root checkout, ensured by
// WorkspaceReconciliationService reacting to projectRegistry mutations (live)
// and sweeping projectRegistry.list() at start() (boot backfill). These tests
// exercise the real FileBackedProjectRegistry/FileBackedWorkspaceRegistry and
// the real workspace-provisioning-service find-or-create logic — only the
// filesystem git port is stubbed.

const logger = createTestLogger();

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function createHarness() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "base-workspace-ensure-"));
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "registry", "workspaces.json"),
    logger,
  );
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(tmpDir, "registry", "projects.json"),
    logger,
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  const workspaceProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: createNoopWorkspaceGitService(),
    logger,
  });
  return { workspaceRegistry, projectRegistry, workspaceProvisioning };
}

describe("WorkspaceReconciliationService base workspace ensure (ADR 0001)", () => {
  test("a project upsert creates a base workspace exactly once, idempotent under repeat and concurrent mutations", async () => {
    const { workspaceRegistry, projectRegistry, workspaceProvisioning } = await createHarness();
    const rootPath = path.join(tmpDir, "repo");
    mkdirSync(rootPath, { recursive: true });

    let provisioningCalls = 0;
    const countingProvisioning = {
      findOrCreateWorkspaceForDirectory: (cwd: string) => {
        provisioningCalls += 1;
        return workspaceProvisioning.findOrCreateWorkspaceForDirectory(cwd);
      },
    };

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
      workspaceProvisioning: countingProvisioning,
    });
    await service.start();

    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "repo",
      timestamp: new Date().toISOString(),
    });
    expect(project.baseWorkspaceId).toBeNull();

    // The mutation-driven ensure is fire-and-forget (awaiting it inline would
    // deadlock against the registry's project-allocation lock), so converge
    // by polling.
    const settled = await vi.waitFor(async () => {
      const record = await projectRegistry.get(project.projectId);
      if (!record?.baseWorkspaceId) throw new Error("base workspace not yet ensured");
      return record;
    });

    expect(provisioningCalls).toBe(1);
    const workspacesAfterCreate = await workspaceRegistry.list();
    expect(workspacesAfterCreate).toHaveLength(1);
    expect(workspacesAfterCreate[0]?.workspaceId).toBe(settled.baseWorkspaceId);
    expect(workspacesAfterCreate[0]?.cwd).toBe(rootPath);

    // Sequential re-run: re-upserting the now-pointered project must not
    // provision again or create a second workspace. ensureBaseWorkspace's
    // baseWorkspaceId guard runs synchronously before any await, so no
    // polling is needed here to observe that provisioning was skipped.
    await projectRegistry.upsert(settled);
    expect(provisioningCalls).toBe(1);
    expect(await workspaceRegistry.list()).toHaveLength(1);

    // Concurrent race, on a SECOND, brand-new project: two upserts of the
    // exact same never-before-seen record (both baseWorkspaceId: null) firing
    // together must still provision exactly once and create exactly one
    // workspace — the two mutation-driven ensures are serialized through a
    // per-project queue, not merely deduped while "in flight".
    const secondRootPath = path.join(tmpDir, "repo-2");
    mkdirSync(secondRootPath, { recursive: true });
    const timestamp = new Date().toISOString();
    const freshProject = {
      ...settled,
      projectId: "prj_concurrent",
      rootPath: secondRootPath,
      baseWorkspaceId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await Promise.all([projectRegistry.upsert(freshProject), projectRegistry.upsert(freshProject)]);
    await vi.waitFor(async () => {
      const record = await projectRegistry.get(freshProject.projectId);
      if (!record?.baseWorkspaceId)
        throw new Error("second project's base workspace not yet ensured");
    });
    expect(provisioningCalls).toBe(2);
    const secondProjectWorkspaces = (await workspaceRegistry.list()).filter(
      (workspace) => workspace.projectId === freshProject.projectId,
    );
    expect(secondProjectWorkspaces).toHaveLength(1);
  });

  test("the boot sweep adopts an existing active workspace at the project root instead of duplicating it", async () => {
    const { workspaceRegistry, projectRegistry, workspaceProvisioning } = await createHarness();
    const rootPath = path.join(tmpDir, "repo");
    mkdirSync(rootPath, { recursive: true });

    // Project record predates base-workspace support: baseWorkspaceId null.
    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "repo",
      timestamp: new Date().toISOString(),
    });
    expect(project.baseWorkspaceId).toBeNull();

    // A workspace over the project root already exists (created some other
    // way, e.g. open_project_request, before the ensure logic ran).
    const existingWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws_preexisting",
      projectId: project.projectId,
      cwd: rootPath,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await workspaceRegistry.upsert(existingWorkspace);

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
      workspaceProvisioning,
    });
    await service.start();

    const afterSweep = await projectRegistry.get(project.projectId);
    expect(afterSweep?.baseWorkspaceId).toBe("ws_preexisting");
    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.workspaceId).toBe("ws_preexisting");
  });

  test("an archived project is never backfilled with a base workspace", async () => {
    const { workspaceRegistry, projectRegistry, workspaceProvisioning } = await createHarness();
    const rootPath = path.join(tmpDir, "repo");
    mkdirSync(rootPath, { recursive: true });

    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "repo",
      timestamp: new Date().toISOString(),
    });
    await projectRegistry.archive(project.projectId, new Date().toISOString());

    const service = new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
      workspaceProvisioning,
    });
    await service.start();

    expect((await projectRegistry.get(project.projectId))?.baseWorkspaceId).toBeNull();
    expect(await workspaceRegistry.list()).toHaveLength(0);
  });
});
