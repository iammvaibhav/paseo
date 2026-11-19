import invariant from "tiny-invariant";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import type { UserMessageImageAttachment } from "@/types/stream";
import { encodeImages } from "@/utils/encode-images";
import { draftCreationKey } from "@/composer/draft/creation-key";
import type { WorkspaceDraftForkSource, WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  providerOptions: Record<string, unknown>;
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  isConnected: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}

function resolveDraftModeIdOverride(input: {
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  effectiveModeId: string;
}): { modeId: string } | Record<string, never> {
  const { autoSubmitConfig, effectiveModeId } = input;
  if (autoSubmitConfig?.modeId) {
    return { modeId: autoSubmitConfig.modeId };
  }
  if (effectiveModeId !== "") {
    return { modeId: effectiveModeId };
  }
  return {};
}

export function resolveDraftModeId(input: {
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  effectiveModeId: string;
}): string | null {
  const { autoSubmitConfig, effectiveModeId } = input;
  if (autoSubmitConfig?.modeId !== undefined) {
    return autoSubmitConfig.modeId;
  }
  if (effectiveModeId !== "") {
    return effectiveModeId;
  }
  return null;
}

export type WorkspaceDraftSubmitClient = Pick<DaemonClient, "createAgent" | "forkAgent">;

interface WorkspaceDraftComposerState {
  selectedProvider: string | null;
  effectiveModeId: string;
  effectiveModelId: string | null;
  effectiveThinkingOptionId: string | null;
  providerOptions: Record<string, unknown> | undefined;
  metadata: Record<string, JsonValue>;
  agentMode: string;
}

export async function submitDraftCreateRequest(input: {
  draftId: string;
  attempt: { clientMessageId: string };
  text: string;
  images?: UserMessageImageAttachment[];
  attachments?: unknown;
  cwd: string;
  client: WorkspaceDraftSubmitClient | null;
  workspaceDirectory: string | null;
  workspaceId: string | null;
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  // Set when this draft was opened by "fork chat into a new tab": the daemon
  // creates the agent by forking the source session instead of from scratch.
  forkSource?: WorkspaceDraftForkSource;
  composerState: WorkspaceDraftComposerState;
  hostDisconnectedMessage: string;
  selectModelMessage: string;
  forkFailedMessage: string;
}): Promise<{ agentId: string | null; result: AgentSnapshotPayload }> {
  const { attempt, text, images, attachments, composerState } = input;
  const submit = resolveDraftSubmitTarget(input);
  const imagesData = await encodeImages(images);
  const attachmentsArray = Array.isArray(attachments) ? attachments : undefined;
  if (submit.kind === "fork") {
    return await submitDraftForkRequest({
      attempt,
      text,
      images: imagesData,
      attachments: attachmentsArray,
      client: submit.client,
      forkSource: submit.forkSource,
      config: submit.config,
      forkFailedMessage: input.forkFailedMessage,
    });
  }
  const request = {
    config: submit.config,
    workspaceId: submit.workspaceId,
    ...(text ? { initialPrompt: text } : {}),
    clientMessageId: attempt.clientMessageId,
    ...(Object.keys(composerState.metadata).length > 0 ? { metadata: composerState.metadata } : {}),
    ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
    ...(attachmentsArray && attachmentsArray.length > 0 ? { attachments: attachmentsArray } : {}),
    agentMode: input.composerState.agentMode,
  };
  // The key names this draft's exact request: a retry after a lost response resumes the
  // creation the daemon already started, while an edited draft is a new request.
  const result = await submit.client.createAgent({
    ...request,
    idempotencyKey: draftCreationKey(input.draftId, request),
  });
  return { agentId: result.id, result };
}

function resolveDraftSubmitTarget(input: {
  cwd: string;
  client: WorkspaceDraftSubmitClient | null;
  workspaceDirectory: string | null;
  workspaceId: string | null;
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  forkSource?: WorkspaceDraftForkSource;
  composerState: WorkspaceDraftComposerState;
  hostDisconnectedMessage: string;
  selectModelMessage: string;
}):
  | {
      kind: "fork";
      client: WorkspaceDraftSubmitClient;
      forkSource: WorkspaceDraftForkSource;
      config: AgentSessionConfig;
    }
  | {
      kind: "create";
      client: WorkspaceDraftSubmitClient;
      workspaceId: string;
      config: AgentSessionConfig;
    } {
  const {
    cwd,
    client,
    workspaceDirectory,
    workspaceId,
    autoSubmitConfig,
    forkSource,
    composerState,
  } = input;
  invariant(workspaceDirectory, "Workspace directory is required");
  invariant(workspaceId, "Workspace id is required");
  if (!client) {
    throw new Error(input.hostDisconnectedMessage);
  }
  const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.selectModelMessage);
  }
  const modeIdOverride = resolveDraftModeIdOverride({
    autoSubmitConfig,
    effectiveModeId: composerState.effectiveModeId,
  });
  const config = buildWorkspaceDraftAgentConfig({
    provider,
    cwd,
    ...modeIdOverride,
    model: autoSubmitConfig?.model ?? (composerState.effectiveModelId || undefined),
    thinkingOptionId:
      autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || undefined),
    providerOptions: autoSubmitConfig?.providerOptions ?? composerState.providerOptions,
  });
  if (forkSource) {
    return { kind: "fork", client, forkSource, config };
  }
  return { kind: "create", client, workspaceId, config };
}

/**
 * Fork the source agent at the draft's boundary. The fork's history is a
 * transcript attachment, not a resumed provider session, so the composer's
 * provider choice travels with it — a fork may land on a different provider
 * than the source. Only `cwd` stays pinned to the source's workspace.
 */
async function submitDraftForkRequest(input: {
  attempt: { clientMessageId: string };
  text: string;
  images: Array<{ data: string; mimeType: string }> | undefined;
  attachments: AgentAttachment[] | undefined;
  client: WorkspaceDraftSubmitClient;
  forkSource: WorkspaceDraftForkSource;
  config: AgentSessionConfig;
  forkFailedMessage: string;
}): Promise<{ agentId: string | null; result: AgentSnapshotPayload }> {
  const { attempt, text, images, attachments, client, forkSource, config } = input;
  const overrides: Partial<AgentSessionConfig> = {
    provider: config.provider,
    ...(config.modeId ? { modeId: config.modeId } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
  };
  const fork = await client.forkAgent(forkSource.sourceAgentId, text, {
    messageId: attempt.clientMessageId,
    ...(images && images.length > 0 ? { images } : {}),
    // The chat-history pill on a fork draft is a preview: the daemon renders
    // the transcript itself from the fork boundary at submit time, so sending
    // it would attach the conversation twice to the fork's first message.
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.filter(
            (attachment) => attachment.type !== "text" || attachment.contextKind !== "chat_history",
          ),
        }
      : {}),
    ...(forkSource.boundaryCursor ? { boundaryCursor: forkSource.boundaryCursor } : {}),
    ...(forkSource.boundaryMessageId ? { boundaryMessageId: forkSource.boundaryMessageId } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  });
  if (!fork.agent) {
    // Without a snapshot the draft tab cannot swap to the forked agent, and
    // silently creating a plain agent would drop the forked history.
    throw new Error(input.forkFailedMessage);
  }
  return { agentId: fork.agentId, result: fork.agent };
}

export function resolveDraftWorkingDirectory(input: {
  workspaceDirectory: string | null;
  initialSetup: WorkspaceDraftTabSetup | null;
}): string | null {
  if (input.initialSetup) {
    return input.initialSetup.cwd;
  }
  return input.workspaceDirectory;
}
