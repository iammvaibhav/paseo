import invariant from "tiny-invariant";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import type { UserMessageImageAttachment } from "@/types/stream";
import { encodeImages } from "@/utils/encode-images";
import type { WorkspaceDraftForkSource } from "@/workspace-tabs/model";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
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
  hasClient: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
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
    hasClient,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}

// Reconcile the form's selected mode against the currently discovered modes.
// The mode picker displays modeOptions[0] when the stored mode isn't in the
// list (e.g. a globally-remembered "plan" that this workspace's OpenCode config
// no longer defines), so the submitted mode must match that display — otherwise
// we'd send a stale mode the provider rejects while the UI showed a valid one.
function reconcileSelectedMode(modeOptionIds: readonly string[], selectedMode: string): string {
  if (modeOptionIds.length === 0) {
    return "";
  }
  return modeOptionIds.includes(selectedMode) ? selectedMode : (modeOptionIds[0] ?? "");
}

function resolveDraftModeIdOverride(input: {
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  modeOptionIds: readonly string[];
  selectedMode: string;
}): { modeId: string } | Record<string, never> {
  const { autoSubmitConfig, modeOptionIds, selectedMode } = input;
  if (autoSubmitConfig?.modeId) {
    return { modeId: autoSubmitConfig.modeId };
  }
  const reconciled = reconcileSelectedMode(modeOptionIds, selectedMode);
  if (reconciled !== "") {
    return { modeId: reconciled };
  }
  return {};
}

export function resolveDraftModeId(input: {
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  modeOptionIds: readonly string[];
  selectedMode: string;
}): string | null {
  const { autoSubmitConfig, modeOptionIds, selectedMode } = input;
  if (autoSubmitConfig?.modeId !== undefined) {
    return autoSubmitConfig.modeId;
  }
  const reconciled = reconcileSelectedMode(modeOptionIds, selectedMode);
  if (reconciled !== "") {
    return reconciled;
  }
  return null;
}

export type WorkspaceDraftSubmitClient = Pick<DaemonClient, "createAgent" | "forkAgent">;

export async function submitDraftCreateRequest(input: {
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
  composerState: {
    selectedProvider: string | null;
    selectedMode: string;
    modeOptions: readonly { id: string }[];
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
    featureValues: Record<string, unknown> | undefined;
  };
  hostDisconnectedMessage: string;
  selectModelMessage: string;
  forkFailedMessage: string;
}): Promise<{ agentId: string | null; result: AgentSnapshotPayload }> {
  const {
    attempt,
    text,
    images,
    attachments,
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
    modeOptionIds: composerState.modeOptions.map((mode) => mode.id),
    selectedMode: composerState.selectedMode,
  });
  const config = buildWorkspaceDraftAgentConfig({
    provider,
    cwd,
    ...modeIdOverride,
    model: autoSubmitConfig?.model ?? (composerState.effectiveModelId || undefined),
    thinkingOptionId:
      autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || undefined),
    featureValues: autoSubmitConfig?.featureValues ?? composerState.featureValues,
  });

  const imagesData = await encodeImages(images);
  const attachmentsArray = Array.isArray(attachments) ? attachments : undefined;
  if (forkSource) {
    return await submitDraftForkRequest({
      attempt,
      text,
      images: imagesData,
      attachments: attachmentsArray,
      client,
      forkSource,
      config,
      forkFailedMessage: input.forkFailedMessage,
    });
  }
  const result = await client.createAgent({
    config,
    workspaceId,
    ...(text ? { initialPrompt: text } : {}),
    clientMessageId: attempt.clientMessageId,
    ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
    ...(attachmentsArray && attachmentsArray.length > 0 ? { attachments: attachmentsArray } : {}),
  });

  return {
    agentId: result.id,
    result,
  };
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
    ...(config.featureValues ? { featureValues: config.featureValues } : {}),
  };
  const fork = await client.forkAgent(forkSource.sourceAgentId, text, {
    messageId: attempt.clientMessageId,
    ...(images && images.length > 0 ? { images } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
