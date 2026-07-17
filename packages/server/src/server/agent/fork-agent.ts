import type { Logger } from "pino";

import {
  buildAgentForkContextAttachment,
  buildInFlightWorkAttachment,
} from "./activity-curator.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import { buildAgentPrompt } from "./prompt-attachments.js";
import type { AgentAttachment } from "../messages.js";

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
  logger: Logger;
}

export interface ForkAgentResult {
  agentId: string;
  strategy: "native" | "snapshot";
}

/**
 * Fork a source agent (typically running) into a brand-new sibling/root agent
 * that inherits its history "up to now" (the last completed turn), then run the
 * caller's `text` as the fork's first turn. The source agent is never touched.
 *
 * Two strategies, chosen by provider capability — the caller sees the same
 * result either way:
 *   - native:   the provider's session-fork primitive (Claude `forkSession`,
 *               etc.) mints a new provider session carrying the live context
 *               and prompt cache. The fork resumes it.
 *   - snapshot: a fresh session seeded with a chat-history text attachment
 *               rendered from the source timeline. Provider-agnostic fallback.
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
    // Native fork resumes the provider session up to the last user message. The
    // agent's still-streaming work on that message isn't in the forked session
    // (resuming a partial assistant turn is invalid), so carry it in as context
    // text alongside the caller's prompt.
    const inFlight = buildInFlightWorkAttachment({
      rows: input.agentManager.fetchTimeline(input.sourceAgentId, { direction: "tail", limit: 0 })
        .rows,
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
  const handle = await session.forkSessionForNewAgent();
  // Fresh title so the fork stands on its own; sibling status is implied by
  // omitting the parent-agent label from options.labels.
  const overrides = provisionalTitle ? { title: provisionalTitle } : {};
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
    cursorBoundary: null,
    // No boundary => everything up to now.
    boundaryMessageId: null,
    agentTitle: source.config.title ?? null,
    cwd: source.cwd,
  });

  const config = {
    ...source.config,
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
