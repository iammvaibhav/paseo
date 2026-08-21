import { stat } from "node:fs/promises";

import type { Logger } from "pino";

import { buildAgentForkContextAttachment, selectForkContextRows } from "./activity-curator.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import type { AgentMetadata, AgentPromptInput, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import { buildAgentPrompt } from "./prompt-attachments.js";
import { cloneOmpSessionFile, resolveOmpSessionFile } from "./providers/omp/session-descriptor.js";
import type { AgentAttachment } from "../messages.js";

export interface ForkAgentBoundary {
  /** Daemon timeline position of the boundary assistant message. */
  cursor?: { epoch: string; seq: number };
  /** Provider id of the boundary assistant message. */
  messageId?: string;
}

export interface ForkAgentInput {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  sourceAgentId: string;
  /** First-turn prompt for the fork. */
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  /** Client-provided id for first-turn dedup. */
  messageId?: string;
  /** Assistant turn the fork's history ends at. Omit to fork everything up to now. */
  boundary?: ForkAgentBoundary;
  /** Config the fork should run with, when the caller changed it from the source. */
  overrides?: Partial<AgentSessionConfig>;
  labels?: Record<string, string>;
  logger: Logger;
}

export interface ForkAgentResult {
  agentId: string;
  /**
   * How the fork's history was carried: "native" cloned the provider's own
   * session file and resumed the fork from the copy; "snapshot" rendered the
   * daemon timeline into a chat-history attachment on the first prompt.
   */
  strategy: "native" | "snapshot";
}

/**
 * Fork a source agent (typically running) into a brand-new sibling/root agent
 * seeded with its history up to `boundary` (default: "up to now"), then run the
 * caller's `text` as the fork's first turn. The source agent is never touched.
 *
 * Two strategies:
 * - native: the source is OMP with a durable session file. The file is copied
 *   (or sliced to the requested boundary) to a fresh path and the fork resumes
 *   from the copy, so it keeps the provider's own history and cache.
 * - snapshot: every other case (non-OMP source, provider switch, or no
 *   session file). A fresh session whose first prompt carries a chat-history
 *   text attachment rendered from the source timeline, sliced at exactly the
 *   requested point in the daemon timeline.
 */
export async function forkAgentToSibling(input: ForkAgentInput): Promise<ForkAgentResult> {
  const source = await resolveSourceAgent(input);
  // A provisional title derived from the fork's first prompt keeps the new tab
  // from being an exact duplicate of the source title. The caller can pin an
  // explicit title via `overrides.title` (e.g. the selection-ask popover
  // derives one from the user's question); when both are absent the prompt's
  // first line wins.
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: input.overrides?.title ?? null,
    initialPrompt: input.text,
  });

  // Native provider session clone + resume when the provider has a durable
  // session file (OMP): the fork resumes from a copy of the source's session
  // file, so it keeps the provider's own history and cache instead of a
  // rendered transcript. Falls back to the snapshot path below.
  const native = await tryNativeSessionFork({ input, source, provisionalTitle });
  if (native) {
    // The resumed session already carries the provider history; the first turn
    // is only the caller's text (plus user attachments/images).
    await runForkFirstTurn({
      input,
      agentId: native.agentId,
      attachments: input.attachments,
    });
    return { agentId: native.agentId, strategy: "native" };
  }

  const snapshot = await createSnapshotFork({ input, source, provisionalTitle });
  await runForkFirstTurn({
    input,
    agentId: snapshot.agentId,
    attachments: snapshot.attachments,
  });
  return { agentId: snapshot.agentId, strategy: "snapshot" };
}

/**
 * Resolve the source agent, falling back to its stored record when it is not
 * live. The projection carries the fields both fork strategies need, notably
 * the persisted provider handle (native session file) for the native path.
 */
async function resolveSourceAgent(input: ForkAgentInput): Promise<ManagedAgent> {
  const live = input.agentManager.getAgent(input.sourceAgentId);
  if (live) {
    return live;
  }
  const record = await input.agentStorage.get(input.sourceAgentId);
  if (!record) {
    throw new Error(`Agent ${input.sourceAgentId} not found`);
  }
  return projectStoredAgentForFork(record);
}
/** Minimal ManagedAgent projection from a stored record for fork strategies. */
function projectStoredAgentForFork(record: StoredAgentRecord): ManagedAgent {
  // Optional fields are copied as-is; fork paths only read the subset they need.
  // eslint-disable-next-line complexity -- structural projection of optional config fields
  const config = {
    provider: record.provider,
    cwd: record.cwd,
    title: record.title ?? null,
    ...record.config,
  };
  return {
    id: record.id,
    cwd: record.cwd,
    workspaceId: record.workspaceId,
    provider: record.provider,
    config,
    // A reconstructed agent resumes from its stored provider handle (native
    // session file) when one exists; without it the fork falls back to the
    // snapshot path.
    persistence: record.persistence ?? null,
    currentModeId: record.lastModeId ?? record.config?.modeId ?? null,
    labels: record.labels ?? {},
  } as unknown as ManagedAgent;
}

/**
 * Fork via the provider's own session: copy the source's OMP session JSONL to
 * a fresh file and resume a brand-new agent from the copy. Returns null when
 * the source cannot be cloned natively (not OMP, no session-file handle, or
 * the file is missing), so the caller falls back to the snapshot path.
 */
async function tryNativeSessionFork(params: {
  input: ForkAgentInput;
  source: ManagedAgent;
  provisionalTitle: string | null;
}): Promise<{ agentId: string } | null> {
  const { input, source, provisionalTitle } = params;

  // Native clone+resume is only implemented for OMP session files today, and
  // only when the fork stays on OMP — a provider switch cannot reuse the file.
  const forkProvider = input.overrides?.provider ?? source.config.provider;
  if (source.provider !== "omp" || forkProvider !== "omp") {
    return null;
  }

  const handle = source.persistence;
  if (!handle || typeof handle.nativeHandle !== "string" || handle.nativeHandle.trim() === "") {
    return null;
  }

  // resolveOmpSessionFile finds the real file when the handle is a stub or
  // stale path; a file that still cannot be resolved has no durable session.
  const resolvedFile = await resolveOmpSessionFile(handle.nativeHandle);
  const fileStat = await stat(resolvedFile).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size === 0) {
    return null;
  }

  const targetUserTurnCount = resolveForkTargetUserTurnCount(input);
  const clonedFile = await cloneOmpSessionFile(
    resolvedFile,
    targetUserTurnCount !== undefined ? { targetUserTurnCount } : undefined,
  );
  const forkConfig = buildNativeForkConfig({ input, source, provisionalTitle });
  const metadata = buildForkPersistenceMetadata(forkConfig, source.cwd);

  const resumed = await input.agentManager.resumeAgentFromPersistence(
    {
      provider: "omp",
      sessionId: handle.sessionId,
      nativeHandle: clonedFile,
      metadata,
    },
    forkConfig,
    undefined,
    {
      workspaceId: source.workspaceId,
      ...(input.labels ? { labels: input.labels } : {}),
      initialTitle: provisionalTitle,
    },
  );
  return { agentId: resumed.id };
}

function resolveForkTargetUserTurnCount(input: ForkAgentInput): number | undefined {
  if (!input.boundary?.cursor && !input.boundary?.messageId) {
    return undefined;
  }
  const timeline = input.agentManager.fetchTimeline(input.sourceAgentId, {
    direction: "tail",
    limit: 0,
  });
  const selected = selectForkContextRows({
    rows: timeline.rows,
    cursorBoundary: input.boundary.cursor
      ? { timelineEpoch: timeline.epoch, cursor: input.boundary.cursor }
      : null,
    boundaryMessageId: input.boundary.messageId,
  });
  return selected.items.filter((item) => item.type === "user_message").length;
}

function buildForkPersistenceMetadata(
  forkConfig: Partial<AgentSessionConfig>,
  defaultCwd: string,
): AgentMetadata {
  return {
    cwd: forkConfig.cwd ?? defaultCwd,
    ...(forkConfig.model ? { model: forkConfig.model } : {}),
    ...(forkConfig.thinkingOptionId ? { thinkingOptionId: forkConfig.thinkingOptionId } : {}),
    ...(forkConfig.modeId ? { modeId: forkConfig.modeId } : {}),
    ...(forkConfig.systemPrompt ? { systemPrompt: forkConfig.systemPrompt } : {}),
    ...(forkConfig.systemPromptMode ? { systemPromptMode: forkConfig.systemPromptMode } : {}),
    ...(forkConfig.toolAllowlist?.length ? { toolAllowlist: forkConfig.toolAllowlist } : {}),
  };
}

/**
 * Same-provider (OMP) fork config: carry the source's launch config — system
 * prompt, tool policy, model/mode/thinking — and apply the caller's overrides.
 * Mirrors the snapshot path's same-provider inheritance.
 */
function buildNativeForkConfig(params: {
  input: ForkAgentInput;
  source: ManagedAgent;
  provisionalTitle: string | null;
}): Partial<AgentSessionConfig> {
  const { input, source, provisionalTitle } = params;
  const modeId = source.currentModeId ?? source.config.modeId;
  return {
    ...(source.config.systemPrompt ? { systemPrompt: source.config.systemPrompt } : {}),
    ...(source.config.systemPromptMode ? { systemPromptMode: source.config.systemPromptMode } : {}),
    ...(source.config.toolAllowlist?.length ? { toolAllowlist: source.config.toolAllowlist } : {}),
    ...(source.config.mcpServers ? { mcpServers: source.config.mcpServers } : {}),
    ...(source.config.model ? { model: source.config.model } : {}),
    ...(source.config.thinkingOptionId ? { thinkingOptionId: source.config.thinkingOptionId } : {}),
    ...(modeId ? { modeId } : {}),
    ...(source.config.featureValues ? { featureValues: source.config.featureValues } : {}),
    ...(source.config.providerOptions ? { providerOptions: source.config.providerOptions } : {}),
    ...(source.config.toolPolicy ? { toolPolicy: source.config.toolPolicy } : {}),
    ...input.overrides,
    provider: "omp",
    // A fork stays in the source's workspace directory.
    cwd: source.config.cwd,
    title: provisionalTitle,
    // A fork is a fresh, user-visible sibling regardless of whether the source
    // was an internal/system agent.
    internal: false,
  };
}

async function createSnapshotFork(params: {
  input: ForkAgentInput;
  source: ManagedAgent;
  provisionalTitle: string | null;
}): Promise<{ agentId: string; attachments: AgentAttachment[] }> {
  const { input, source, provisionalTitle } = params;
  const timeline = input.agentManager.fetchTimeline(input.sourceAgentId, {
    direction: "tail",
    limit: 0,
  });
  const forkContext = buildAgentForkContextAttachment({
    rows: timeline.rows,
    // No boundary => everything up to now.
    cursorBoundary: input.boundary?.cursor
      ? { timelineEpoch: timeline.epoch, cursor: input.boundary.cursor }
      : null,
    boundaryMessageId: input.boundary?.messageId ?? null,
    agentTitle: source.config.title ?? null,
    cwd: source.cwd,
  });

  // A fork that lands on a different provider than the source keeps only the
  // provider-agnostic config. providerOptions/toolPolicy and the
  // model/mode/thinking trio are provider-specific and are nonsense on the
  // new provider; the fork composer's overrides supply correct ones. Forking
  // across providers is only possible at all because the history travels as a
  // transcript rather than a resumed provider session.
  const switchedProvider =
    input.overrides?.provider != null && input.overrides.provider !== source.config.provider;
  const inherited: Partial<AgentSessionConfig> = switchedProvider
    ? {
        ...(source.config.systemPrompt ? { systemPrompt: source.config.systemPrompt } : {}),
        ...(source.config.mcpServers ? { mcpServers: source.config.mcpServers } : {}),
      }
    : source.config;
  const config: AgentSessionConfig = {
    ...inherited,
    ...input.overrides,
    provider: input.overrides?.provider ?? source.config.provider,
    // A fork stays in the source's workspace directory.
    cwd: source.config.cwd,
    title: provisionalTitle,
    // A fork is a fresh, user-visible sibling regardless of whether the source
    // was an internal/system agent.
    internal: false,
  };
  const created = await input.agentManager.createAgent(config, undefined, {
    workspaceId: source.workspaceId,
    initialTitle: provisionalTitle,
    ...(input.labels ? { labels: input.labels } : {}),
  });

  const attachments: AgentAttachment[] = [...(input.attachments ?? []), forkContext.attachment];
  return { agentId: created.id, attachments };
}

async function runForkFirstTurn(params: {
  input: ForkAgentInput;
  agentId: string;
  attachments?: AgentAttachment[];
}): Promise<void> {
  const { input } = params;
  const prompt: AgentPromptInput = buildAgentPrompt(input.text, input.images, params.attachments);
  await sendPromptToAgent({
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    agentId: params.agentId,
    prompt,
    messageId: input.messageId,
    logger: input.logger,
  });
}
