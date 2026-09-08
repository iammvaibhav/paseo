import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectRegistry } from "./workspace-registry.js";
import {
  computeWorktreePath,
  configureWorktreePushRemote,
  configureWorktreeTrackingRemote,
  listPaseoWorktrees,
  normalizePathForOwnership,
  readPaseoConfig,
  resolveWorktreeSourcePlan,
  runWorktreeSetupCommands,
  seedPaseoConfigFile,
  type WorktreeConfig,
  type WorktreeSource,
  type WorktreeSourcePlan,
} from "../utils/worktree.js";
import { runGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";
import { writePaseoWorktreeMetadata } from "../utils/worktree-metadata.js";

export interface WarmWorktreeRecord {
  repoRoot: string;
  worktreePath: string;
  worktreeSlug: string;
  baseBranch: string;
  createdAt: string;
  status: "idle" | "provisioning" | "claimed";
}

export interface WarmWorktreeClaimOptions {
  repoRoot: string;
  worktreeSlug: string;
  source: WorktreeSource;
  paseoHome?: string;
  worktreesRoot?: string;
  runSetup?: boolean;
}

export interface WarmWorktreeClaimResult {
  worktree: WorktreeConfig;
  claimed: boolean;
}

export interface WarmWorktreePoolOptions {
  paseoHome?: string;
  worktreesRoot?: string;
  targetIdle?: number;
  enabled?: boolean;
  logger: Logger;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "getCheckout"
  >;
  projectRegistry?: ProjectRegistry;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  now?: () => Date;
  maintenanceIntervalMs?: number;
  readConfig?: () => {
    enabled?: boolean;
    targetIdle?: number;
  };
}

export interface WarmWorktreePoolStatus {
  enabled: boolean;
  targetIdle: number;
  pools: Array<{
    repoRoot: string;
    idleCount: number;
    provisioningCount: number;
    worktrees: Array<{
      slug: string;
      path: string;
      baseBranch: string;
      createdAt: string;
    }>;
  }>;
}

export interface WarmWorktreePool {
  start(): Promise<void>;
  stop(): Promise<void>;
  claim(options: WarmWorktreeClaimOptions): Promise<WarmWorktreeClaimResult | null>;
  replenish(repoRoot: string): Promise<void>;
  replenishAll(): Promise<void>;
  prune(repoRoot?: string): Promise<void>;
  getStatus(): WarmWorktreePoolStatus;
}

const DEFAULT_TARGET_IDLE = 1;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 30_000;
// Provisioning runs the project's worktree.setup, so a broken setup (missing deps, a
// failing build) fails every attempt. Without backoff the maintenance timer retries
// every 30s forever, each attempt paying a `git worktree add` + failed setup + cleanup.
// Back off exponentially per repo and cap it, so a persistently broken project costs
// one attempt every 15 minutes instead of one every 30 seconds.
const PROVISION_BACKOFF_BASE_MS = 60_000;
const PROVISION_BACKOFF_MAX_MS = 900_000;

export class WarmWorktreePoolManager implements WarmWorktreePool {
  private readonly paseoHome?: string;
  private readonly worktreesRoot?: string;
  private readonly defaultTargetIdle: number;
  private readonly defaultEnabled: boolean;
  private readonly logger: Logger;
  private readonly workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "getCheckout"
  >;
  private readonly projectRegistry?: ProjectRegistry;
  private readonly resolveDefaultBranchOverride?: (repoRoot: string) => Promise<string>;
  private readonly now: () => Date;
  private readonly maintenanceIntervalMs: number;
  private readonly readConfig?: () => { enabled?: boolean; targetIdle?: number };

  private readonly pools = new Map<string, WarmWorktreeRecord[]>();
  private readonly repoLocks = new Map<string, Promise<void>>();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private readonly provisionFailures = new Map<string, { count: number; nextAttemptAt: number }>();

  constructor(options: WarmWorktreePoolOptions) {
    this.paseoHome = options.paseoHome;
    this.worktreesRoot = options.worktreesRoot;
    this.defaultTargetIdle = options.targetIdle ?? DEFAULT_TARGET_IDLE;
    this.defaultEnabled = options.enabled ?? true;
    this.logger = options.logger.child({ component: "warm-worktree-pool" });
    this.workspaceGitService = options.workspaceGitService;
    this.projectRegistry = options.projectRegistry;
    this.resolveDefaultBranchOverride = options.resolveDefaultBranch;
    this.now = options.now ?? (() => new Date());
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.readConfig = options.readConfig;
  }

  public async start(): Promise<void> {
    this.isStopped = false;
    this.logger.info("Starting warm worktree pool manager");

    // Perform initial discovery and replenishment across known git projects
    void this.replenishAll().catch((error) => {
      this.logger.warn(
        { err: error },
        "Initial warm worktree pool replenishment encountered an error",
      );
    });

    if (this.maintenanceIntervalMs > 0) {
      this.maintenanceTimer = setInterval(() => {
        void this.maintain().catch((error) => {
          this.logger.warn({ err: error }, "Warm worktree pool maintenance task failed");
        });
      }, this.maintenanceIntervalMs);
      this.maintenanceTimer.unref();
    }
  }

  public async stop(): Promise<void> {
    this.isStopped = true;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this.logger.info("Stopped warm worktree pool manager");
  }

  public async claim(options: WarmWorktreeClaimOptions): Promise<WarmWorktreeClaimResult | null> {
    if (this.isStopped) {
      return null;
    }

    const repoRoot = normalizePathForOwnership(resolve(options.repoRoot));
    if (!this.resolvePoolEnabled(repoRoot)) {
      return null;
    }

    const isGit = await this.isGitRepo(repoRoot);
    if (!isGit) {
      return null;
    }

    return this.withRepoLock(repoRoot, async () => {
      let records = this.pools.get(repoRoot);
      let candidateIndex = records
        ? records.findIndex((r) => r.status === "idle" && existsSync(r.worktreePath))
        : -1;

      if (candidateIndex === -1) {
        await this.discoverExistingWarmWorktrees(repoRoot);
        records = this.pools.get(repoRoot) ?? [];
        candidateIndex = records.findIndex(
          (r) => r.status === "idle" && existsSync(r.worktreePath),
        );
      }

      if (candidateIndex === -1 || !records) {
        // Pool exhausted or empty; trigger background replenishment and return null for cold fallback
        void this.replenish(repoRoot).catch(() => undefined);
        return null;
      }

      const activeRecords = records;
      const warmRecord = activeRecords[candidateIndex];
      warmRecord.status = "claimed";
      activeRecords.splice(candidateIndex, 1);
      this.pools.set(repoRoot, activeRecords);

      try {
        const targetPath = await computeWorktreePath(
          repoRoot,
          options.worktreeSlug,
          options.paseoHome ?? this.paseoHome,
          options.worktreesRoot ?? this.worktreesRoot,
        );

        let finalTargetPath = targetPath;
        let suffix = 1;
        while (existsSync(finalTargetPath)) {
          finalTargetPath = `${targetPath}-${suffix}`;
          suffix++;
        }

        mkdirSync(dirname(finalTargetPath), { recursive: true });

        // Move warm worktree to final target location
        await runGitCommand(["worktree", "move", warmRecord.worktreePath, finalTargetPath], {
          cwd: repoRoot,
          timeout: 60_000,
        });

        const normalizedTargetPath = normalizePathForOwnership(finalTargetPath);

        // Resolve creation source plan (determines branches, remotes, refs)
        const sourcePlan = await resolveWorktreeSourcePlan({
          cwd: repoRoot,
          source: options.source,
          desiredSlug: options.worktreeSlug,
        });

        // Switch branch according to source plan
        await this.applyBranchToClaimedWorktree({
          worktreePath: normalizedTargetPath,
          sourcePlan,
        });

        if (sourcePlan.pushRemote) {
          await configureWorktreePushRemote({
            cwd: repoRoot,
            branchName: sourcePlan.branchName,
            remote: sourcePlan.pushRemote,
          });
        }

        if (sourcePlan.trackingRemote) {
          await configureWorktreeTrackingRemote({
            cwd: repoRoot,
            branchName: sourcePlan.branchName,
            remote: sourcePlan.trackingRemote,
          });
        }

        writePaseoWorktreeMetadata(normalizedTargetPath, {
          baseRefName: sourcePlan.metadataBaseRefName,
          ...(sourcePlan.metadataBaseRef ? { baseRef: sourcePlan.metadataBaseRef } : {}),
          ...(sourcePlan.changeRequestLookupTarget
            ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
            : {}),
        });

        await seedPaseoConfigFile({ sourceCwd: repoRoot, targetCwd: normalizedTargetPath });

        if (options.runSetup === true) {
          await runWorktreeSetupCommands({
            worktreePath: normalizedTargetPath,
            branchName: sourcePlan.branchName,
            cleanupOnFailure: true,
          });
        }

        this.logger.info(
          { repoRoot, worktreePath: normalizedTargetPath, branchName: sourcePlan.branchName },
          "Successfully claimed warm worktree",
        );

        // Background replenishment to refill the pool
        void this.replenish(repoRoot).catch(() => undefined);

        return {
          worktree: {
            branchName: sourcePlan.branchName,
            worktreePath: normalizedTargetPath,
          },
          claimed: true,
        };
      } catch (error) {
        this.logger.error(
          { err: error, repoRoot, warmWorktree: warmRecord.worktreePath },
          "Failed to claim warm worktree; discarding",
        );
        try {
          await this.cleanupFailedWorktree(repoRoot, warmRecord.worktreePath);
        } catch {
          // ignore
        }
        void this.replenish(repoRoot).catch(() => undefined);
        return null;
      }
    });
  }

  public async replenishAll(): Promise<void> {
    if (this.isStopped) return;

    const candidateRoots = new Set<string>();

    if (this.projectRegistry) {
      try {
        const projects = await this.projectRegistry.list();
        for (const project of projects) {
          if (!project.archivedAt && project.rootPath) {
            candidateRoots.add(normalizePathForOwnership(resolve(project.rootPath)));
          }
        }
      } catch (error) {
        this.logger.debug(
          { err: error },
          "Failed to list projects from registry during replenishAll",
        );
      }
    }

    for (const repoRoot of this.pools.keys()) {
      candidateRoots.add(repoRoot);
    }

    await Promise.all(
      Array.from(candidateRoots).map(async (repoRoot) => {
        try {
          await this.replenish(repoRoot);
        } catch (error) {
          this.logger.debug({ err: error, repoRoot }, "Replenish failed for repo");
        }
      }),
    );
  }

  public async replenish(repoRoot: string): Promise<void> {
    if (this.isStopped) return;

    const normalizedRoot = normalizePathForOwnership(resolve(repoRoot));
    if (!this.resolvePoolEnabled(normalizedRoot)) return;

    const isGit = await this.isGitRepo(normalizedRoot);
    if (!isGit) return;

    return this.withRepoLock(normalizedRoot, async () => {
      await this.discoverExistingWarmWorktrees(normalizedRoot);

      const targetIdle = this.resolveTargetIdle(normalizedRoot);
      const records = this.pools.get(normalizedRoot) ?? [];
      const currentIdleCount = records.filter(
        (r) => r.status === "idle" && existsSync(r.worktreePath),
      ).length;

      const needed = targetIdle - currentIdleCount;
      if (needed <= 0) return;

      if (this.isProvisioningBackedOff(normalizedRoot)) return;

      for (let i = 0; i < needed; i++) {
        if (this.isStopped) break;
        const provisioned = await this.provisionOneWarmWorktree(normalizedRoot);
        // Stop the batch on the first failure: the same broken setup will fail again,
        // and the backoff window is already armed.
        if (!provisioned) break;
      }
    });
  }

  public async prune(repoRoot?: string): Promise<void> {
    const rootsToPrune = repoRoot
      ? [normalizePathForOwnership(resolve(repoRoot))]
      : Array.from(this.pools.keys());

    for (const root of rootsToPrune) {
      await this.withRepoLock(root, async () => {
        try {
          await runGitCommand(["worktree", "prune"], { cwd: root, timeout: 30_000 });
        } catch {
          // ignore
        }
        await this.discoverExistingWarmWorktrees(root);
      });
    }
  }

  public getStatus(): WarmWorktreePoolStatus {
    const poolSummaries = Array.from(this.pools.entries()).map(([repoRoot, records]) => {
      const activeRecords = records.filter((r) => existsSync(r.worktreePath));
      return {
        repoRoot,
        idleCount: activeRecords.filter((r) => r.status === "idle").length,
        provisioningCount: activeRecords.filter((r) => r.status === "provisioning").length,
        worktrees: activeRecords.map((r) => ({
          slug: r.worktreeSlug,
          path: r.worktreePath,
          baseBranch: r.baseBranch,
          createdAt: r.createdAt,
        })),
      };
    });

    return {
      enabled: this.defaultEnabled,
      targetIdle: this.defaultTargetIdle,
      pools: poolSummaries,
    };
  }

  private isProvisioningBackedOff(repoRoot: string): boolean {
    const failure = this.provisionFailures.get(repoRoot);
    if (!failure) return false;
    if (this.now().getTime() >= failure.nextAttemptAt) return false;
    this.logger.debug(
      { repoRoot, consecutiveFailures: failure.count, nextAttemptAt: failure.nextAttemptAt },
      "Skipping warm worktree provisioning while backing off after repeated failures",
    );
    return true;
  }

  private recordProvisionOutcome(repoRoot: string, provisioned: boolean): void {
    if (provisioned) {
      this.provisionFailures.delete(repoRoot);
      return;
    }
    const previous = this.provisionFailures.get(repoRoot)?.count ?? 0;
    const count = previous + 1;
    const delayMs = Math.min(
      PROVISION_BACKOFF_BASE_MS * 2 ** (count - 1),
      PROVISION_BACKOFF_MAX_MS,
    );
    this.provisionFailures.set(repoRoot, {
      count,
      nextAttemptAt: this.now().getTime() + delayMs,
    });
    this.logger.warn(
      { repoRoot, consecutiveFailures: count, retryInMs: delayMs },
      "Warm worktree provisioning failed; backing off before the next attempt",
    );
  }

  private async maintain(): Promise<void> {
    if (this.isStopped) return;
    await this.replenishAll();
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      if (this.workspaceGitService) {
        const checkout = await this.workspaceGitService.getCheckout(cwd);
        return checkout.isGit;
      }
      const { exitCode } = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
        cwd,
        timeout: 5_000,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  private readProjectWarmPoolConfig(repoRoot: string): { enabled?: boolean; targetIdle?: number } {
    try {
      const projectConfig = readPaseoConfig(repoRoot);
      if (!projectConfig.ok || !projectConfig.config) return {};
      const rawWorktree = (projectConfig.config as Record<string, unknown>).worktree;
      if (!rawWorktree || typeof rawWorktree !== "object") return {};
      const warmPool = (rawWorktree as Record<string, unknown>).warmPool;
      if (!warmPool || typeof warmPool !== "object") return {};
      const raw = warmPool as Record<string, unknown>;
      return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
        targetIdle:
          typeof raw.targetIdle === "number" && raw.targetIdle >= 0 ? raw.targetIdle : undefined,
      };
    } catch {
      return {};
    }
  }

  private resolvePoolEnabled(repoRoot: string): boolean {
    const config = this.readConfig?.();
    if (config?.enabled !== undefined) {
      return config.enabled;
    }

    const projectWarmPool = this.readProjectWarmPoolConfig(repoRoot);
    if (projectWarmPool.enabled !== undefined) {
      return projectWarmPool.enabled;
    }

    return this.defaultEnabled;
  }

  private resolveTargetIdle(repoRoot: string): number {
    const config = this.readConfig?.();
    if (typeof config?.targetIdle === "number" && config.targetIdle >= 0) {
      return config.targetIdle;
    }

    const projectWarmPool = this.readProjectWarmPoolConfig(repoRoot);
    if (projectWarmPool.targetIdle !== undefined) {
      return projectWarmPool.targetIdle;
    }

    return this.defaultTargetIdle;
  }

  private async resolveDefaultBranch(repoRoot: string): Promise<string> {
    if (this.resolveDefaultBranchOverride) {
      try {
        return await this.resolveDefaultBranchOverride(repoRoot);
      } catch {
        // fallback
      }
    }

    if (this.workspaceGitService) {
      try {
        return await this.workspaceGitService.resolveDefaultBranch(repoRoot);
      } catch {
        // fallback
      }
    }

    try {
      const { stdout } = await runGitCommand(
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { cwd: repoRoot, timeout: 5_000 },
      );
      const branch = stdout.trim().replace(/^origin\//, "");
      if (branch) return branch;
    } catch {
      // ignore
    }

    try {
      const { stdout } = await runGitCommand(["branch", "--show-current"], {
        cwd: repoRoot,
        timeout: 5_000,
      });
      const branch = stdout.trim();
      if (branch) return branch;
    } catch {
      // ignore
    }

    return "main";
  }

  private async discoverExistingWarmWorktrees(repoRoot: string): Promise<void> {
    try {
      const worktrees = await listPaseoWorktrees({
        cwd: repoRoot,
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        includeWarm: true,
      });

      const warmEntries = worktrees.filter((w) => basename(w.path).startsWith(".warm-"));
      const existingRecords = this.pools.get(repoRoot) ?? [];
      const updatedRecords: WarmWorktreeRecord[] = [];

      for (const entry of warmEntries) {
        const normalizedPath = normalizePathForOwnership(entry.path);
        const existing = existingRecords.find((r) => r.worktreePath === normalizedPath);
        if (existing) {
          updatedRecords.push(existing);
        } else {
          updatedRecords.push({
            repoRoot,
            worktreePath: normalizedPath,
            worktreeSlug: basename(normalizedPath),
            baseBranch: entry.branchName ?? "main",
            createdAt: entry.createdAt ?? this.now().toISOString(),
            status: "idle",
          });
        }
      }

      this.pools.set(repoRoot, updatedRecords);
    } catch (error) {
      this.logger.debug({ err: error, repoRoot }, "Failed to discover existing warm worktrees");
    }
  }

  /** Returns true when an idle warm worktree is ready; false when provisioning failed. */
  private async provisionOneWarmWorktree(repoRoot: string): Promise<boolean> {
    const warmSlug = `.warm-${randomUUID().slice(0, 8)}`;
    const warmWorktreePath = await computeWorktreePath(
      repoRoot,
      warmSlug,
      this.paseoHome,
      this.worktreesRoot,
    );

    const defaultBranch = await this.resolveDefaultBranch(repoRoot);
    const parentDir = dirname(warmWorktreePath);
    mkdirSync(parentDir, { recursive: true });

    const record: WarmWorktreeRecord = {
      repoRoot,
      worktreePath: normalizePathForOwnership(warmWorktreePath),
      worktreeSlug: warmSlug,
      baseBranch: defaultBranch,
      createdAt: this.now().toISOString(),
      status: "provisioning",
    };

    const records = this.pools.get(repoRoot) ?? [];
    records.push(record);
    this.pools.set(repoRoot, records);

    try {
      this.logger.info({ repoRoot, warmSlug, defaultBranch }, "Provisioning idle warm worktree");

      await runWithGitCommandPriority("normal", async () => {
        await runGitCommand(["worktree", "add", "--detach", warmWorktreePath, defaultBranch], {
          cwd: repoRoot,
          timeout: 120_000,
        });
      });

      await seedPaseoConfigFile({ sourceCwd: repoRoot, targetCwd: warmWorktreePath });

      await runWorktreeSetupCommands({
        worktreePath: warmWorktreePath,
        branchName: defaultBranch,
        cleanupOnFailure: true,
      });

      writePaseoWorktreeMetadata(warmWorktreePath, {
        baseRefName: defaultBranch,
      });

      record.status = "idle";
      this.logger.info({ repoRoot, warmWorktreePath }, "Warm worktree provisioned successfully");
      this.recordProvisionOutcome(repoRoot, true);
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, repoRoot, warmWorktreePath },
        "Failed to provision warm worktree; cleaning up",
      );
      const index = records.indexOf(record);
      if (index !== -1) {
        records.splice(index, 1);
      }
      await this.cleanupFailedWorktree(repoRoot, warmWorktreePath);
      this.recordProvisionOutcome(repoRoot, false);
      return false;
    }
  }

  // Translates sourcePlan.addArguments (the exact argv resolveWorktreeSourcePlan built
  // for `git worktree add`) into the equivalent `git checkout` invocation. Reusing the
  // same resolved arguments — rather than re-deriving base/branch decisions from the
  // original WorktreeSource — keeps the warm and cold paths provably in sync: any branch
  // name collision, remote-only base, or already-fetched PR/change-request branch that
  // resolveWorktreeSourcePlan accounted for is honored identically here.
  private async applyBranchToClaimedWorktree(options: {
    worktreePath: string;
    sourcePlan: WorktreeSourcePlan;
  }): Promise<void> {
    const { worktreePath, sourcePlan } = options;
    const args = sourcePlan.addArguments;
    if (args[0] === "-b") {
      // ["-b", newBranchName, "--no-track", base] — mirrors `git worktree add` exactly.
      await runGitCommand(["checkout", "-b", args[1], "--no-track", args[3]], {
        cwd: worktreePath,
        timeout: 60_000,
      });
    } else {
      // [branchName] — branch already exists locally (pre-existing local branch, or
      // freshly fetched by resolveWorktreeSourcePlan for checkout-branch/PR/change-request).
      await runGitCommand(["checkout", args[0]], {
        cwd: worktreePath,
        timeout: 60_000,
      });
    }
  }

  private async cleanupFailedWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    try {
      await runGitCommand(["worktree", "prune"], { cwd: repoRoot, timeout: 30_000 });
    } catch {
      // ignore
    }
  }

  private async withRepoLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
    const currentLock = this.repoLocks.get(repoRoot) ?? Promise.resolve();
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolveLock) => {
      releaseLock = resolveLock;
    });

    const chainedLock = currentLock.then(() => nextLock);
    this.repoLocks.set(repoRoot, chainedLock);

    await currentLock;
    try {
      return await task();
    } finally {
      releaseLock();
      if (this.repoLocks.get(repoRoot) === chainedLock) {
        this.repoLocks.delete(repoRoot);
      }
    }
  }
}
