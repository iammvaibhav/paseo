import type { PluginLifecycle } from "../../plugins/lifecycle/index.js";
import { describeHookWorkspace } from "../../plugins/lifecycle/index.js";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import {
  generateWorkspaceId,
  initialWorkspacePlacement,
  reconcileWorkspacePlacement,
} from "../../workspace-registry-model.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { deriveProjectKey } from "../../project-key.js";
import {
  areEquivalentPaths,
  canonicalizePath,
  createRealpathAwarePathMatcher,
} from "../../../utils/path.js";
import type { UntrustedWorkspaceSource } from "../../workspace-automation-gate.js";
import type { PhaseTimer } from "../../../utils/phase-timer.js";

export interface ResolveOrCreateWorkspaceIdInput {
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  requestedWorkspaceId?: string;
  cwd: string;
  initialTitle: string | null;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface ImportWorkspaceInput {
  cwd: string;
  requestedWorkspaceId?: string;
}

export interface ImportWorkspaceResult<T> {
  value: T;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

export interface CreateWorktreeWorkspaceInput {
  sourceCwd: string;
  projectId?: string;
  workspaceId?: string;
  repoRoot: string;
  cwd: string;
  worktreeRoot: string;
  branch: string | null;
  baseBranch: string | null;
  title: string | null;
  expectsInitialAgent?: boolean;
  untrustedSource?: UntrustedWorkspaceSource;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface WorkspaceProvisioningService {
  runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>>;
  findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord>;
  resolveOrCreateWorkspaceIdForCreateAgent(input: ResolveOrCreateWorkspaceIdInput): Promise<string>;
  createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: {
      expectsInitialAgent?: boolean;
      workspaceId?: string;
      background?: boolean;
      callerWorkspaceId?: string;
    },
  ): Promise<PersistedWorkspaceRecord>;
  createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
    options?: { timer?: PhaseTimer },
  ): Promise<PersistedWorkspaceRecord>;
  findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord>;
  ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord>;
}

export type WorkspaceProvisioningErrorCode = "unknown_project" | "archived_project";

export class WorkspaceProvisioningError extends Error {
  constructor(
    readonly code: WorkspaceProvisioningErrorCode,
    projectId: string,
  ) {
    super(
      code === "unknown_project"
        ? `Unknown project: ${projectId}`
        : `Archived project: ${projectId}`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

export function createWorkspaceProvisioningService(deps: {
  serverId?: string;
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout" | "getSnapshot" | "peekSnapshot">;
  isDirectory: (path: string) => Promise<boolean>;
  logger: Logger;
  lifecycle?: PluginLifecycle;
  /** The daemon's paseo home; no project is recreated at it or any folder above it. */
  paseoHome?: string;
  /** The host's scratch project, where an orphaned workspace at such a folder is restored. */
  getScratchProject?: () => Promise<PersistedProjectRecord>;
}): WorkspaceProvisioningService {
  const { serverId, workspaceRegistry, projectRegistry, workspaceGitService, logger } = deps;

  /**
   * A project rooted at the home directory or above the paseo home would
   * enclose the Commander's home workspace (see system-owned.ts), so it is
   * never created implicitly.
   */
  function enclosesDaemonHome(root: string): boolean {
    const canonicalRoot = canonicalizePath(root);
    if (areEquivalentPaths(canonicalRoot, canonicalizePath(homedir()))) return true;
    if (!deps.paseoHome) return false;
    const paseoHome = canonicalizePath(deps.paseoHome);
    const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    return areEquivalentPaths(canonicalRoot, paseoHome) || paseoHome.startsWith(prefix);
  }

  /**
   * The project an archived workspace is restored into when its own project
   * record is gone (a removed project, or a pruned legacy path-keyed one):
   * one at the workspace's root, or the scratch project when that root holds
   * the paseo home. A workspace at the root becomes the new project's base
   * workspace, so the base-workspace listener never mints a duplicate.
   */
  async function projectForOrphanedWorkspace(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedProjectRecord> {
    const root = workspace.mainRepoRoot ?? workspace.cwd;
    if (!enclosesDaemonHome(root)) {
      return findOrCreateProjectForDirectory(
        root,
        areEquivalentPaths(root, workspace.cwd) ? workspace.workspaceId : undefined,
      );
    }
    if (!deps.getScratchProject) {
      throw new Error(
        `The project for this workspace no longer exists, and ${root} cannot become a project because it holds the Paseo home.`,
      );
    }
    return deps.getScratchProject();
  }

  /**
   * Placement facts at a workspace directory, or null when there is nothing
   * there to read. A git read answers "not a checkout" for a plain directory
   * and for a directory that is gone, and only the first is evidence that a
   * worktree stopped being one. That answer therefore counts only while the
   * directory is there on both sides of the read, so a worktree removed or
   * unmounted while the read is in flight stays an absence.
   */
  async function observeWorkspaceCheckout(cwd: string): Promise<ProjectCheckoutLitePayload | null> {
    if (!(await deps.isDirectory(cwd))) return null;
    const checkout = await workspaceGitService.getCheckout(cwd);
    if (!checkout.isGit && !(await deps.isDirectory(cwd))) return null;
    return checkout;
  }

  async function runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>> {
    if (input.requestedWorkspaceId) {
      const workspace = await workspaceRegistry.get(input.requestedWorkspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${input.requestedWorkspaceId}`);
      }
      const project = await projectRegistry.get(workspace.projectId);
      if (!project || project.archivedAt) {
        throw new Error(`Project not found: ${workspace.projectId}`);
      }
      if (!createRealpathAwarePathMatcher(workspace.cwd)(input.cwd)) {
        throw new Error(`Import cwd does not match workspace: ${workspace.workspaceId}`);
      }
      return {
        value: await operation(workspace),
        createdWorkspace: null,
      };
    }

    const [projectsBeforeImport, workspacesBeforeImport] = await Promise.all([
      projectRegistry.list(),
      workspaceRegistry.list(),
    ]);
    const workspace = await findOrCreateWorkspaceForDirectory(input.cwd);
    const createdWorkspace = workspacesBeforeImport.some(
      (candidate) => candidate.workspaceId === workspace.workspaceId,
    )
      ? null
      : workspace;
    const previousProject =
      projectsBeforeImport.find((project) => project.projectId === workspace.projectId) ?? null;

    try {
      return {
        value: await operation(workspace),
        createdWorkspace,
      };
    } catch (error) {
      if (createdWorkspace) {
        await rollbackFailedImportWorkspace(createdWorkspace, previousProject);
      }
      throw error;
    }
  }

  async function rollbackFailedImportWorkspace(
    workspace: PersistedWorkspaceRecord,
    previousProject: PersistedProjectRecord | null,
  ): Promise<void> {
    try {
      await workspaceRegistry.remove(workspace.workspaceId);
      const projectHasActiveWorkspace = (await workspaceRegistry.list()).some(
        (candidate) => candidate.projectId === workspace.projectId && !candidate.archivedAt,
      );
      if (projectHasActiveWorkspace) {
        return;
      }
      if (previousProject?.archivedAt) {
        await projectRegistry.upsert(previousProject);
      } else if (!previousProject) {
        await projectRegistry.remove(workspace.projectId);
      }
    } catch (error) {
      logger.error(
        { err: error, workspaceId: workspace.workspaceId, projectId: workspace.projectId },
        "Failed to restore workspace state after provider import failure",
      );
    }
  }

  async function findOrCreateProjectForDirectory(
    cwd: string,
    baseWorkspaceId?: string,
  ): Promise<PersistedProjectRecord> {
    const rootPath = canonicalizePath(cwd);
    const checkout = await workspaceGitService.getCheckout(rootPath);
    const timestamp = new Date().toISOString();
    return projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: checkout.isGit ? "git" : "non_git",
      displayName: basename(rootPath) || rootPath,
      projectKey: deriveProjectKey({
        rootPath,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      ...(baseWorkspaceId ? { baseWorkspaceId } : {}),
      timestamp,
    });
  }

  async function requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const project = await projectRegistry.get(projectId);
    if (!project) throw new WorkspaceProvisioningError("unknown_project", projectId);
    if (project.archivedAt) throw new WorkspaceProvisioningError("archived_project", projectId);
    return project;
  }

  async function resolveBackground(input?: {
    background?: boolean;
    callerWorkspaceId?: string;
  }): Promise<boolean> {
    if (input?.background !== undefined) return input.background;
    if (!input?.callerWorkspaceId) return false;
    const callerWorkspace = await workspaceRegistry.get(input.callerWorkspaceId);
    if (!callerWorkspace) throw new Error(`Caller workspace ${input.callerWorkspaceId} not found`);
    return callerWorkspace.background;
  }

  async function createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: {
      expectsInitialAgent?: boolean;
      workspaceId?: string;
      background?: boolean;
      callerWorkspaceId?: string;
    },
  ): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = canonicalizePath(cwd);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    const project = projectId
      ? await refreshProjectKind(await requireActiveProject(projectId), normalizedCwd, checkout)
      : // COMPAT(workspaceCreateMissingProjectId): added in v0.1.107, remove after 2027-01-15.
        await findOrCreateProjectForDirectory(normalizedCwd);
    const timestamp = new Date().toISOString();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: context?.workspaceId ?? generateWorkspaceId(),
      projectId: project.projectId,
      ...initialWorkspacePlacement({ source: "checkout", cwd: normalizedCwd, checkout }),
      title: title?.trim() || null,
      createdAt: timestamp,
      updatedAt: timestamp,
      background: await resolveBackground(context),
    });
    await workspaceRegistry.upsert(workspace, {
      expectsInitialAgent: context?.expectsInitialAgent,
    });
    emitWorkspaceCreated(workspace);
    return workspace;
  }

  async function createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
    options?: { timer?: PhaseTimer },
  ): Promise<PersistedWorkspaceRecord> {
    const sourceCwd = canonicalizePath(input.sourceCwd);
    const repoRoot = canonicalizePath(input.repoRoot);
    const cwd = canonicalizePath(input.cwd);
    const worktreeRoot = canonicalizePath(input.worktreeRoot);
    const project = await resolveSourceProjectForWorktree({
      sourceCwd,
      projectId: input.projectId,
      repoRoot,
    });
    options?.timer?.mark("resolveProjectMs");
    const timestamp = new Date().toISOString();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: input.workspaceId ?? generateWorkspaceId(),
      projectId: project.projectId,
      ...initialWorkspacePlacement({
        source: "created_worktree",
        cwd,
        worktreeRoot,
        branch: input.branch,
        baseBranch: input.baseBranch,
        mainRepoRoot: repoRoot,
      }),
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.untrustedSource ? { untrustedSource: input.untrustedSource } : {}),
      background: await resolveBackground(input),
    });
    await workspaceRegistry.upsert(workspace, {
      expectsInitialAgent: input.expectsInitialAgent,
      ...(options?.timer ? { timer: options.timer } : {}),
    });
    emitWorkspaceCreated(workspace);
    options?.timer?.mark("lifecycleMs");
    return workspace;
  }

  function emitWorkspaceCreated(workspace: PersistedWorkspaceRecord): void {
    deps.lifecycle?.emit("workspace.create.after", {
      workspace: describeHookWorkspace(workspace),
    });
  }

  async function resolveSourceProjectForWorktree(input: {
    sourceCwd: string;
    projectId?: string;
    repoRoot: string;
  }): Promise<PersistedProjectRecord> {
    if (input.projectId) {
      const project = await requireActiveProject(input.projectId);
      // An explicit FK may point at a project rooted somewhere else entirely;
      // only that rare case still needs a probe of the project's own root.
      if (!areEquivalentPaths(canonicalizePath(project.rootPath), input.repoRoot)) {
        return refreshProjectKind(project);
      }
      return markProjectGitForCreatedWorktree(project);
    }

    // Registry records may predate canonicalization and hold a symlink spelling.
    const workspaces = await workspaceRegistry.list();
    const sourceWorkspace =
      workspaces.find(
        (workspace) =>
          !workspace.archivedAt &&
          areEquivalentPaths(canonicalizePath(workspace.cwd), input.sourceCwd),
      ) ??
      workspaces.find(
        (workspace) =>
          !workspace.archivedAt &&
          areEquivalentPaths(canonicalizePath(workspace.cwd), input.repoRoot),
      );
    if (sourceWorkspace) {
      const project = await projectRegistry.get(sourceWorkspace.projectId);
      if (project) {
        return areEquivalentPaths(canonicalizePath(project.rootPath), input.repoRoot)
          ? markProjectGitForCreatedWorktree(project)
          : project;
      }
      // COMPAT(worktreeMissingSourceProject): added in v0.1.107, remove after 2027-01-15.
      // Orphaned legacy workspace FKs fall through to exact-root allocation.
    }

    // PASEO-16: never shell out for a full checkout snapshot on the create path —
    // that made a warm-pool claim's "instant" worktree look like a 2s workspace.create.
    // Reuse whatever the git service already knows about this repo root in memory;
    // an absent snapshot falls back to a local-path-derived (not remote-derived)
    // project key rather than blocking on a fresh `git remote`/`git rev-parse` round
    // trip. The periodic workspace refresh reconciles the remote-derived identity
    // once the snapshot is warm.
    const cachedSnapshot = workspaceGitService.peekSnapshot(input.repoRoot);
    return projectRegistry.getOrCreateActiveByRoot({
      rootPath: input.repoRoot,
      kind: "git",
      displayName: basename(input.repoRoot) || input.repoRoot,
      projectKey: deriveProjectKey({
        rootPath: input.repoRoot,
        remoteUrl: cachedSnapshot?.git.remoteUrl ?? null,
        worktreeRoot: cachedSnapshot?.git.repoRoot ?? null,
        mainRepoRoot: cachedSnapshot?.git.mainRepoRoot ?? null,
        serverId,
      }),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * A worktree was just cut from this project's root, so the root is git. A
   * full checkout probe here (status, remotes, ahead/behind) cost 1-5s per
   * create under load (PASEO-16); a project still recorded as non-git is
   * rewritten from what the git service already holds in memory, and the
   * periodic workspace refresh reconciles the remote-derived identity later.
   */
  async function markProjectGitForCreatedWorktree(
    project: PersistedProjectRecord,
  ): Promise<PersistedProjectRecord> {
    if (project.kind === "git") return project;
    const cachedSnapshot = workspaceGitService.peekSnapshot(project.rootPath);
    const refreshed: PersistedProjectRecord = {
      ...project,
      kind: "git",
      projectKey: deriveProjectKey({
        rootPath: project.rootPath,
        remoteUrl: cachedSnapshot?.git.remoteUrl ?? null,
        worktreeRoot: cachedSnapshot?.git.repoRoot ?? null,
        mainRepoRoot: cachedSnapshot?.git.mainRepoRoot ?? null,
        serverId,
      }),
      updatedAt: new Date().toISOString(),
    };
    await projectRegistry.upsert(refreshed);
    return refreshed;
  }

  async function findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = canonicalizePath(cwd);
    // Path-based discovery selects public work; explicit-ID recovery bypasses this selector.
    // Records may predate canonicalization and hold a symlink spelling.
    const workspaces = (await workspaceRegistry.list())
      .filter(
        (workspace) =>
          !workspace.background &&
          areEquivalentPaths(canonicalizePath(workspace.cwd), normalizedCwd),
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      );
    const active = workspaces.find((workspace) => !workspace.archivedAt);
    if (active) return refreshWorkspaceRecord(active);
    const archived = workspaces.find((workspace) => workspace.archivedAt);
    if (archived) {
      const project = await projectRegistry.get(archived.projectId);
      if (project && !project.archivedAt) return ensureWorkspaceRecordUnarchived(archived);
    }
    return createWorkspaceForDirectory(normalizedCwd);
  }

  async function resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<string> {
    if (input.createdWorktree) return input.createdWorktree.workspace.workspaceId;
    if (input.requestedWorkspaceId) return input.requestedWorkspaceId;
    // Background work always gets its own workspace; public work reuses the
    // directory's workspace instead of adding one per agent.
    if (await resolveBackground(input)) {
      return (
        await createWorkspaceForDirectory(input.cwd, input.initialTitle, undefined, {
          expectsInitialAgent: true,
          background: true,
        })
      ).workspaceId;
    }
    const existing = await findOrCreateWorkspaceForDirectory(input.cwd);
    if (input.initialTitle && !existing.title) {
      await workspaceRegistry.upsert({ ...existing, title: input.initialTitle.trim() });
    }
    return existing.workspaceId;
  }

  async function resolveRestoredAutoArchiveChangeRequestUrl(
    workspace: PersistedWorkspaceRecord,
  ): Promise<string | null> {
    if (!workspace.archivedAt) {
      return workspace.autoArchivedChangeRequestUrl;
    }
    const snapshot = await workspaceGitService.getSnapshot(workspace.cwd, {
      force: true,
      includeForge: true,
      reason: "workspace-restore-auto-archive-latch",
    });
    return snapshot.forge.pullRequest?.isMerged
      ? snapshot.forge.pullRequest.url
      : workspace.autoArchivedChangeRequestUrl;
  }

  async function ensureWorkspaceRecordUnarchived(
    archivedWorkspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    let workspace = archivedWorkspace;
    let project = await projectRegistry.get(workspace.projectId);
    const rehomed = !project;
    if (!project) {
      project = await projectForOrphanedWorkspace(workspace);
      workspace = { ...workspace, projectId: project.projectId };
    }
    const timestamp = new Date().toISOString();
    const checkout =
      workspace.archivedAt || project.archivedAt
        ? await observeWorkspaceCheckout(workspace.cwd)
        : null;
    const autoArchivedChangeRequestUrl =
      await resolveRestoredAutoArchiveChangeRequestUrl(workspace);
    let next: PersistedWorkspaceRecord | null = null;
    if (workspace.archivedAt) {
      const placementUpdate = reconcileWorkspacePlacement({
        workspace,
        checkout,
        updatedAt: timestamp,
      });
      next = {
        ...(placementUpdate?.workspace ?? workspace),
        archivedAt: null,
        autoArchivedChangeRequestUrl,
        updatedAt: timestamp,
      };
    }
    if (project.archivedAt || workspace.archivedAt) {
      const projectCheckout =
        checkout && areEquivalentPaths(project.rootPath, workspace.cwd)
          ? checkout
          : await workspaceGitService.getCheckout(project.rootPath);
      const kind = projectCheckout.isGit ? "git" : "non_git";
      const projectKey = deriveProjectKey({
        rootPath: project.rootPath,
        remoteUrl: projectCheckout.remoteUrl,
        worktreeRoot: projectCheckout.worktreeRoot,
        mainRepoRoot: projectCheckout.mainRepoRoot,
        serverId,
      });
      if (project.archivedAt || project.kind !== kind || project.projectKey !== projectKey) {
        await projectRegistry.upsert({
          ...project,
          kind,
          projectKey,
          archivedAt: null,
          updatedAt: timestamp,
        });
      }
    }
    if (!next && !rehomed) return workspace;
    next ??= { ...workspace, updatedAt: timestamp };
    await workspaceRegistry.upsert(next);
    return next;
  }

  async function refreshWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const checkout = await observeWorkspaceCheckout(workspace.cwd);
    const project = await projectRegistry.get(workspace.projectId);
    if (project && !project.archivedAt) {
      await refreshProjectKind(project, workspace.cwd, checkout ?? undefined);
    }
    const update = reconcileWorkspacePlacement({
      workspace,
      checkout,
      updatedAt: new Date().toISOString(),
    });
    if (!update) return workspace;
    await workspaceRegistry.upsert(update.workspace);
    return update.workspace;
  }

  async function refreshProjectKind(
    project: PersistedProjectRecord,
    workspaceCwd?: string,
    workspaceCheckout?: Awaited<ReturnType<WorkspaceGitService["getCheckout"]>>,
  ): Promise<PersistedProjectRecord> {
    const projectCheckout =
      workspaceCwd && workspaceCheckout && areEquivalentPaths(project.rootPath, workspaceCwd)
        ? workspaceCheckout
        : await workspaceGitService.getCheckout(project.rootPath);
    const kind: PersistedProjectRecord["kind"] = projectCheckout.isGit ? "git" : "non_git";
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: projectCheckout.remoteUrl,
      worktreeRoot: projectCheckout.worktreeRoot,
      mainRepoRoot: projectCheckout.mainRepoRoot,
      serverId,
    });
    if (project.kind === kind && project.projectKey === projectKey) return project;
    const refreshed = {
      ...project,
      kind,
      projectKey,
      updatedAt: new Date().toISOString(),
    };
    await projectRegistry.upsert(refreshed);
    return refreshed;
  }

  return {
    runInImportWorkspace,
    findOrCreateWorkspaceForDirectory,
    resolveOrCreateWorkspaceIdForCreateAgent,
    createWorkspaceForDirectory,
    createWorkspaceForWorktree,
    findOrCreateProjectForDirectory,
    ensureWorkspaceRecordUnarchived,
  };
}
