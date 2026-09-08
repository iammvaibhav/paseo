import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { WarmWorktreePoolManager } from "./warm-worktree-pool.js";
import { listPaseoWorktrees, type WorktreeSource } from "../utils/worktree.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { createPaseoWorktree, type CreatePaseoWorktreeDeps } from "./paseo-worktree-service.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { ForgeService } from "../services/forge-service.js";
function createTestGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name 'Paseo Test' && git config user.email 'test@paseo.sh'", {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "README.md"), "# Test Repo\n", "utf8");
  writeFileSync(
    join(dir, "paseo.json"),
    JSON.stringify({ worktree: { setup: ["echo setup-ran > setup.log"] } }),
    "utf8",
  );
  execSync("git add . && git commit -m 'Initial commit'", { cwd: dir, stdio: "ignore" });
}

describe("WarmWorktreePoolManager", () => {
  let tempBase: string;
  let paseoHome: string;
  let worktreesRoot: string;
  let repoDir: string;
  let logger: pino.Logger;

  beforeEach(() => {
    tempBase = join(tmpdir(), `paseo-wt-pool-test-${randomUUID()}`);
    paseoHome = join(tempBase, ".paseo");
    worktreesRoot = join(tempBase, "worktrees");
    repoDir = join(tempBase, "repo");
    mkdirSync(tempBase, { recursive: true });
    mkdirSync(paseoHome, { recursive: true });
    mkdirSync(worktreesRoot, { recursive: true });
    createTestGitRepo(repoDir);
    logger = pino({ level: "silent" });
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("provisions an idle warm worktree and reports status", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);

    const status = manager.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.targetIdle).toBe(1);
    expect(status.pools).toHaveLength(1);
    expect(status.pools[0].idleCount).toBe(1);
    expect(status.pools[0].worktrees).toHaveLength(1);
    expect(status.pools[0].worktrees[0].slug).toMatch(/^\.warm-/);
    expect(existsSync(status.pools[0].worktrees[0].path)).toBe(true);

    // Verify setup commands ran during warming
    expect(existsSync(join(status.pools[0].worktrees[0].path, "setup.log"))).toBe(true);

    // Verify listPaseoWorktrees filters out warm worktree by default
    const regularList = await listPaseoWorktrees({ cwd: repoDir, paseoHome, worktreesRoot });
    expect(regularList).toHaveLength(0);

    // Verify listPaseoWorktrees includes warm worktree when requested
    const fullList = await listPaseoWorktrees({
      cwd: repoDir,
      paseoHome,
      worktreesRoot,
      includeWarm: true,
    });
    expect(fullList).toHaveLength(1);
    expect(fullList[0].path).toBe(status.pools[0].worktrees[0].path);

    await manager.stop();
  });

  test("claims warm worktree for branch-off, retargets path and switches branch", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);

    const source: WorktreeSource = {
      kind: "branch-off",
      branchName: "feature-warm-test",
      baseBranch: "main",
    };

    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "feature-warm-test",
      source,
      paseoHome,
      worktreesRoot,
    });

    expect(result).not.toBeNull();
    expect(result?.claimed).toBe(true);
    expect(result?.worktree.branchName).toBe("feature-warm-test");
    expect(result?.worktree.worktreePath).toContain("feature-warm-test");
    expect(existsSync(result!.worktree.worktreePath)).toBe(true);

    // Verify setup file was preserved across move
    expect(existsSync(join(result!.worktree.worktreePath, "setup.log"))).toBe(true);

    // Verify branch in claimed worktree
    const currentBranch = execSync("git branch --show-current", {
      cwd: result!.worktree.worktreePath,
    })
      .toString()
      .trim();
    expect(currentBranch).toBe("feature-warm-test");

    // Verify worktree metadata
    const metadata = readPaseoWorktreeMetadata(result!.worktree.worktreePath);
    expect(metadata.baseRefName).toBe("main");

    await manager.stop();
  });

  test("claims warm worktree for checkout-branch", async () => {
    // Create an existing branch in repo
    execSync("git branch existing-feature", { cwd: repoDir, stdio: "ignore" });

    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);

    const source: WorktreeSource = {
      kind: "checkout-branch",
      branchName: "existing-feature",
    };

    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "existing-feature",
      source,
      paseoHome,
      worktreesRoot,
    });

    expect(result).not.toBeNull();
    expect(result?.claimed).toBe(true);
    expect(result?.worktree.branchName).toBe("existing-feature");

    const currentBranch = execSync("git branch --show-current", {
      cwd: result!.worktree.worktreePath,
    })
      .toString()
      .trim();
    expect(currentBranch).toBe("existing-feature");

    await manager.stop();
  });

  test("branch-off honors sourcePlan's resolved base when requested branch name collides with an existing local branch", async () => {
    // Regression test: a naive "no baseBranch specified => branch off whatever the
    // warm worktree's detached HEAD already points at" fast path is WRONG here.
    // resolveWorktreeSourcePlan bases the new branch off the EXISTING colliding
    // branch, not off main, precisely because the requested name already exists.
    execSync("git checkout -b feature-x", { cwd: repoDir, stdio: "ignore" });
    writeFileSync(join(repoDir, "feature-x-only.txt"), "distinguishing content", "utf8");
    execSync("git add . && git commit -m 'feature-x commit'", { cwd: repoDir, stdio: "ignore" });
    const featureXHead = execSync("git rev-parse feature-x", { cwd: repoDir }).toString().trim();
    execSync("git checkout main", { cwd: repoDir, stdio: "ignore" });

    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);

    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "feature-x-claim",
      source: { kind: "branch-off", branchName: "feature-x" },
      paseoHome,
      worktreesRoot,
    });

    expect(result).not.toBeNull();
    const claimedHead = execSync("git rev-parse HEAD", {
      cwd: result!.worktree.worktreePath,
    })
      .toString()
      .trim();
    // The claimed worktree must be based on feature-x's tip, not main's.
    expect(claimedHead).toBe(featureXHead);
    expect(existsSync(join(result!.worktree.worktreePath, "feature-x-only.txt"))).toBe(true);

    await manager.stop();
  });

  test("checkout-change-request checks out the fetched PR content, not the base branch", async () => {
    // Regression test: the warm claim path must check out the branch
    // resolveWorktreeSourcePlan already fetched via fetchWorktreeCheckoutRefs, not
    // reset it to the PR's base branch (which would silently discard the PR diff).
    const remoteDir = join(tempBase, "remote.git");
    execSync(`git init --bare -b main "${remoteDir}"`, { stdio: "ignore" });
    execSync(`git remote add origin "${remoteDir}"`, { cwd: repoDir, stdio: "ignore" });
    execSync("git push origin main", { cwd: repoDir, stdio: "ignore" });
    execSync("git checkout -b pr-content", { cwd: repoDir, stdio: "ignore" });
    writeFileSync(join(repoDir, "pr-only.txt"), "pr diff content", "utf8");
    execSync("git add . && git commit -m 'pr commit'", { cwd: repoDir, stdio: "ignore" });
    execSync("git push origin pr-content", { cwd: repoDir, stdio: "ignore" });
    execSync("git checkout main", { cwd: repoDir, stdio: "ignore" });
    execSync("git branch -D pr-content", { cwd: repoDir, stdio: "ignore" });

    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);

    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "pr-claim",
      source: {
        kind: "checkout-change-request",
        forge: "github",
        changeRequestNumber: 42,
        headRef: "pr-content",
        baseRefName: "main",
        checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/heads/pr-content" }],
      },
      paseoHome,
      worktreesRoot,
    });

    expect(result).not.toBeNull();
    expect(existsSync(join(result!.worktree.worktreePath, "pr-only.txt"))).toBe(true);

    await manager.stop();
  });

  test("automatically replenishes pool in background after claiming", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);
    expect(manager.getStatus().pools[0]?.idleCount).toBe(1);

    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "first-claim",
      source: { kind: "branch-off", branchName: "first-claim" },
      paseoHome,
      worktreesRoot,
    });
    expect(result?.claimed).toBe(true);

    // Wait for background replenishment to complete
    await manager.replenish(repoDir);
    const updatedStatus = manager.getStatus();
    expect(updatedStatus.pools[0]?.idleCount).toBe(1);
    expect(updatedStatus.pools[0]?.worktrees[0]?.slug).not.toBe("first-claim");

    await manager.stop();
  });

  test("backs off instead of retrying every cycle when worktree.setup keeps failing", async () => {
    // Regression test for the retry-churn seen in production: a broken worktree.setup
    // (e.g. a wiped node_modules) failed provisioning 13 times in 9 minutes, each
    // attempt paying a git worktree add + failed setup + cleanup.
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({ worktree: { setup: ["exit 1"] } }),
      "utf8",
    );
    execSync("git add . && git commit -m 'break setup'", { cwd: repoDir, stdio: "ignore" });

    const attempts: string[] = [];
    const capturingLogger = {
      child: () => capturingLogger,
      info: (_fields: unknown, msg?: string) => {
        if (msg === "Provisioning idle warm worktree") attempts.push(msg);
      },
      warn: () => {},
      debug: () => {},
      error: () => {},
    } as unknown as pino.Logger;

    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger: capturingLogger,
      now: () => new Date(clock),
      maintenanceIntervalMs: 0,
    });

    // First attempt runs and fails, arming the backoff window.
    await manager.replenish(repoDir);
    expect(manager.getStatus().pools[0]?.idleCount ?? 0).toBe(0);
    expect(attempts).toHaveLength(1);

    // Immediate retries inside the backoff window must not attempt provisioning at all.
    await manager.replenish(repoDir);
    await manager.replenish(repoDir);
    expect(attempts).toHaveLength(1);

    // Once the window elapses it tries again, so a repaired setup self-heals.
    clock += 61_000;
    await manager.replenish(repoDir);
    expect(attempts).toHaveLength(2);

    await manager.stop();
  });

  test("returns null when pool is empty and triggers replenishment", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    // Do NOT replenish upfront (pool is empty)
    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "cold-fallback",
      source: { kind: "branch-off", branchName: "cold-fallback" },
      paseoHome,
      worktreesRoot,
    });

    // Should return null so caller falls back to cold creation
    expect(result).toBeNull();

    await manager.stop();
  });

  test("returns null when pool is disabled", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: false,
      logger,
    });

    await manager.replenish(repoDir);
    const result = await manager.claim({
      repoRoot: repoDir,
      worktreeSlug: "disabled-test",
      source: { kind: "branch-off", branchName: "disabled-test" },
      paseoHome,
      worktreesRoot,
    });

    expect(result).toBeNull();
    await manager.stop();
  });

  test("gracefully skips non-git directories", async () => {
    const nonGitDir = join(tempBase, "non-git-dir");
    mkdirSync(nonGitDir, { recursive: true });

    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    // Should not throw
    await expect(manager.replenish(nonGitDir)).resolves.not.toThrow();

    const claimResult = await manager.claim({
      repoRoot: nonGitDir,
      worktreeSlug: "non-git-claim",
      source: { kind: "branch-off", branchName: "non-git-claim" },
      paseoHome,
      worktreesRoot,
    });

    expect(claimResult).toBeNull();
    await manager.stop();
  });

  test("prunes and cleans up dead worktrees", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);
    const warmPath = manager.getStatus().pools[0].worktrees[0].path;

    // Simulate external deletion of warm worktree directory
    rmSync(warmPath, { recursive: true, force: true });

    await manager.prune(repoDir);
    expect(manager.getStatus().pools[0]?.idleCount).toBe(0);

    await manager.stop();
  });
  test("integrates with createPaseoWorktree via warmWorktreePool dependency", async () => {
    const manager = new WarmWorktreePoolManager({
      paseoHome,
      worktreesRoot,
      targetIdle: 1,
      enabled: true,
      logger,
    });

    await manager.replenish(repoDir);
    expect(manager.getStatus().pools[0]?.idleCount).toBe(1);

    const workspaceGitService = {
      getCheckout: async () => ({
        isGit: true,
        rootPath: repoDir,
        worktreeRoot: null,
        mainRepoRoot: repoDir,
        remoteUrl: null,
      }),
      getSnapshot: async () => ({ forge: { pullRequest: null } }),
      peekSnapshot: async () => null,
      resolveRepoRoot: async () => repoDir,
      resolveDefaultBranch: async () => "main",
      resolveForge: async () => ({ forge: "none", service: { listPullRequests: async () => [] } }),
    };

    const workspaceProvisioning: CreatePaseoWorktreeDeps["workspaceProvisioning"] = {
      createWorkspaceForWorktree: async (input) => {
        const ws: PersistedWorkspaceRecord = {
          workspaceId: "wks_warm_test",
          projectId: "prj_test",
          cwd: input.cwd,
          worktreeRoot: input.worktreeRoot,
          branch: input.branch,
          kind: "created_worktree",
          displayName: "integrated-claim",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        };
        return ws;
      },
    };

    const result = await createPaseoWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "integrated-claim",
        branchName: "integrated-claim",
        paseoHome,
        worktreesRoot,
      },
      {
        github: {
          listPullRequests: async () => [],
          listIssues: async () => [],
          searchIssuesAndPrs: async () => ({ items: [], featuresEnabled: true }),
          invalidate: () => {},
        } as unknown as ForgeService,
        workspaceGitService:
          workspaceGitService as unknown as CreatePaseoWorktreeDeps["workspaceGitService"],
        workspaceProvisioning,
        warmWorktreePool: manager,
      },
    );

    expect(result.created).toBe(true);
    expect(result.worktree.branchName).toBe("integrated-claim");
    expect(result.workspace.workspaceId).toBe("wks_warm_test");
    expect(existsSync(result.worktree.worktreePath)).toBe(true);

    await manager.stop();
  });
});
