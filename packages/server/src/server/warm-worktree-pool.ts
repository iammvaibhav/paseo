import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createNameId } from "mnemonic-id";
import type { Logger } from "pino";
import { PaseoWorktreeWarmPoolConfigRawSchema } from "@getpaseo/protocol/paseo-config-schema";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectRegistry } from "./workspace-registry.js";
import {
  configureWorktreePushRemote,
  configureWorktreeTrackingRemote,
  getPaseoWorktreesRoot,
  getWorktreeSetupCommands,
  listPaseoWorktrees,
  normalizePathForOwnership,
  resolvePaseoWorktreesBaseRoot,
  resolveWorktreeSourcePlan,
  runWorktreeSetupCommands,
  seedPaseoConfigFile,
  type CreatedWorktree,
  type WorktreeSource,
  type WorktreeSourcePlan,
} from "../utils/worktree.js";
import { readPaseoConfigJson } from "../utils/paseo-config-file.js";
import { runGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";
import {
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "../utils/worktree-metadata.js";
import {
  listWarmWorktreeMarkedPaths,
  readWarmWorktreeMarker,
  removeWarmWorktreeMarker,
  writeWarmWorktreeMarker,
} from "../utils/warm-worktree-marker.js";

export interface WarmWorktreeRecord {
  repoRoot: string;
  worktreePath: string;
  worktreeSlug: string;
  baseBranch: string;
  /** Commit the tree is checked out at; differs from the base's tip once the base moves. */
  baseSha: string;
  /** Hash of the worktree.setup that ran in this tree; null until setup finished. */
  setupFingerprint: string | null;
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
  /** Called with the tree's path as soon as it is reserved, before the claim's git work. */
  onReserved?: (worktreePath: string) => void;
}

export interface WarmWorktreeClaimResult {
  worktree: CreatedWorktree;
  claimed: boolean;
  /**
   * True when the claimed tree already ran this project's worktree.setup at
   * the commit it now has checked out, so the caller must not run it again.
   */
  setupPrepared: boolean;
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
    baseRef?: string;
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
/** Warm trees from before markers were named `.warm-<id>` so a claim could `git worktree move` them. */
const LEGACY_WARM_SLUG_PREFIX = ".warm-";

/**
 * What a tree's setup depends on besides its commit: the setup commands
 * themselves. A claim reuses the provisioning run only when this still matches.
 */
function computeWorktreeSetupFingerprint(worktreePath: string): string {
  return createHash("sha256")
    .update(JSON.stringify(getWorktreeSetupCommands(worktreePath)))
    .digest("hex");
}

/**
 * Record the claim's base on the tree. Rewriting the base metadata drops the
 * runtime section, so the port setup ran with is carried over: the
 * workspace's services must agree with whatever setup baked in.
 */
function writeClaimedWorktreeMetadata(worktreePath: string, sourcePlan: WorktreeSourcePlan): void {
  const provisionedPort = readPaseoWorktreeRuntimePort(worktreePath);
  writePaseoWorktreeMetadata(worktreePath, {
    baseRefName: sourcePlan.metadataBaseRefName,
    ...(sourcePlan.metadataBaseRef ? { baseRef: sourcePlan.metadataBaseRef } : {}),
    ...(sourcePlan.changeRequestLookupTarget
      ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
      : {}),
  });
  if (provisionedPort !== null) {
    writePaseoWorktreeRuntimeMetadata(worktreePath, { worktreePort: provisionedPort });
  }
}

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
  private readonly readConfig?: () => { enabled?: boolean; targetIdle?: number; baseRef?: string };

  private readonly pools = new Map<string, WarmWorktreeRecord[]>();
  private readonly repoLocks = new Map<string, Promise<void>>();
  private readonly inFlightProvisions = new Map<string, Promise<void>>();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private readonly provisionFailures = new Map<string, { count: number; nextAttemptAt: number }>();
  /** Trees handed out by an in-flight claim; still marked until the claim finishes, so discovery must skip them. */
  private readonly claimingPaths = new Set<string>();

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
    // Warm trees are provisioned at their final path under the pool's
    // worktrees root and never moved, so a caller asking for a different root
    // cannot use them.
    const callerBaseRoot = resolvePaseoWorktreesBaseRoot({
      paseoHome: options.paseoHome ?? this.paseoHome,
      worktreesRoot: options.worktreesRoot ?? this.worktreesRoot,
    });
    const poolBaseRoot = resolvePaseoWorktreesBaseRoot({
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
    });
    if (callerBaseRoot !== poolBaseRoot) {
      return null;
    }

    // The caller (createWorktreeCore) already resolved repoRoot through
    // resolveRepoRoot, which throws for non-git paths. Re-checking here ran the
    // full getCheckout snapshot (~10 git subprocesses) on every claim.
    const reserved = await this.withRepoLock(repoRoot, async () => {
      const takeNewestIdle = (): WarmWorktreeRecord | null => {
        const records = this.pools.get(repoRoot) ?? [];
        // Newest first: after the base moves, a freshly provisioned tree sits
        // at the new tip while an older one would need a checkout + setup.
        const candidate = records
          .filter((r) => r.status === "idle" && existsSync(r.worktreePath))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!candidate) {
          return null;
        }
        candidate.status = "claimed";
        this.claimingPaths.add(candidate.worktreePath);
        this.pools.set(
          repoRoot,
          records.filter((r) => r !== candidate),
        );
        return candidate;
      };
      const candidate = takeNewestIdle();
      if (candidate) {
        return candidate;
      }
      await this.discoverExistingWarmWorktrees(repoRoot);
      return takeNewestIdle();
    });

    if (!reserved) {
      void this.replenish(repoRoot).catch(() => undefined);
      return null;
    }
    // The tree's final path is known before any git work, so the caller can
    // start moving an agent process there while the branch is cut.
    try {
      options.onReserved?.(reserved.worktreePath);
    } catch {
      // Best-effort hint; it must never fail the claim.
    }

    // Do not refill until this claim's git work finishes. Starting
    // `git worktree add` + worktree.setup (often a full build) in parallel with
    // the claim's checkout starved live warm-path creates on CPU/IO, and OMP
    // `/move` then missed its budget.
    const claimedAt = this.now().getTime();
    const worktreePath = reserved.worktreePath;
    try {
      const sourcePlan = await resolveWorktreeSourcePlan({
        cwd: repoRoot,
        source: options.source,
        desiredSlug: options.worktreeSlug,
      });

      const headAlreadyAtTarget = await this.applyBranchToClaimedWorktree({
        worktreePath,
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

      writeClaimedWorktreeMetadata(worktreePath, sourcePlan);

      await seedPaseoConfigFile({ sourceCwd: repoRoot, targetCwd: worktreePath });

      // Setup already ran here during provisioning. It is still valid when the
      // claim kept the same commit and the project's setup commands are
      // unchanged; otherwise (stale base, other branch, edited setup) it must
      // run again against what is now checked out.
      const setupPrepared =
        headAlreadyAtTarget &&
        reserved.setupFingerprint !== null &&
        reserved.setupFingerprint === computeWorktreeSetupFingerprint(worktreePath);

      if (options.runSetup === true && !setupPrepared) {
        await runWorktreeSetupCommands({
          worktreePath,
          branchName: sourcePlan.branchName,
          cleanupOnFailure: true,
        });
      }

      // Unmarking makes the tree a regular Paseo worktree, visible in listings.
      removeWarmWorktreeMarker(worktreePath);

      this.logger.info(
        {
          repoRoot,
          worktreePath,
          branchName: sourcePlan.branchName,
          setupPrepared,
          durationMs: this.now().getTime() - claimedAt,
        },
        "Successfully claimed warm worktree",
      );

      void this.replenish(repoRoot).catch(() => undefined);

      return {
        worktree: {
          branchName: sourcePlan.branchName,
          worktreePath,
          comparisonBaseRef: sourcePlan.metadataBaseRef ?? sourcePlan.metadataBaseRefName,
        },
        claimed: true,
        setupPrepared,
      };
    } catch (error) {
      this.logger.error(
        { err: error, repoRoot, warmWorktree: worktreePath },
        "Failed to claim warm worktree; discarding",
      );
      try {
        await this.removeWarmWorktree(repoRoot, worktreePath);
      } catch {
        // ignore
      }
      void this.replenish(repoRoot).catch(() => undefined);
      return null;
    } finally {
      this.claimingPaths.delete(worktreePath);
    }
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
    const base = await this.resolveWarmBase(normalizedRoot);
    const { needed, stale } = await this.withRepoLock(normalizedRoot, async () => {
      await this.discoverExistingWarmWorktrees(normalizedRoot);

      const targetIdle = this.resolveTargetIdle(normalizedRoot);
      const records = this.pools.get(normalizedRoot) ?? [];
      // A tree is fresh while it sits at the base's current tip. When the
      // base cannot be resolved, treat everything as fresh rather than churn.
      const isFresh = (record: WarmWorktreeRecord) =>
        base === null || record.baseSha === base.baseSha;
      const freshIdle = records.filter((r) => r.status === "idle" && isFresh(r)).length;
      const provisioning = records.filter((r) => r.status === "provisioning").length;

      // Stale idle trees stay claimable (a claim checks out the new base and
      // reruns setup) until fresh ones cover the target; then they only cost disk.
      const retired =
        freshIdle >= targetIdle ? records.filter((r) => r.status === "idle" && !isFresh(r)) : [];
      if (retired.length > 0) {
        this.pools.set(
          normalizedRoot,
          records.filter((r) => !retired.includes(r)),
        );
      }

      if (this.isProvisioningBackedOff(normalizedRoot)) return { needed: 0, stale: retired };

      return { needed: Math.max(0, targetIdle - freshIdle - provisioning), stale: retired };
    });

    for (const record of stale) {
      this.logger.info(
        { repoRoot: normalizedRoot, worktreePath: record.worktreePath, baseSha: record.baseSha },
        "Retiring warm worktree left behind by a moved base",
      );
      await this.removeWarmWorktree(normalizedRoot, record.worktreePath);
    }

    // Setup is slow and must not hold the repo lock — claim/create wait on it.
    const started: Array<Promise<void>> = [];
    for (let i = 0; i < needed; i++) {
      if (this.isStopped) break;
      started.push(this.provisionOneWarmWorktree(normalizedRoot));
    }
    await Promise.all([
      ...started,
      this.inFlightProvisions.get(normalizedRoot) ?? Promise.resolve(),
    ]);
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

  private readProjectWarmPoolConfig(repoRoot: string): {
    enabled?: boolean;
    targetIdle?: number;
    baseRef?: string;
  } {
    try {
      const raw = readPaseoConfigJson(repoRoot);
      const parsed = PaseoWorktreeWarmPoolConfigRawSchema.safeParse(
        raw &&
          typeof raw === "object" &&
          "worktree" in raw &&
          raw.worktree &&
          typeof raw.worktree === "object" &&
          "warmPool" in raw.worktree
          ? raw.worktree.warmPool
          : undefined,
      );
      if (!parsed.success) return {};
      return {
        enabled: parsed.data.enabled,
        targetIdle: parsed.data.targetIdle,
        baseRef: parsed.data.baseRef,
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

  private async resolveWarmSourceRef(repoRoot: string): Promise<string> {
    const config = this.readConfig?.();
    if (config?.baseRef) {
      return config.baseRef;
    }
    const projectBaseRef = this.readProjectWarmPoolConfig(repoRoot).baseRef;
    if (projectBaseRef) {
      return projectBaseRef;
    }
    return this.resolveDefaultBranch(repoRoot);
  }

  /** The ref warm trees are cut from and the commit it points at right now. */
  private async resolveWarmBase(
    repoRoot: string,
  ): Promise<{ sourceRef: string; baseSha: string } | null> {
    try {
      const sourceRef = await this.resolveWarmSourceRef(repoRoot);
      const { stdout } = await runGitCommand(
        ["rev-parse", "--verify", "--quiet", `${sourceRef}^{commit}`],
        { cwd: repoRoot, timeout: 5_000 },
      );
      const baseSha = stdout.trim();
      return baseSha ? { sourceRef, baseSha } : null;
    } catch {
      return null;
    }
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

      const existingRecords = this.pools.get(repoRoot) ?? [];
      const updatedRecords: WarmWorktreeRecord[] = [];
      const orphans: string[] = [];
      const listedPaths = new Set<string>();

      for (const entry of worktrees) {
        const worktreePath = normalizePathForOwnership(entry.path);
        listedPaths.add(worktreePath);
        if (this.claimingPaths.has(worktreePath)) {
          // Mid-claim: still marked, but already handed to a workspace.
          continue;
        }
        const existing = existingRecords.find((r) => r.worktreePath === worktreePath);
        if (existing) {
          updatedRecords.push(existing);
          continue;
        }
        const marker = readWarmWorktreeMarker(worktreePath);
        if (marker?.status === "ready") {
          updatedRecords.push({
            repoRoot,
            worktreePath,
            worktreeSlug: basename(worktreePath),
            baseBranch: marker.sourceRef,
            baseSha: marker.baseSha,
            setupFingerprint: marker.setupFingerprint,
            createdAt: marker.createdAt,
            status: "idle",
          });
        } else if (marker || basename(worktreePath).startsWith(LEGACY_WARM_SLUG_PREFIX)) {
          // A provision a previous daemon never finished, or a warm tree from
          // before markers existed (`.warm-*`, named for `git worktree move`).
          orphans.push(worktreePath);
        }
      }

      // In-flight provisions are not in `git worktree list` until the add
      // finishes; keep their slots so a concurrent replenish does not overfill.
      for (const existing of existingRecords) {
        if (
          existing.status === "provisioning" &&
          !updatedRecords.some((r) => r.worktreePath === existing.worktreePath)
        ) {
          updatedRecords.push(existing);
        }
      }

      this.pools.set(repoRoot, updatedRecords);

      const projectRoot = normalizePathForOwnership(
        await getPaseoWorktreesRoot(repoRoot, this.paseoHome, this.worktreesRoot),
      );
      for (const markedPath of listWarmWorktreeMarkedPaths(projectRoot)) {
        const known =
          listedPaths.has(markedPath) || updatedRecords.some((r) => r.worktreePath === markedPath);
        if (!known) {
          removeWarmWorktreeMarker(markedPath);
        }
      }
      for (const orphan of orphans) {
        this.logger.info({ repoRoot, worktreePath: orphan }, "Removing orphaned warm worktree");
        await this.removeWarmWorktree(repoRoot, orphan);
      }
    } catch (error) {
      this.logger.debug({ err: error, repoRoot }, "Failed to discover existing warm worktrees");
    }
  }

  private async provisionOneWarmWorktree(repoRoot: string): Promise<void> {
    const previous = this.inFlightProvisions.get(repoRoot) ?? Promise.resolve();
    const { promise: thisFlight, resolve: releaseInFlight } = Promise.withResolvers<void>();
    const chained = previous.then(() => thisFlight);
    this.inFlightProvisions.set(repoRoot, chained);

    let reserved: WarmWorktreeRecord | null = null;
    try {
      const base = await this.resolveWarmBase(repoRoot);
      if (!base) {
        throw new Error(`Cannot resolve the warm worktree base ref for ${repoRoot}`);
      }
      const { sourceRef, baseSha } = base;
      reserved = await this.withRepoLock(repoRoot, async () => {
        const records = this.pools.get(repoRoot) ?? [];
        const freshCount = records.filter(
          (r) => r.status === "provisioning" || (r.status === "idle" && r.baseSha === baseSha),
        ).length;
        if (freshCount >= this.resolveTargetIdle(repoRoot)) {
          return null;
        }

        // Provision at the final path: a claim only switches the branch, so
        // trees with submodules (which `git worktree move` refuses) pool too.
        // Resolve the parent before naming the tree so the recorded path
        // matches the realpath `git worktree list` reports even when the
        // worktrees root sits behind a symlink.
        const unresolvedRoot = await getPaseoWorktreesRoot(
          repoRoot,
          this.paseoHome,
          this.worktreesRoot,
        );
        mkdirSync(unresolvedRoot, { recursive: true });
        const projectRoot = normalizePathForOwnership(unresolvedRoot);
        let slug = createNameId();
        while (
          existsSync(join(projectRoot, slug)) ||
          readWarmWorktreeMarker(join(projectRoot, slug))
        ) {
          slug = createNameId();
        }
        const createdAt = this.now().toISOString();
        const next: WarmWorktreeRecord = {
          repoRoot,
          worktreePath: join(projectRoot, slug),
          worktreeSlug: slug,
          baseBranch: sourceRef,
          baseSha,
          setupFingerprint: null,
          createdAt,
          status: "provisioning",
        };
        // Marked before `git worktree add` so listings never show the tree,
        // not even while git's checkout hooks run inside the add.
        writeWarmWorktreeMarker(next.worktreePath, {
          version: 1,
          status: "provisioning",
          sourceRef,
          baseSha,
          setupFingerprint: null,
          createdAt,
        });
        records.push(next);
        this.pools.set(repoRoot, records);
        return next;
      });
      if (!reserved) {
        return;
      }
      const record = reserved;

      this.logger.info(
        { repoRoot, warmSlug: record.worktreeSlug, sourceRef, baseSha },
        "Provisioning idle warm worktree",
      );

      await runWithGitCommandPriority("normal", async () => {
        await runGitCommand(["worktree", "add", "--detach", record.worktreePath, baseSha], {
          cwd: repoRoot,
          timeout: 120_000,
        });
      });

      await seedPaseoConfigFile({ sourceCwd: repoRoot, targetCwd: record.worktreePath });
      // Metadata first: setup resolves PASEO_WORKTREE_PORT and persists it into
      // the metadata, and the claim keeps that port, so whatever setup baked in
      // (an .env, a dev-server config) still matches the workspace's services.
      writePaseoWorktreeMetadata(record.worktreePath, {
        baseRefName: sourceRef,
      });

      await runWorktreeSetupCommands({
        worktreePath: record.worktreePath,
        branchName: sourceRef,
        cleanupOnFailure: true,
      });
      const setupFingerprint = computeWorktreeSetupFingerprint(record.worktreePath);

      writeWarmWorktreeMarker(record.worktreePath, {
        version: 1,
        status: "ready",
        sourceRef,
        baseSha,
        setupFingerprint,
        createdAt: record.createdAt,
      });

      record.setupFingerprint = setupFingerprint;
      record.status = "idle";
      this.logger.info(
        { repoRoot, warmWorktreePath: record.worktreePath, sourceRef, baseSha },
        "Warm worktree provisioned successfully",
      );
      this.recordProvisionOutcome(repoRoot, true);
    } catch (error) {
      this.logger.warn(
        { err: error, repoRoot, warmWorktreePath: reserved?.worktreePath },
        "Failed to provision warm worktree; cleaning up",
      );
      if (reserved) {
        const toRemove = reserved;
        await this.withRepoLock(repoRoot, async () => {
          const records = this.pools.get(repoRoot) ?? [];
          const index = records.indexOf(toRemove);
          if (index !== -1) {
            records.splice(index, 1);
          }
        });
        await this.removeWarmWorktree(repoRoot, toRemove.worktreePath);
      }
      this.recordProvisionOutcome(repoRoot, false);
    } finally {
      releaseInFlight();
      if (this.inFlightProvisions.get(repoRoot) === chained) {
        this.inFlightProvisions.delete(repoRoot);
      }
    }
  }

  // Translates sourcePlan.addArguments (the exact argv resolveWorktreeSourcePlan built
  // for `git worktree add`) into the equivalent `git checkout` invocation. Reusing the
  // same resolved arguments — rather than re-deriving base/branch decisions from the
  // original WorktreeSource — keeps the warm and cold paths provably in sync: any branch
  // name collision, remote-only base, or already-fetched PR/change-request branch that
  // resolveWorktreeSourcePlan accounted for is honored identically here. Returns true
  // when the tree was already at the target commit, so its files (and setup) are unchanged.
  private async applyBranchToClaimedWorktree(options: {
    worktreePath: string;
    sourcePlan: WorktreeSourcePlan;
  }): Promise<boolean> {
    const { worktreePath, sourcePlan } = options;
    const args = sourcePlan.addArguments;
    const targetRef = args[0] === "-b" ? args[3] : args[0];
    // Warm worktrees sit detached at baseRef. Checking out that same SHA
    // (paseo.json `worktree.warmPool.baseRef` matching the requested branch)
    // must not rewrite the working tree — `git checkout` of a large monorepo
    // is the remaining multi-second cost after origin-fetch left the claim path.
    if (targetRef && (await this.worktreeHeadMatchesRef(worktreePath, targetRef))) {
      if (args[0] === "-b") {
        await runGitCommand(["switch", "-c", args[1], "--no-track"], {
          cwd: worktreePath,
          timeout: 15_000,
        });
      } else {
        await runGitCommand(["switch", "--no-guess", args[0]], {
          cwd: worktreePath,
          timeout: 15_000,
        });
      }
      return true;
    }
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
    return false;
  }

  private async worktreeHeadMatchesRef(worktreePath: string, ref: string): Promise<boolean> {
    try {
      const [head, target] = await Promise.all([
        runGitCommand(["rev-parse", "HEAD"], { cwd: worktreePath, timeout: 5_000 }),
        runGitCommand(["rev-parse", `${ref}^{commit}`], { cwd: worktreePath, timeout: 5_000 }),
      ]);
      const headSha = head.stdout.trim();
      const targetSha = target.stdout.trim();
      return headSha.length > 0 && headSha === targetSha;
    } catch {
      return false;
    }
  }

  /** Delete a pool tree (failed provision or claim, stale, orphaned) and its marker. */
  private async removeWarmWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    removeWarmWorktreeMarker(worktreePath);
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
