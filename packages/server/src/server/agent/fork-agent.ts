import type { Logger } from "pino";

import { buildAgentForkContextAttachment } from "./activity-curator.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import type { AgentPromptInput, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import { buildAgentPrompt } from "./prompt-attachments.js";
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
  logger: Logger;
}

export interface ForkAgentResult {
  agentId: string;
}

/**
 * Fork a source agent (typically running) into a brand-new sibling/root agent
 * seeded with its history up to `boundary` (default: "up to now"), then run the
 * caller's `text` as the fork's first turn. The source agent is never touched.
 *
 * One strategy for every provider: a fresh session whose first prompt carries a
 * chat-history text attachment rendered from the source timeline. The fork does
 * not resume or branch the provider-side session, so nothing depends on a
 * provider fork primitive and the history is sliced at exactly the requested
 * point in the daemon timeline.
 */
export async function forkAgentToSibling(input: ForkAgentInput): Promise<ForkAgentResult> {
  const { agentManager, agentStorage } = input;
  let source = agentManager.getAgent(input.sourceAgentId);
  if (!source) {
    const record = await agentStorage.get(input.sourceAgentId);
    if (!record) {
      throw new Error(`Agent ${input.sourceAgentId} not found`);
    }
    source = {
      id: record.id,
      cwd: record.cwd,
      workspaceId: record.workspaceId,
      provider: record.provider,
      config: {
        provider: record.provider,
        cwd: record.cwd,
        title: record.title ?? null,
        systemPrompt: record.config?.systemPrompt ?? null,
        mcpServers: record.config?.mcpServers ?? null,
      },
    } as unknown as ManagedAgent;
  }
  // A provisional title derived from the fork's first prompt keeps the new tab
  // from being an exact duplicate of the source title.
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: null,
    initialPrompt: input.text,
  });

  const snapshot = await createSnapshotFork({ input, source, provisionalTitle });
  await runForkFirstTurn({
    input,
    agentId: snapshot.agentId,
    attachments: snapshot.attachments,
  });
  return { agentId: snapshot.agentId };
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
  // provider-agnostic config. `extra`, approval/sandbox policy and the
  // model/mode/thinking trio are all provider-specific and are nonsense on the
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
