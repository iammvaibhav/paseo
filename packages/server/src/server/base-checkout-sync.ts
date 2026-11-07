import type { Logger } from "pino";

import { runGitCommand } from "../utils/run-git-command.js";
import { branchNameFromRef } from "../utils/worktree-metadata.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type {
  PersistedProjectRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

/** How often the service scans projects for a base checkout that is due for a sync. */
const BASE_CHECKOUT_SYNC_TICK_INTERVAL_MS = 30_000;
/** How long a base checkout goes between periodic `git fetch origin` calls. */
const BASE_CHECKOUT_SYNC_DUE_INTERVAL_MS = 5 * 60_000;
/**
 * Budget for the periodic fetch and fast-forward merge. Generous relative to dispatch's 3s
 * budget (worktree-core.ts) because this runs off the critical path, on a background tick.
 */
const BASE_CHECKOUT_SYNC_GIT_TIMEOUT_MS = 20_000;

type SyncAgentManager = Pick<AgentManager, "hasInFlightRun">;
type SyncAgentStorage = Pick<AgentStorage, "listByWorkspace">;
type SyncProjectRegistry = Pick<ProjectRegistry, "list">;
type SyncWorkspaceRegistry = Pick<WorkspaceRegistry, "get">;
type SyncWorkspaceGitService = Pick<WorkspaceGitService, "getSnapshot" | "resolveDefaultBranch">;

export interface BaseCheckoutSyncServiceOptions {
  logger: Logger;
  projectRegistry: SyncProjectRegistry;
  workspaceRegistry: SyncWorkspaceRegistry;
  workspaceGitService: SyncWorkspaceGitService;
  agentStorage: SyncAgentStorage;
  agentManager: SyncAgentManager;
  now?: () => number;
  tickIntervalMs?: number;
  dueIntervalMs?: number;
  gitTimeoutMs?: number;
}

/**
 * ADR 0001's sync contract for base checkouts: every project-anchored base workspace (the
 * workspace over the project's root checkout) gets a periodic `git fetch origin`, and its
 * working tree fast-forwards only when it is clean and no agent in that workspace is mid-turn.
 *
 * One unref'd tick scans every active project's base workspace each pass (the warm-pool shape,
 * providers/omp/warm-pool.ts:177 — one timer, N owned targets) rather than a per-project
 * `setInterval`, so the timer count stays flat as projects grow.
 */
export class BaseCheckoutSyncService {
  private readonly logger: Logger;
  private readonly projectRegistry: SyncProjectRegistry;
  private readonly workspaceRegistry: SyncWorkspaceRegistry;
  private readonly workspaceGitService: SyncWorkspaceGitService;
  private readonly agentStorage: SyncAgentStorage;
  private readonly agentManager: SyncAgentManager;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly dueIntervalMs: number;
  private readonly gitTimeoutMs: number;
  /** Last fetch-attempt timestamp per base workspace id; in-memory only, resets on restart. */
  private readonly lastAttemptAtMs = new Map<string, number>();
  /** Base workspace ids with a sync in flight, so a slow fetch never overlaps its own retry. */
  private readonly syncing = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(options: BaseCheckoutSyncServiceOptions) {
    this.logger = options.logger.child({ module: "base-checkout-sync" });
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.agentStorage = options.agentStorage;
    this.agentManager = options.agentManager;
    this.now = options.now ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? BASE_CHECKOUT_SYNC_TICK_INTERVAL_MS;
    this.dueIntervalMs = options.dueIntervalMs ?? BASE_CHECKOUT_SYNC_DUE_INTERVAL_MS;
    this.gitTimeoutMs = options.gitTimeoutMs ?? BASE_CHECKOUT_SYNC_GIT_TIMEOUT_MS;
  }

  start(): void {
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error({ err: error }, "Base checkout sync tick failed");
      });
    }, this.tickIntervalMs);
    timer.unref?.();
    this.tickTimer = timer;
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Runs one scan synchronously; exposed for tests instead of waiting on the tick timer. */
  async runTickForTest(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    const nowMs = this.now();
    const projects = await this.projectRegistry.list();
    const due = projects.filter((project) => this.isDue(project, nowMs));
    await Promise.all(due.map((project) => this.syncProject(project, nowMs)));
  }

  private isDue(project: PersistedProjectRecord, nowMs: number): boolean {
    const baseWorkspaceId = project.baseWorkspaceId;
    if (project.archivedAt || !baseWorkspaceId || this.syncing.has(baseWorkspaceId)) {
      return false;
    }
    const lastAttempt = this.lastAttemptAtMs.get(baseWorkspaceId);
    return lastAttempt === undefined || nowMs - lastAttempt >= this.dueIntervalMs;
  }

  private async syncProject(project: PersistedProjectRecord, nowMs: number): Promise<void> {
    const baseWorkspaceId = project.baseWorkspaceId;
    if (!baseWorkspaceId) {
      return;
    }
    this.syncing.add(baseWorkspaceId);
    this.lastAttemptAtMs.set(baseWorkspaceId, nowMs);
    try {
      await this.syncBaseWorkspace(project.projectId, baseWorkspaceId);
    } catch (error) {
      // Soft-fail: a base checkout sync failure must never take down the daemon or block
      // dispatch; the next tick tries again.
      this.logger.warn(
        { err: error, projectId: project.projectId, baseWorkspaceId },
        "Base checkout sync failed",
      );
    } finally {
      this.syncing.delete(baseWorkspaceId);
    }
  }

  private async syncBaseWorkspace(projectId: string, baseWorkspaceId: string): Promise<void> {
    const workspace = await this.workspaceRegistry.get(baseWorkspaceId);
    if (!workspace || workspace.archivedAt) {
      return;
    }
    const cwd = workspace.cwd;
    const snapshot = await this.workspaceGitService.getSnapshot(cwd).catch(() => null);
    if (!snapshot?.git.isGit) {
      return;
    }

    const fetchResult = await runGitCommand(["fetch", "origin"], {
      cwd,
      timeout: this.gitTimeoutMs,
      acceptExitCodes: [0, 1, 128],
    }).catch((error: unknown) => {
      this.logger.debug({ err: error, projectId, cwd }, "Base checkout fetch failed");
      return null;
    });
    if (!fetchResult || fetchResult.exitCode !== 0) {
      return;
    }

    await this.tryFastForward(projectId, baseWorkspaceId, cwd);
  }

  /**
   * Fast-forwards the base checkout's working tree onto origin's default branch. Only safe
   * when the tree is clean and idle, so a re-read right before the merge (not the pre-fetch
   * snapshot, which can be tens of seconds stale by the time the fetch resolves) is required.
   */
  private async tryFastForward(
    projectId: string,
    baseWorkspaceId: string,
    cwd: string,
  ): Promise<void> {
    const freshSnapshot = await this.workspaceGitService.getSnapshot(cwd, {
      force: true,
      reason: "base-checkout-sync",
    });
    if (freshSnapshot.git.isDirty !== false) {
      return;
    }
    if (await this.hasInFlightAgentRun(baseWorkspaceId)) {
      return;
    }

    const defaultBranch = await this.workspaceGitService.resolveDefaultBranch(cwd);
    const branchName = branchNameFromRef(defaultBranch);
    if (!branchName || branchName === "HEAD") {
      return;
    }

    await runGitCommand(["merge", "--ff-only", `refs/remotes/origin/${branchName}`], {
      cwd,
      timeout: this.gitTimeoutMs,
      acceptExitCodes: [0, 1, 128],
    }).catch((error: unknown) => {
      this.logger.debug(
        { err: error, projectId, baseWorkspaceId, cwd, branchName },
        "Base checkout fast-forward failed",
      );
    });
  }

  private async hasInFlightAgentRun(workspaceId: string): Promise<boolean> {
    const agents = await this.agentStorage.listByWorkspace(workspaceId);
    return agents.some((agent) => this.agentManager.hasInFlightRun(agent.id));
  }
}
