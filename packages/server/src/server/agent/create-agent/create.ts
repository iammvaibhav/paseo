import type { FinishSubscriptions } from "../finish-subscriptions/index.js";
import type { AgentPromptSource } from "../agent-messages/index.js";
import type { Logger } from "pino";
import { isAgentModeId, type AgentModeId } from "@getpaseo/protocol/agent-modes";

import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { AgentAttachment, FirstAgentContext } from "../../messages.js";
import type { AgentManager, CreateAgentOptions, ManagedAgent } from "../agent-manager.js";
import type { AgentPromptInput, AgentRunOptions, AgentSessionConfig } from "../agent-sdk-types.js";
import type { AgentStorage } from "../agent-storage.js";
import type { AgentOwner } from "../agent-owner.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { startCreatedAgentInitialPrompt } from "../agent-prompt.js";

import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { buildAgentPrompt } from "../prompt-attachments.js";
import { normalizeClientMessageId, resolveClientMessageId } from "../../client-message-id.js";
import { canonicalProviderModel } from "@getpaseo/protocol/provider-model";
import { resolveRequiredProviderModel, type ResolvedProviderModel } from "../mcp-shared.js";
import { getItsaplanIssueIdFromLabels } from "../../itsaplan/bridge.js";
import { resolveCreateAgentIntent, type CreateAgentPlacement } from "./intent.js";

export interface CreateAgentCommandDependencies {
  finishSubscriptions?: FinishSubscriptions;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  paseoHome?: string;
  worktreesRoot?: string;
  terminalManager?: TerminalManager | null;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
  /**
   * Looks up a workspace by id so a create that names one lands in that
   * workspace's real directory. Required: without it a workspaceId-only create
   * would land in the caller's defaulted cwd (the daemon's process.cwd()).
   */
  getWorkspace: GetWorkspaceForCreate;
}

export type EnsureWorkspaceForCreate = (
  cwd: string,
  firstAgentContext?: FirstAgentContext,
  context?: { callerWorkspaceId?: string },
) => Promise<string>;

/**
 * The subset of a workspace record the create path needs: where it lives and
 * whether it is still live.
 */
export type GetWorkspaceForCreate = (
  workspaceId: string,
) => Promise<{ cwd: string; archivedAt: string | null } | null>;

export interface CreateAgentFromSessionInput {
  kind: "session";
  onAgentReady?: (agent: ManagedAgent) => Promise<void>;
  agentId?: string;
  config: AgentSessionConfig;
  workspaceId: string;
  initialPrompt?: string;
  source?: AgentPromptSource;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  labels: Record<string, string>;
  // Agent mode (Do it yourself, Orchestrator, …). Stamped onto the agent at
  // registration; its block rides the first user message.
  agentMode?: AgentModeId;
  env?: Record<string, string>;
  provisionalTitle: string | null;
  firstAgentContext: FirstAgentContext;
}

export interface CreateAgentFromMcpInput {
  kind: "mcp";
  provider: string;
  title: string;
  initialPrompt?: string;
  config?: Partial<AgentSessionConfig>;
  cwd?: string;
  workspaceId?: string;
  isolation?: "local" | "worktree";
  thinking?: string;
  features?: Record<string, unknown>;
  labels?: Record<string, string>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  mode?: string;
  /**
   * Agent mode id (Do it yourself, Orchestrator, …). Absent = Do it yourself.
   * A string because spawn plans and schedules carry it off the wire; an id
   * this daemon does not know (a newer host's mode) falls back to the default.
   */
  agentMode?: string;
  unattended?: boolean;
  promptFailure?: CreateAgentPromptFailureMode;
  notifyOnFinish: boolean;
  internal?: boolean;
  detached?: boolean;
  owner?: AgentOwner;
  env?: Record<string, string>;
  onCreated?: (created: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;
  onWorktreeCreated?: (createdWorktree: CreatePaseoWorktreeWorkflowResult) => void;
  callerAgentId?: string;
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;

  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;
export type CreateAgentPromptFailureMode = "throw" | "log" | "return-error";

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  initialPromptStarted: boolean;
  initialPromptError: unknown | null;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export type BoundCreateAgentCommand = (
  input: CreateAgentCommandInput,
) => Promise<CreateAgentCommandResult>;

function requireResolvedWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("createAgentCommand requires a resolved workspaceId");
  }
  return workspaceId;
}

export function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model || provider.includes("/")) {
    return provider;
  }
  return `${provider}/${model}`;
}

function resolveProviderModel(providerValue: string): ResolvedProviderModel {
  const providerInput = canonicalProviderModel(providerValue);
  if (providerInput.includes("/")) {
    return resolveRequiredProviderModel(providerInput);
  }
  if (!providerInput) {
    throw new Error("provider is required");
  }
  return { provider: providerInput, model: undefined };
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions: CreateAgentOptions;
  prompt?: AgentPromptInput;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  promptFailure: CreateAgentPromptFailureMode;
  promptLogger?: Logger;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const resolved =
    input.kind === "session"
      ? await resolveSessionCreateAgent(dependencies, input)
      : await resolveMcpCreateAgent(dependencies, input);

  const snapshot = await dependencies.agentManager.createAgent(
    resolved.config,
    input.kind === "session" ? input.agentId : undefined,
    resolved.createOptions,
  );

  if (input.kind === "session") await input.onAgentReady?.(snapshot);

  let liveSnapshot = snapshot;
  let initialPromptStarted = false;
  let initialPromptError: unknown | null = null;
  if (input.kind === "mcp") {
    input.onCreated?.({ agentId: snapshot.id, createdWorktree: resolved.createdWorktree ?? null });
  }
  const notification =
    input.kind === "mcp" &&
    input.notifyOnFinish &&
    input.callerAgentId &&
    resolved.prompt !== undefined
      ? await requireFinishSubscriptions(dependencies).register(
          {
            childAgentId: snapshot.id,
            callerAgentId: input.callerAgentId,
            requireParentOwnership: !(input.detached ?? false),
          },
          true,
        )
      : undefined;

  if (resolved.prompt !== undefined) {
    const sendResult = await sendInitialPrompt(dependencies, resolved, snapshot).catch(
      async (error) => {
        await notification?.reject();
        throw error;
      },
    );
    notification?.accept();
    initialPromptStarted = sendResult.started;
    liveSnapshot = sendResult.liveSnapshot;
    initialPromptError = sendResult.error ?? null;
  }

  return {
    snapshot,
    liveSnapshot,
    initialPromptStarted,
    initialPromptError,
    ...(resolved.createdWorktree ? { createdWorktree: resolved.createdWorktree } : {}),
  };
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const builtSessionConfig = input.config;
  const resolvedCreateConfig = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: builtSessionConfig.cwd,
    provider: builtSessionConfig.provider,
    requestedMode: builtSessionConfig.modeId,
    featureValues: builtSessionConfig.featureValues,
    parent: null,
    unattended: false,
  });
  const sessionConfig: AgentSessionConfig = {
    ...builtSessionConfig,
    modeId: resolvedCreateConfig.modeId,
    featureValues: resolvedCreateConfig.featureValues,
  };
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);
  const runOptions: AgentRunOptions | undefined =
    input.outputSchema || clientMessageId
      ? {
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        }
      : undefined;
  const workspaceId = input.workspaceId;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      initialPrompt: trimmedPrompt,
      env: input.env,
      initialTitle: input.provisionalTitle,
      ...(input.agentMode ? { agentMode: input.agentMode } : {}),
      // Paseo never persists an internal agent, so nothing could resume its
      // provider session either. Same as the daemon's own ephemeral helpers.
      ...(sessionConfig.internal ? { persistSession: false } : {}),
      workspaceId: requireResolvedWorkspaceId(workspaceId),
    },
    prompt: hasPromptContent ? prompt : undefined,
    source: input.source,
    runOptions,
    // Registration commits creation. First-turn failures belong to the created agent.
    promptFailure: "return-error",
    promptLogger: dependencies.logger.child({
      clientMessageId: resolveClientMessageId(input.clientMessageId),
    }),
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  const cwd = resolveMcpInitialCwd(input, parentAgent);
  const { resolvedCwd, createdWorkspaceId, createdWorktree } = await resolveMcpCwd({
    dependencies,
    cwd,
    title: input.title,
    worktree: input.worktree,
    isolation: input.isolation,
    workspaceId: input.workspaceId,
    labels: input.labels,
    initialPrompt: input.initialPrompt ?? "",
    callerWorkspaceId: parentAgent?.workspaceId,
  });
  if (createdWorktree) input.onWorktreeCreated?.(createdWorktree);
  const intent = await resolveCreateAgentIntent({
    explicitWorkspaceId: createdWorkspaceId ?? input.workspaceId,
    caller: parentAgent
      ? { id: parentAgent.id, cwd: parentAgent.cwd, workspaceId: parentAgent.workspaceId }
      : null,
    // resolveCreateAgentIntent takes labels optionally, so dropping this argument
    // compiles clean and silently creates every MCP agent with no labels at all.
    labels: input.labels,
    childAgentDefaultLabels: input.callerContext?.childAgentDefaultLabels,
    legacyDetached: input.detached ?? false,
    // A worktree this create just made is placed at its own cwd, the same as the
    // session path; any other named workspace is looked up.
    resolveWorkspace: async (workspaceId) =>
      createdWorkspaceId === workspaceId
        ? { workspaceId, cwd: resolvedCwd }
        : resolveExplicitWorkspacePlacement({
            dependencies,
            workspaceId,
            callerRequestedCwd: input.cwd,
            fallbackCwd: resolvedCwd,
          }),
    createWorkspace: async () => ({
      workspaceId: requireResolvedWorkspaceId(
        await ensureWorkspaceForMcpCreate(
          dependencies,
          resolvedCwd,
          input.initialPrompt ?? "",
          parentAgent?.workspaceId,
        ),
      ),
      cwd: resolvedCwd,
    }),
  });
  const resolvedCreateConfig = await resolveMcpProviderCreateConfig({
    dependencies,
    input,
    provider,
    resolvedCwd: intent.cwd,
    parentAgent,
  });

  const trimmedPrompt = input.initialPrompt?.trim() ?? "";
  const prompt = buildAgentPrompt(trimmedPrompt, input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  return {
    config: buildMcpSessionConfig({
      input,
      resolvedProviderModel,
      provider,
      resolvedCwd: intent.cwd,
      trimmedPrompt,
      resolvedMode: resolvedCreateConfig.modeId,
      resolvedFeatures: resolvedCreateConfig.featureValues,
    }),
    createOptions: {
      ...(Object.keys(intent.labels).length > 0 ? { labels: intent.labels } : {}),
      workspaceId: intent.workspaceId,
      owner: input.owner,
      env: input.env,
      ...(isAgentModeId(input.agentMode) ? { agentMode: input.agentMode } : {}),
    },
    prompt: hasPromptContent ? prompt : undefined,
    source: input.callerAgentId
      ? { kind: "agent-message", agentId: input.callerAgentId }
      : undefined,
    createdWorktree,
    promptFailure: input.promptFailure ?? "log",
  };
}

/**
 * Placement for a create that names an existing workspace.
 *
 * The workspace's own directory is authoritative. Trusting the caller's cwd
 * here put agents at the daemon's `process.cwd()` whenever a spawn named
 * a workspace but passed no cwd, which files the agent outside the workspace
 * and hides it from the board. An explicit caller cwd still wins, so a spawn
 * can target a subdirectory of the workspace.
 *
 * An archived or missing workspace is refused: creating there produces an
 * agent the next archive sweep immediately archives.
 */
export async function resolveExplicitWorkspacePlacement(params: {
  dependencies: CreateAgentCommandDependencies;
  workspaceId: string;
  callerRequestedCwd: string | undefined;
  fallbackCwd: string;
}): Promise<CreateAgentPlacement> {
  const { dependencies, workspaceId, callerRequestedCwd, fallbackCwd } = params;
  const workspace = await dependencies.getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }
  if (workspace.archivedAt) {
    throw new Error(`Workspace ${workspaceId} is archived`);
  }
  return {
    workspaceId,
    cwd: callerRequestedCwd ? fallbackCwd : workspace.cwd,
  };
}

function resolveMcpInitialCwd(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): string {
  if (!parentAgent) {
    return expandUserPath(input.cwd ?? process.cwd());
  }
  return resolveChildAgentCwd({
    parentCwd: parentAgent.cwd,
    requestedCwd: input.cwd,
    lockedCwd: input.callerContext?.lockedCwd,
    allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
  });
}

async function resolveMcpProviderCreateConfig(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  provider: string;
  resolvedCwd: string;
  parentAgent: ManagedAgent | null;
}): Promise<{ modeId?: string; featureValues?: Record<string, unknown> }> {
  const passthroughConfig = params.input.config;
  return params.dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: params.resolvedCwd,
    provider: params.provider,
    requestedMode: params.input.mode ?? passthroughConfig?.modeId,
    featureValues: params.input.features ?? passthroughConfig?.featureValues,
    parent: params.parentAgent,
    unattended: params.input.unattended ?? false,
  });
}

function buildMcpSessionConfig(params: {
  input: CreateAgentFromMcpInput;
  resolvedProviderModel: ResolvedProviderModel;
  provider: string;
  resolvedCwd: string;
  trimmedPrompt: string;
  resolvedMode?: string;
  resolvedFeatures?: Record<string, unknown>;
}): AgentSessionConfig {
  const passthroughConfig = params.input.config;
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: passthroughConfig?.title ?? params.input.title,
    initialPrompt: params.trimmedPrompt,
  });
  const featureValues = params.resolvedFeatures ?? passthroughConfig?.featureValues;
  const config: AgentSessionConfig = {
    ...passthroughConfig,
    provider: params.provider,
    cwd: params.resolvedCwd,
    modeId: params.resolvedMode ?? passthroughConfig?.modeId,
    model: params.resolvedProviderModel.model ?? passthroughConfig?.model,
    thinkingOptionId: params.input.thinking ?? passthroughConfig?.thinkingOptionId,
    internal: params.input.internal ?? passthroughConfig?.internal,
  };
  if (provisionalTitle) {
    config.title = provisionalTitle;
  }
  if (featureValues) {
    config.featureValues = featureValues;
  }
  return config;
}

async function ensureWorkspaceForMcpCreate(
  dependencies: CreateAgentCommandDependencies,
  cwd: string,
  initialPrompt: string,
  callerWorkspaceId?: string,
): Promise<string | undefined> {
  if (!dependencies.ensureWorkspaceForCreate) {
    return undefined;
  }
  return dependencies.ensureWorkspaceForCreate(
    cwd,
    { prompt: initialPrompt },
    { callerWorkspaceId },
  );
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent; error?: unknown }> {
  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    const liveSnapshot = await startCreatedAgentInitialPrompt({
      agentStorage: dependencies.agentStorage,
      agentManager: dependencies.agentManager,
      agentId: snapshot.id,
      snapshot,
      prompt,
      source: resolved.source,
      runOptions: resolved.runOptions,
      logger: resolved.promptLogger ?? dependencies.logger,
    });
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    if (resolved.promptFailure === "return-error") {
      return {
        started: false,
        liveSnapshot: dependencies.agentManager.getAgent(snapshot.id) ?? snapshot,
        error,
      };
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

function isExplicitWorktreeRequested(
  isolation: CreateAgentFromMcpInput["isolation"] | undefined,
  worktree: CreateAgentFromMcpInput["worktree"] | undefined,
): boolean {
  if (isolation === "worktree") return true;
  if (!worktree) return false;
  return Boolean(
    worktree.worktreeName ||
    worktree.branchName ||
    worktree.baseBranch ||
    worktree.refName ||
    worktree.action ||
    worktree.githubPrNumber !== undefined,
  );
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("requires a git repository") || msg.includes("not a git repository");
  }
  return false;
}

function shouldAttemptMcpWorktree(params: {
  isolation?: CreateAgentFromMcpInput["isolation"];
  worktree?: CreateAgentFromMcpInput["worktree"];
  workspaceId?: string;
  labels?: Record<string, string>;
  hasWorktreeService: boolean;
}): { attempt: boolean; explicit: boolean } {
  if (params.workspaceId || params.isolation === "local" || !params.hasWorktreeService) {
    return { attempt: false, explicit: false };
  }
  const explicit = isExplicitWorktreeRequested(params.isolation, params.worktree);
  const isTicket = Boolean(params.labels && getItsaplanIssueIdFromLabels(params.labels));
  return { attempt: explicit || isTicket, explicit };
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Paseo worktree service is not configured");
    }
    return await options.createPaseoWorktree(
      options.input,
      options.resolveDefaultBranch ? { resolveDefaultBranch: options.resolveDefaultBranch } : {},
    );
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  title?: string;
  initialPrompt: string;
  callerWorkspaceId?: string;
  worktree?: CreateAgentFromMcpInput["worktree"];
  isolation?: CreateAgentFromMcpInput["isolation"];
  workspaceId?: string;
  labels?: Record<string, string>;
}): Promise<{
  resolvedCwd: string;
  createdWorkspaceId?: string;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}> {
  const { dependencies, worktree, isolation, workspaceId, labels } = params;
  const { attempt, explicit } = shouldAttemptMcpWorktree({
    isolation,
    worktree,
    workspaceId,
    labels,
    hasWorktreeService: Boolean(dependencies.createPaseoWorktree),
  });
  if (!attempt) {
    return { resolvedCwd: params.cwd };
  }

  const baseBranch = worktree?.baseBranch;
  try {
    const createdWorktree = await createMcpWorktree({
      input: {
        cwd: params.cwd,
        callerWorkspaceId: params.callerWorkspaceId,
        title: params.title,
        worktreeSlug: worktree?.worktreeName,
        branchName: worktree?.branchName,
        refName: worktree?.refName,
        action: worktree?.action,
        githubPrNumber: worktree?.githubPrNumber,
        firstAgentContext: { prompt: params.initialPrompt },
        paseoHome: dependencies.paseoHome,
        worktreesRoot: dependencies.worktreesRoot,
      },
      createPaseoWorktree: dependencies.createPaseoWorktree,
      resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
    });
    return {
      resolvedCwd: createdWorktree.workspace.cwd,
      createdWorkspaceId: createdWorktree.workspace.workspaceId,
      createdWorktree,
    };
  } catch (error) {
    if (explicit || !isNotGitRepositoryError(error)) {
      throw error;
    }
    dependencies.logger.debug(
      { err: error, cwd: params.cwd },
      "createAgentCommand: non-git directory, using directory workspace",
    );
    return { resolvedCwd: params.cwd };
  }
}

function requireFinishSubscriptions(
  dependencies: CreateAgentCommandDependencies,
): FinishSubscriptions {
  if (!dependencies.finishSubscriptions) throw new Error("Finish subscriptions are not configured");
  return dependencies.finishSubscriptions;
}
