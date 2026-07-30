import type { Logger } from "pino";

import {
  buildAgentForkContextAttachment,
  buildInFlightWorkAttachment,
} from "./activity-curator.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import type {
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import { buildAgentPrompt } from "./prompt-attachments.js";
import type { AgentAttachment } from "../messages.js";

export interface ForkAgentBoundary {
  /**
   * Provider id of the user message that opened the boundary turn. The only
   * anchor a native provider fork can address; without it a boundary fork
   * degrades to snapshot.
   */
  userMessageId?: string;
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
  logger: Logger;
}

export interface ForkAgentResult {
  agentId: string;
  strategy: "native" | "snapshot";
}

/**
 * Fork a source agent (typically running) into a brand-new sibling/root agent
 * that inherits its history up to `boundary` (default: "up to now", the last
 * completed turn), then run the caller's `text` as the fork's first turn. The
 * source agent is never touched.
 *
 * Two strategies, chosen by provider capability — the caller sees the same
 * result either way:
 *   - native:   the provider's session-fork primitive (Claude `forkSession`,
 *               OMP session-file branch copy) mints a new provider session
 *               carrying the live context and prompt cache. The fork resumes it.
 *   - snapshot: a fresh session seeded with a chat-history text attachment
 *               rendered from the source timeline. Provider-agnostic fallback,
 *               and where a native fork lands when the provider can't resolve
 *               the requested boundary in its own history.
 */
export async function forkAgentToSibling(input: ForkAgentInput): Promise<ForkAgentResult> {
  const { agentManager } = input;
  const source = agentManager.getAgent(input.sourceAgentId);
  if (!source) {
    throw new Error(`Agent ${input.sourceAgentId} not found`);
  }

  // A provisional title derived from the fork's first prompt keeps the new tab
  // from being an exact duplicate of the source title.
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: null,
    initialPrompt: input.text,
  });

  const native = await tryNativeFork({ input, source, provisionalTitle });
  if (native) {
    // A boundary-less native fork resumes the provider session up to the last
    // user message. The agent's still-streaming work on that message isn't in
    // the forked session (resuming a partial assistant turn is invalid), so
    // carry it in as context text alongside the caller's prompt. A fork at an
    // explicit boundary is deliberately anchored in the past — later in-flight
    // work is what the user chose to leave behind.
    const inFlight = input.boundary
      ? null
      : buildInFlightWorkAttachment({
          rows: input.agentManager.fetchTimeline(input.sourceAgentId, {
            direction: "tail",
            limit: 0,
          }).rows,
          agentTitle: source.config.title ?? null,
        });
    const attachments = inFlight ? [...(input.attachments ?? []), inFlight] : input.attachments;
    await runForkFirstTurn({ input, agentId: native.id, attachments });
    return { agentId: native.id, strategy: "native" };
  }

  const snapshot = await createSnapshotFork({ input, source, provisionalTitle });
  await runForkFirstTurn({
    input,
    agentId: snapshot.agentId,
    attachments: snapshot.attachments,
  });
  return { agentId: snapshot.agentId, strategy: "snapshot" };
}

async function tryNativeFork(params: {
  input: ForkAgentInput;
  source: ManagedAgent;
  provisionalTitle: string | null;
}): Promise<ManagedAgent | null> {
  const { input, source, provisionalTitle } = params;
  if (!("session" in source)) {
    return null;
  }
  const session = source.session;
  if (!session || typeof session.forkSessionForNewAgent !== "function") {
    return null;
  }
  const boundaryUserMessageId = input.boundary?.userMessageId?.trim();
  // A boundary the provider can't address natively must not silently widen the
  // fork to the full session — fall back to the snapshot, which slices the
  // daemon timeline at exactly the requested point.
  if (input.boundary && !boundaryUserMessageId) {
    return null;
  }
  let handle: AgentPersistenceHandle;
  try {
    handle = await session.forkSessionForNewAgent(
      boundaryUserMessageId ? { userMessageId: boundaryUserMessageId } : undefined,
    );
  } catch (error) {
    // Provider-native fork is best-effort: an unresolvable boundary, a session
    // that never persisted, or a provider-side failure all degrade to snapshot
    // rather than failing the user's fork.
    input.logger.warn(
      { err: error, sourceAgentId: input.sourceAgentId },
      "Native session fork failed; falling back to a chat-history snapshot fork",
    );
    return null;
  }
  // Fresh title so the fork stands on its own; sibling status is implied by
  // omitting the parent-agent label from options.labels.
  const overrides = {
    ...input.overrides,
    ...(provisionalTitle ? { title: provisionalTitle } : {}),
  };
  const created = await input.agentManager.resumeAgentFromPersistence(
    handle,
    overrides,
    undefined,
    {
      workspaceId: source.workspaceId,
    },
  );
  await input.agentManager.hydrateTimelineFromProvider(created.id);
  return created;
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

  const config = {
    ...source.config,
    ...input.overrides,
    title: provisionalTitle,
    // A snapshot fork is a fresh, user-visible sibling regardless of whether the
    // source was an internal/system agent.
    internal: false,
  };
  const created = await input.agentManager.createAgent(config, undefined, {
    workspaceId: source.workspaceId,
    initialTitle: provisionalTitle,
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
