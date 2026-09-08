import { createNameId } from "mnemonic-id";

import type { ForgeService } from "../services/forge-service.js";
import {
  createWorktree,
  slugify,
  validateBranchSlug,
  type WorktreeConfig,
} from "../utils/worktree.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { branchNameFromRef } from "../utils/worktree-metadata.js";
import { runGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";
import type { WarmWorktreePool } from "./warm-worktree-pool.js";
export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  paseoHome?: string;
  worktreesRoot?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  warmWorktreePool?: Pick<WarmWorktreePool, "claim">;
}

export interface CreateWorktreeCoreResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  repoRoot: string;
  created: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  return runWithGitCommandPriority("high", () => createWorktreeCoreWithPriority(input, deps));
}

async function createWorktreeCoreWithPriority(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const requestedBranchName = input.branchName?.trim();

  let intentInput: ResolveWorktreeCreationIntentInput;
  if (input.action === "checkout") {
    intentInput = {
      action: "checkout",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (input.checkoutSource !== undefined || input.githubPrNumber !== undefined) {
    intentInput = {
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else {
    const worktreeSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(createNameId());
    intentInput = {
      action: "branch-off",
      refName: input.refName,
      branchName: requestedBranchName,
      worktreeSlug,
    };
  }

  const forge = await resolveForge(repoRoot, deps, intentInput);
  const intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    forge: forge.forge,
    forgeService: forge.service,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
  });
  let normalizedSlug: string;

  switch (intent.kind) {
    case "branch-off": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-branch": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      normalizedSlug =
        requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.localBranchName ?? intent.headRef);
      break;
    }
  }

  if (intent.kind === "branch-off" && intent.baseBranch) {
    await fetchDispatchBaseBranch(repoRoot, intent.baseBranch);
  }
  if (deps.warmWorktreePool) {
    const warmClaimResult = await deps.warmWorktreePool.claim({
      repoRoot,
      worktreeSlug: normalizedSlug,
      source: intent,
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
      runSetup: input.runSetup,
    });
    if (warmClaimResult) {
      return {
        worktree: warmClaimResult.worktree,
        intent,
        repoRoot,
        created: true,
      };
    }
  }

  return {
    worktree: await createWorktree({
      cwd: repoRoot,
      worktreeSlug: normalizedSlug,
      source: intent,
      runSetup: input.runSetup ?? true,
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
    }),
    intent,
    repoRoot,
    created: true,
  };
}

async function resolveForge(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService }> {
  const resolution = await deps.workspaceGitService?.resolveForge(repoRoot);
  if (!resolution) {
    if (intentInput.checkoutSource?.forge && intentInput.checkoutSource.forge !== "github") {
      throw new UnsupportedForgeCheckoutTargetError(intentInput.checkoutSource.forge);
    }
    // No recognized remote: fall back to GitHub, the wire-default forge.
    return { forge: "github", service: deps.github };
  }
  return { forge: resolution.forge, service: resolution.service };
}

/** ADR 0001: dispatch's unconditional, short-budget fetch before a branch-off worktree cut. */
const DISPATCH_BASE_BRANCH_FETCH_TIMEOUT_MS = 3_000;

// ADR 0001: dispatch cuts a worktree from the base branch under time pressure, so it gets one
// short, budgeted chance to pull origin's tip before the branch-off resolves its source ref
// (utils/worktree.ts resolveBaseBranchForWorktree / resolveWorktreeSourcePlan). Soft-fail: a
// slow or unreachable remote must never block dispatch — worst case it branches from a
// slightly stale local view, and the periodic base-checkout-sync service catches up later.
async function fetchDispatchBaseBranch(repoRoot: string, baseBranch: string): Promise<void> {
  const refName = branchNameFromRef(baseBranch);
  if (!refName || refName === "HEAD") {
    return;
  }
  await runGitCommand(["fetch", "origin", refName], {
    cwd: repoRoot,
    timeout: DISPATCH_BASE_BRANCH_FETCH_TIMEOUT_MS,
    acceptExitCodes: [0, 1, 128],
  }).catch(() => undefined);
}

// ADR 0001: `resolveBaseBranchForWorktree` (utils/worktree.ts) resolves bare branch names
// local-first, so a stale local branch sharing the default branch's name silently wins over
// origin's current tip — correct for manual flows, stale for dispatch. When nothing else named
// the base branch (this function only runs for that fallback), prefer the `origin/<name>`
// remote-tracking ref whenever it exists so dispatch always cuts from what origin advertises.
async function preferOriginDefaultBranch(repoRoot: string, baseBranch: string): Promise<string> {
  if (baseBranch.startsWith("origin/") || baseBranch.startsWith("refs/")) {
    return baseBranch;
  }
  try {
    await runGitCommand(["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}`], {
      cwd: repoRoot,
    });
    return `origin/${baseBranch}`;
  } catch {
    return baseBranch;
  }
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
): Promise<string> {
  if (deps.resolveDefaultBranch) {
    const baseBranch = await deps.resolveDefaultBranch(repoRoot);
    if (!baseBranch) {
      throw new Error("Unable to resolve repository default branch");
    }
    return baseBranch;
  }
  const baseBranch = await deps.workspaceGitService?.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return preferOriginDefaultBranch(repoRoot, baseBranch);
}

export async function resolveWorktreeRepoRoot(
  input: Pick<CreateWorktreeCoreInput, "cwd" | "paseoHome">,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("Create worktree requires WorkspaceGitService");
  }

  return workspaceGitService.resolveRepoRoot(input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}

function normalizeWorktreeSlug(value: string): string {
  return validateWorktreeSlug(slugify(value));
}
