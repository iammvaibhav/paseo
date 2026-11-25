import type {
  PluginWorktreeCreateInput,
  PluginWorktreeCreateRequest,
} from "@getpaseo/plugin/server";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";
import type { PluginWorktreeManagerRuntime } from "./plugins/runtime.js";
import { createNameId } from "mnemonic-id";

import type { ForgeService } from "../services/forge-service.js";
import {
  createWorktree,
  fetchFirstAvailableRef,
  prepareWorktreeBranchOff,
  type PreparedWorktreeBranchOff,
  resolveDefaultWorktreePath,
  runPluginWorktreeManagerCheckout,
  slugify,
  validateBranchSlug,
  type CreatedWorktree,
} from "../utils/worktree.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
  worktreeUntrustedSource,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { runWithRepositoryRoot } from "../utils/git-repository-discovery.js";
import { runGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";
import { branchNameFromRef, setPaseoWorktreeUntrustedSource } from "../utils/worktree-metadata.js";
import { createPhaseTimer, type PhaseTimer } from "../utils/phase-timer.js";
import type { WarmWorktreePool } from "./warm-worktree-pool.js";

import type { UntrustedWorkspaceSource } from "./workspace-automation-gate.js";
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
}

export interface CreateWorktreeCoreDeps {
  lifecycle?: Pick<PluginLifecycle, "before">;
  worktreeManagers?: Pick<
    PluginWorktreeManagerRuntime,
    "hasWorktreeManager" | "createWorktree" | "removeWorktree"
  >;
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge" | "hasOriginTrackingBranch"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  warmWorktreePool?: Pick<WarmWorktreePool, "claim">;
  /** Fire-and-forget hint that a fresh session is about to open at this cwd,
   * so an idle OMP agent pool entry can retarget ahead of the real create
   * request instead of paying pool-miss latency on it. Never throws. */
  prewarmAgentCwd?: (cwd: string) => void;
}

export interface CreateWorktreeCoreResult {
  worktree: CreatedWorktree;
  intent: WorktreeCreationIntent;
  untrustedSource?: UntrustedWorkspaceSource;
  repoRoot: string;
  created: boolean;
  /** Set when a warm-pool tree already ran worktree.setup at this commit; skip running it again. */
  setupPrepared?: true;
  /**
   * Milliseconds per phase: repoRootMs, intentMs, placementMs, then either warm
   * claim phases (prefixed `claim.`) or fetchMs + createMs for a cold create.
   */
  timing: Record<string, number>;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  return runWithGitCommandPriority("high", () => createWorktreeCoreWithPriority(input, deps));
}

function buildWorktreeCreationIntentInput(
  input: CreateWorktreeCoreInput,
  requestedWorktreeSlug: string | undefined,
): ResolveWorktreeCreationIntentInput {
  if (input.action === "checkout") {
    return {
      action: "checkout",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  }
  if (
    input.action !== "branch-off" &&
    (input.checkoutSource !== undefined || input.githubPrNumber !== undefined)
  ) {
    // A change request with no action is checked out, as clients did before `action` existed.
    return {
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  }
  return {
    action: "branch-off",
    refName: input.refName,
    checkoutSource: input.checkoutSource,
    githubPrNumber: input.githubPrNumber,
    branchName: input.branchName?.trim(),
    worktreeSlug: requestedWorktreeSlug ?? normalizeWorktreeSlug(createNameId()),
  };
}

async function createWorktreeCoreWithPriority(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const timer = createPhaseTimer();
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  timer.mark("repoRootMs");
  return runWithRepositoryRoot(repoRoot, () =>
    createWorktreeAtRepositoryRoot(input, deps, repoRoot, timer),
  );
}

async function createWorktreeAtRepositoryRoot(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
  repoRoot: string,
  timer: PhaseTimer,
): Promise<CreateWorktreeCoreResult> {
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const intentInput = buildWorktreeCreationIntentInput(input, requestedWorktreeSlug);

  const forge = await resolveForgeForWorktreeCreate(input, repoRoot, deps, intentInput);
  let intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    forge: forge.forge,
    forgeService: forge.service,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
    fetchRef: ({ repoRoot: cwd, sources, destination }) =>
      fetchFirstAvailableRef({ cwd, sources, destination }),
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
  timer.mark("intentMs");

  const defaultPath = await resolveDefaultWorktreePath({
    cwd: repoRoot,
    paseoHome: input.paseoHome,
    worktreesRoot: input.worktreesRoot,
    worktreeSlug: normalizedSlug,
  });
  const { stdout: sourceRoot } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
  });
  const sourceCheckout = sourceRoot.trim();
  const request = describeCreationRequest(intent, {
    repoRoot,
    sourceCheckout,
    slug: normalizedSlug,
    path: defaultPath,
  });
  const transformed = deps.lifecycle
    ? await deps.lifecycle.before("worktree.create.before", request)
    : request;
  const originalUntrustedSource = worktreeUntrustedSource(intent);
  normalizedSlug = validateWorktreeSlug(transformed.slug);
  intent = creationIntentFromRequest(transformed, intent);
  const untrustedSource = originalUntrustedSource ?? worktreeUntrustedSource(intent);
  timer.mark("placementMs");

  const { worktree: managedWorktree, preparedBranchOff } = await tryCreateWithWorktreeManager({
    repoRoot,
    transformed,
    intent,
    untrusted: Boolean(untrustedSource),
    input,
    deps,
  });
  if (managedWorktree) {
    timer.mark("createMs");
    return finishWorktreeCreate({
      worktree: managedWorktree,
      intent,
      untrustedSource,
      repoRoot,
      timing: timer.phases,
    });
  }

  // Claim before the origin fetch. A warm worktree is already checked out at a
  // recent SHA; waiting up to DISPATCH_BASE_BRANCH_FETCH_TIMEOUT_MS here made
  // every "instant" create pay a 1–3s git fetch even when the pool hit.
  // ADR 0001's fetch still runs on the cold path so a miss branches from origin.
  // Warm trees keep their pool path, so a plugin-chosen path always creates cold.
  if (deps.warmWorktreePool && transformed.path === defaultPath) {
    const warmClaimResult = await deps.warmWorktreePool.claim({
      repoRoot,
      worktreeSlug: normalizedSlug,
      source: intent,
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
      // Warm trees never move, so the agent process can start its `/move`
      // while the claim is still cutting the branch.
      ...(deps.prewarmAgentCwd ? { onReserved: deps.prewarmAgentCwd } : {}),
    });
    if (warmClaimResult) {
      return finishWorktreeCreate({
        worktree: warmClaimResult.worktree,
        intent,
        untrustedSource,
        repoRoot,
        setupPrepared: warmClaimResult.setupPrepared,
        timing: {
          ...timer.phases,
          ...Object.fromEntries(
            Object.entries(warmClaimResult.timing).map(([name, ms]) => [`claim.${name}`, ms]),
          ),
        },
      });
    }
    timer.mark("claimMissMs");
  }
  if (intent.kind === "branch-off" && intent.baseBranch) {
    await fetchDispatchBaseBranch(repoRoot, intent.baseBranch);
    timer.mark("fetchMs");
  }

  const worktree = await createWorktree({
    cwd: repoRoot,
    worktreeSlug: normalizedSlug,
    worktreePath: transformed.path,
    source: intent,
    preparedBranchOff,
    paseoHome: input.paseoHome,
    worktreesRoot: input.worktreesRoot,
  });
  timer.mark("createMs");
  return finishWorktreeCreate({
    worktree,
    intent,
    untrustedSource,
    repoRoot,
    timing: timer.phases,
  });
}

/** Records an untrusted source on the new worktree, then assembles the create result. */
async function finishWorktreeCreate(created: {
  worktree: CreatedWorktree;
  intent: WorktreeCreationIntent;
  untrustedSource: UntrustedWorkspaceSource | undefined;
  repoRoot: string;
  setupPrepared?: boolean;
  timing: Record<string, number>;
}): Promise<CreateWorktreeCoreResult> {
  if (created.untrustedSource) {
    await setPaseoWorktreeUntrustedSource(created.worktree.worktreePath, created.untrustedSource);
  }
  return {
    worktree: created.worktree,
    intent: created.intent,
    ...(created.untrustedSource ? { untrustedSource: created.untrustedSource } : {}),
    repoRoot: created.repoRoot,
    created: true,
    ...(created.setupPrepared ? { setupPrepared: true as const } : {}),
    timing: created.timing,
  };
}

async function resolveForgeForWorktreeCreate(
  input: CreateWorktreeCoreInput,
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService }> {
  // Branch-off / checkout-branch do not need forge identity. Resolving it
  // walked remotes on every warm claim.
  if (input.checkoutSource === undefined && input.githubPrNumber === undefined) {
    return { forge: "github", service: deps.github };
  }
  return resolveForge(repoRoot, deps, intentInput);
}

async function tryCreateWithWorktreeManager(options: {
  repoRoot: string;
  transformed: PluginWorktreeCreateRequest;
  intent: WorktreeCreationIntent;
  untrusted: boolean;
  input: Pick<CreateWorktreeCoreInput, "paseoHome" | "worktreesRoot">;
  deps: Pick<CreateWorktreeCoreDeps, "worktreeManagers">;
}): Promise<{ worktree: CreatedWorktree | null; preparedBranchOff?: PreparedWorktreeBranchOff }> {
  const { repoRoot, transformed, intent, untrusted, input, deps } = options;
  let preparedBranchOff: PreparedWorktreeBranchOff | undefined;
  const worktree = await runPluginWorktreeManagerCheckout({
    cwd: repoRoot,
    source: intent,
    operation: "create",
    untrusted,
    paseoHome: input.paseoHome,
    worktreesBaseRoot: input.worktreesRoot,
    worktreeManagers: deps.worktreeManagers,
    run: async ({ changeRequestHeadSha }) => {
      let request: PluginWorktreeCreateInput = {
        ...transformed,
        untrusted,
        ...(changeRequestHeadSha ? { headSha: changeRequestHeadSha } : {}),
      };
      if (request.kind === "branch-off" && intent.kind === "branch-off") {
        preparedBranchOff = await prepareWorktreeBranchOff(repoRoot, intent);
        request = { ...request, baseRef: preparedBranchOff.baseRef };
      }
      return deps.worktreeManagers!.createWorktree(request);
    },
  });
  return { worktree, preparedBranchOff };
}

function describeCreationRequest(
  intent: WorktreeCreationIntent,
  placement: Pick<PluginWorktreeCreateRequest, "repoRoot" | "sourceCheckout" | "slug" | "path">,
): PluginWorktreeCreateRequest {
  if (intent.kind === "branch-off")
    return {
      ...placement,
      kind: intent.kind,
      branch: intent.branchName,
      // Intent resolution always fills the base; only direct primitive callers omit it.
      baseRef: intent.baseBranch ?? "",
      ...(intent.startPoint ? { startPoint: intent.startPoint } : {}),
    };
  if (intent.kind === "checkout-branch")
    return { ...placement, kind: intent.kind, branch: intent.branchName };
  const { localBranchName, baseRefName, ...facts } = intent;
  return {
    ...placement,
    ...facts,
    branch: localBranchName ?? intent.headRef,
    baseRef: baseRefName,
  };
}

function creationIntentFromRequest(
  request: PluginWorktreeCreateRequest,
  original: WorktreeCreationIntent,
): WorktreeCreationIntent {
  if (request.kind === "branch-off") {
    // Plugins see the base; where a branch off a fork's change request starts stays Paseo's.
    const startPoint = original.kind === "branch-off" ? original.startPoint : undefined;
    return {
      kind: request.kind,
      branchName: request.branch,
      baseBranch: request.baseRef,
      ...(startPoint ? { startPoint } : {}),
    };
  }
  if (request.kind === "checkout-branch") {
    return {
      kind: request.kind,
      branchName: request.branch,
    };
  }
  const {
    repoRoot: _repoRoot,
    sourceCheckout: _checkout,
    slug: _slug,
    path: _path,
    branch,
    baseRef,
    ...facts
  } = request;
  const keepLocalBranchName =
    branch !== request.headRef ||
    ((original.kind === "checkout-change-request" || original.kind === "checkout-github-pr") &&
      original.localBranchName !== undefined);
  return {
    ...facts,
    ...(keepLocalBranchName ? { localBranchName: branch } : {}),
    baseRefName: baseRef,
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
export async function preferOriginDefaultBranch(
  repoRoot: string,
  baseBranch: string,
  workspaceGitService: Pick<WorkspaceGitService, "hasOriginTrackingBranch">,
): Promise<string> {
  if (baseBranch.startsWith("origin/") || baseBranch.startsWith("refs/")) {
    return baseBranch;
  }
  const hasOriginBranch = await workspaceGitService
    .hasOriginTrackingBranch(repoRoot, baseBranch)
    .catch(() => false);
  return hasOriginBranch ? `origin/${baseBranch}` : baseBranch;
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
  const workspaceGitService = deps.workspaceGitService;
  const baseBranch = await workspaceGitService?.resolveDefaultBranch(repoRoot);
  if (!baseBranch || !workspaceGitService) {
    throw new Error("Unable to resolve repository default branch");
  }
  return preferOriginDefaultBranch(repoRoot, baseBranch, workspaceGitService);
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
