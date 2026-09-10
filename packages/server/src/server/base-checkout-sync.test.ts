import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { isPlatform } from "../test-utils/platform.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import { BaseCheckoutSyncService } from "./base-checkout-sync.js";
import type { WorkspaceGitRuntimeSnapshot } from "./workspace-git-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"], { cwd });
}

function createGitRepoWithOrigin(): { tempDir: string; repoDir: string; originDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "base-checkout-sync-test-"));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  const originDir = path.join(tempDir, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", repoDir, originDir]);
  execFileSync("git", ["remote", "add", "origin", originDir], { cwd: repoDir });
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: repoDir });
  return { tempDir, repoDir, originDir };
}

// Advances origin's main ahead of repoDir's already-fetched refs/remotes/origin/main, via a
// separate clone, so the periodic sync's fetch has something new to pull down.
function advanceOrigin(tempDir: string, originDir: string): string {
  const scratchDir = path.join(tempDir, `scratch-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["clone", "-q", originDir, scratchDir]);
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: scratchDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: scratchDir });
  writeFileSync(path.join(scratchDir, "ADVANCE.md"), "origin advanced\n");
  execFileSync("git", ["add", "ADVANCE.md"], { cwd: scratchDir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "advance"], {
    cwd: scratchDir,
  });
  execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: scratchDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratchDir }).toString().trim();
}

function headOf(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
}

function remoteTrackingMainOf(cwd: string): string {
  return execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd }).toString().trim();
}

function buildSnapshot(cwd: string, isDirty: boolean): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty,
      baseRef: null,
      aheadBehind: null,
      upstreamRef: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: true,
      diffStat: null,
    },
    forge: {
      featuresEnabled: false,
      authState: "unauthenticated",
      pullRequest: null,
      error: null,
    },
  };
}

function createProject(input: {
  projectId: string;
  baseWorkspaceId: string | null;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return {
    projectId: input.projectId,
    rootPath: "/tmp/base-checkout-sync-test-does-not-exist",
    kind: "git",
    displayName: input.projectId,
    projectKey: null,
    customName: null,
    customIconRevision: null,
    description: null,
    baseWorkspaceId: input.baseWorkspaceId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
  };
}

function createWorkspace(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  archivedAt?: string | null;
}): PersistedWorkspaceRecord {
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    cwd: input.cwd,
    kind: "local_checkout",
    displayName: input.workspaceId,
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
  };
}

describe.skipIf(isPlatform("win32"))("BaseCheckoutSyncService", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("fetches a due base checkout and fast-forwards it when clean and idle", async () => {
    const { tempDir, repoDir, originDir } = createGitRepoWithOrigin();
    cleanupPaths.push(tempDir);
    const originTip = advanceOrigin(tempDir, originDir);
    expect(headOf(repoDir)).not.toBe(originTip);

    const project = createProject({ projectId: "proj-1", baseWorkspaceId: "ws-1" });
    const workspace = createWorkspace({ workspaceId: "ws-1", projectId: "proj-1", cwd: repoDir });

    const service = new BaseCheckoutSyncService({
      logger: createTestLogger(),
      projectRegistry: { list: async () => [project] },
      workspaceRegistry: { get: async () => workspace },
      workspaceGitService: {
        getSnapshot: async (cwd) => buildSnapshot(cwd, false),
        resolveDefaultBranch: async () => "main",
      },
      agentStorage: { listByWorkspace: async () => [] },
      agentManager: { hasInFlightRun: () => false },
    });

    await service.runTickForTest();

    expect(headOf(repoDir)).toBe(originTip);
  });

  test("fetches a dirty base checkout but does not fast-forward it", async () => {
    const { tempDir, repoDir, originDir } = createGitRepoWithOrigin();
    cleanupPaths.push(tempDir);
    const originTip = advanceOrigin(tempDir, originDir);
    const staleHead = headOf(repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "uncommitted change\n");

    const project = createProject({ projectId: "proj-1", baseWorkspaceId: "ws-1" });
    const workspace = createWorkspace({ workspaceId: "ws-1", projectId: "proj-1", cwd: repoDir });

    const service = new BaseCheckoutSyncService({
      logger: createTestLogger(),
      projectRegistry: { list: async () => [project] },
      workspaceRegistry: { get: async () => workspace },
      workspaceGitService: {
        getSnapshot: async (cwd) => buildSnapshot(cwd, true),
        resolveDefaultBranch: async () => "main",
      },
      agentStorage: { listByWorkspace: async () => [] },
      agentManager: { hasInFlightRun: () => false },
    });

    await service.runTickForTest();

    // Fetch happened (the remote-tracking ref caught up)...
    expect(remoteTrackingMainOf(repoDir)).toBe(originTip);
    // ...but the dirty working tree was never fast-forwarded.
    expect(headOf(repoDir)).toBe(staleHead);
  });

  test("fetches a base checkout with an in-flight agent run but does not fast-forward it", async () => {
    const { tempDir, repoDir, originDir } = createGitRepoWithOrigin();
    cleanupPaths.push(tempDir);
    const originTip = advanceOrigin(tempDir, originDir);
    const staleHead = headOf(repoDir);

    const project = createProject({ projectId: "proj-1", baseWorkspaceId: "ws-1" });
    const workspace = createWorkspace({ workspaceId: "ws-1", projectId: "proj-1", cwd: repoDir });
    const runningAgent = { id: "agent-1" } as unknown as StoredAgentRecord;

    const service = new BaseCheckoutSyncService({
      logger: createTestLogger(),
      projectRegistry: { list: async () => [project] },
      workspaceRegistry: { get: async () => workspace },
      workspaceGitService: {
        getSnapshot: async (cwd) => buildSnapshot(cwd, false),
        resolveDefaultBranch: async () => "main",
      },
      agentStorage: { listByWorkspace: async () => [runningAgent] },
      agentManager: { hasInFlightRun: (agentId) => agentId === "agent-1" },
    });

    await service.runTickForTest();

    expect(remoteTrackingMainOf(repoDir)).toBe(originTip);
    expect(headOf(repoDir)).toBe(staleHead);
  });

  test("skips a project with no baseWorkspaceId without ever reading its workspace", async () => {
    const noBaseProject = createProject({ projectId: "proj-no-base", baseWorkspaceId: null });
    let workspaceLookups = 0;

    const service = new BaseCheckoutSyncService({
      logger: createTestLogger(),
      projectRegistry: { list: async () => [noBaseProject] },
      workspaceRegistry: {
        get: async () => {
          workspaceLookups += 1;
          return null;
        },
      },
      workspaceGitService: {
        getSnapshot: async (cwd) => buildSnapshot(cwd, false),
        resolveDefaultBranch: async () => "main",
      },
      agentStorage: { listByWorkspace: async () => [] },
      agentManager: { hasInFlightRun: () => false },
    });

    await service.runTickForTest();

    expect(workspaceLookups).toBe(0);
  });

  test("does not re-sync a base checkout before its due interval elapses", async () => {
    const { tempDir, repoDir } = createGitRepoWithOrigin();
    cleanupPaths.push(tempDir);
    const project = createProject({ projectId: "proj-1", baseWorkspaceId: "ws-1" });
    const workspace = createWorkspace({ workspaceId: "ws-1", projectId: "proj-1", cwd: repoDir });

    let nowMs = 0;
    let syncAttempts = 0;
    const service = new BaseCheckoutSyncService({
      logger: createTestLogger(),
      now: () => nowMs,
      dueIntervalMs: 5 * 60_000,
      projectRegistry: { list: async () => [project] },
      workspaceRegistry: { get: async () => workspace },
      workspaceGitService: {
        getSnapshot: async (cwd, options) => {
          // Only the initial (non-forced) isGit check runs once per due sync attempt; the
          // forced re-read before a fast-forward is a second call within the same attempt.
          if (!options?.force) {
            syncAttempts += 1;
          }
          return buildSnapshot(cwd, false);
        },
        resolveDefaultBranch: async () => "main",
      },
      agentStorage: { listByWorkspace: async () => [] },
      agentManager: { hasInFlightRun: () => false },
    });

    await service.runTickForTest();
    expect(syncAttempts).toBe(1);

    nowMs = 60_000; // one minute later, still under the five-minute due interval
    await service.runTickForTest();
    expect(syncAttempts).toBe(1);

    nowMs = 5 * 60_000 + 1;
    await service.runTickForTest();
    expect(syncAttempts).toBe(2);
  });
});
