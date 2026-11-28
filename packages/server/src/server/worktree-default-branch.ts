import type { ComposerPreferences } from "@getpaseo/protocol/composer-preferences";
import { areEquivalentPaths } from "../utils/path.js";
import { getWorktreeConfiguredBaseRef } from "../utils/worktree.js";
import { resolveRememberedBaseBranch } from "./mission-control/context.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectRegistry } from "./workspace-registry.js";
import { preferOriginDefaultBranch } from "./worktree-core.js";

export interface WorktreeDefaultBranchResolutionDeps {
  daemonConfigStore?: { get(): { composerPreferences?: ComposerPreferences | null } };
  projectRegistry?: Pick<ProjectRegistry, "list">;
  workspaceGitService: Pick<
    WorkspaceGitService,
    "resolveDefaultBranch" | "hasOriginTrackingBranch"
  >;
  readConfiguredBaseRef?: (repoRoot: string) => Promise<string | undefined> | string | undefined;
}

/**
 * The ref a new worktree is cut from when the create request names no base,
 * highest precedence first: paseo.json `worktree.warmPool.baseRef` -> the
 * user's remembered base branch -> the repository default branch (its
 * `origin/` tracking ref when one exists). Every create path without an
 * explicit base uses this, so the warm pool (which cuts its trees from the
 * same ref) can hand back a tree whose setup already ran.
 */
export async function resolveWorktreeDefaultBranch(
  repoRoot: string,
  deps: WorktreeDefaultBranchResolutionDeps,
): Promise<string> {
  const configuredBaseRef = (
    await (deps.readConfiguredBaseRef
      ? deps.readConfiguredBaseRef(repoRoot)
      : getWorktreeConfiguredBaseRef(repoRoot))
  )?.trim();
  if (configuredBaseRef) {
    return configuredBaseRef;
  }

  const composerPrefs = deps.daemonConfigStore?.get().composerPreferences;
  let project = null;
  try {
    const list = await deps.projectRegistry?.list();
    project = list?.find((p) => areEquivalentPaths(p.rootPath, repoRoot)) ?? null;
  } catch {
    // ignore
  }
  const remembered = resolveRememberedBaseBranch(composerPrefs, {
    projectId: project?.projectId,
    projectKey: project?.projectKey,
  });
  if (remembered) {
    return remembered;
  }

  const defaultBranch = await deps.workspaceGitService.resolveDefaultBranch(repoRoot);
  return preferOriginDefaultBranch(repoRoot, defaultBranch, deps.workspaceGitService);
}
