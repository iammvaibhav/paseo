import { prepareAgentMessage, type AgentPromptSource } from "./agent-messages/index.js";
import type { Logger } from "pino";

import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { AgentModeId } from "@getpaseo/protocol/agent-modes";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "reloadStalePluginSession"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export interface StartAgentRunOptions {
  /** Called after selecting the run, before consuming its events. */
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = options.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId,
      turnId: snapshot?.activeForegroundTurnId,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (await agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    options?.onDispatch?.("out_of_band");
    return { disposition: "out_of_band" };
  }
  await refreshProviderSessionBeforeRun(agentManager, agentId, logger);
  try {
    await agentManager.reloadStalePluginSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    await agentManager.reloadAgentSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    options?.onDispatch?.("steered");
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  options?.onDispatch?.("turn_started");
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        await drainAgentRunIterator(retry.iterator);
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { disposition: "turn_started" };
}

/**
 * Reload the provider session before a prompt is dispatched at it when the
 * session cannot serve the run as-is:
 *
 * - Its runtime is gone. A dead runtime used to be terminal: `startTurn`
 *   rejected with the provider's "process is closed" diagnostic, every later
 *   prompt failed the same way until someone ran Reload agent by hand, and the
 *   sticky `running` lifecycle kept the composer spinning.
 * - The agent moved to another workspace directory since the session started
 *   (`sessionCwdStale`). The provider process still runs in the old directory.
 *
 * Reloading resumes the provider session from its persistence handle in the
 * agent's current cwd and keeps the timeline. Best-effort: if the reload
 * fails, the prompt still goes to the old session so the user gets the
 * provider's real error instead of a reload error.
 */
async function refreshProviderSessionBeforeRun(
  agentManager: AgentRunController,
  agentId: string,
  logger: Logger,
): Promise<void> {
  const snapshot = agentManager.getAgent(agentId);
  const session = snapshot && "session" in snapshot ? snapshot.session : null;
  if (!snapshot) {
    return;
  }
  const runtimeDead = session?.isRuntimeAlive?.() === false;
  // A reload cancels an in-flight run; a moved cwd waits for an idle agent.
  const cwdMoved = snapshot.sessionCwdStale === true && !agentManager.hasInFlightRun(agentId);
  if (!runtimeDead && !cwdMoved) {
    return;
  }
  logger.warn(
    {
      agentId,
      provider: snapshot.provider,
      lifecycle: snapshot.lifecycle,
      reason: runtimeDead ? "dead_runtime" : "cwd_moved",
      cwd: snapshot.cwd,
    },
    "agent.run.reloading_provider_session",
  );
  try {
    await agentManager.reloadAgentSession(agentId);
  } catch (error) {
    logger.warn({ err: error, agentId }, "agent.run.provider_session_reload_failed");
  }
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

export interface SendPromptToAgentParams {
  onDispatch?: StartAgentRunOptions["onDispatch"];
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /**
   * Who supersedes the in-flight run when this prompt replaces one (user
   * interrupt-and-send vs machinery dispatch). Rides the run options to
   * replaceAgentRun so the superseded run's terminal failure can be treated
   * as that party's interruption (see AgentRunOptions.replaceOrigin).
   */
  replaceOrigin?: "user" | "machinery";
  /**
   * Default true: the prompt supersedes an in-flight run. Queue delivery
   * passes false after waiting for the agent to go idle, so a run that
   * started in the meantime is never cancelled.
   */
  replaceRunning?: boolean;
  /** Optional provider session mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Optional agent mode for this prompt. Selected before the run starts, so
   * its block rides this prompt (the run start adds it; see streamAgent).
   */
  agentMode?: AgentModeId;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentStorage: AgentStorage;
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

// Above this, "pressed send, nothing happened" is a real complaint rather than
// normal provider handshake cost. Logged as a warn so it is greppable without
// turning on trace.
const SLOW_PROMPT_DISPATCH_MS = 1_500;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, {
      signal: signal ? AbortSignal.any([startAbort.signal, signal]) : startAbort.signal,
    });
  } finally {
    clearTimeout(startTimeout);
  }
}

async function resolvePromptSource(
  source: AgentPromptSource | undefined,
  manager: Pick<AgentManager, "getAgent">,
  storage: AgentStorage,
): Promise<AgentPromptSource | undefined> {
  if (!source || source.title) return source;
  const title = (
    manager.getAgent(source.agentId)?.config.title ?? (await storage.get(source.agentId))?.title
  )?.trim();
  return title ? { ...source, title } : source;
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * session mode and agent mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const source = await resolvePromptSource(params.source, params.agentManager, params.agentStorage);
  const delivery = prepareAgentMessage(params.prompt, source, params.messageId);
  return sendPreparedPromptToAgent({
    ...params,
    prompt: delivery.prompt,
    runOptions: delivery.messageId
      ? { ...params.runOptions, clientMessageId: delivery.messageId }
      : params.runOptions,
  });
}

/** Dispatch daemon-prepared context without reclassifying it as human input. */
export async function sendPreparedPromptToAgent(
  params: Omit<SendPromptToAgentParams, "source" | "messageId">,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const unarchive = params.unarchive ?? true;
  const startedAt = Date.now();
  let unarchiveMs = 0;
  let ensureLoadedMs = 0;
  let setModeMs = 0;

  const record = await params.agentStorage.get(params.agentId);
  const wasClosed = record?.lastStatus === "closed";
  let archivedAtToRestore: string | null = null;
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started" };
    }
    const unarchiveStartedAt = Date.now();
    if (await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId)) {
      archivedAtToRestore = record.archivedAt;
    }
    unarchiveMs = Date.now() - unarchiveStartedAt;
  }

  const ensureLoadedStartedAt = Date.now();
  try {
    await ensureAgentLoaded(params.agentId, {
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      logger: params.logger,
    });
  } catch (error) {
    // A send that could not load the agent leaves it where it was: still archived.
    // Concurrent sends share this load, so none of them holds a live session.
    if (archivedAtToRestore) {
      await params.agentManager.archiveSnapshot(params.agentId, archivedAtToRestore);
    }
    throw error;
  }
  ensureLoadedMs = Date.now() - ensureLoadedStartedAt;

  if (params.sessionMode) {
    const setModeStartedAt = Date.now();
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
    setModeMs = Date.now() - setModeStartedAt;
  }
  if (params.agentMode) {
    await params.agentManager.selectAgentMode(params.agentId, params.agentMode);
  }

  const runOptions: AgentRunOptions = {
    ...params.runOptions,
    ...(params.replaceOrigin ? { replaceOrigin: params.replaceOrigin } : {}),
  };

  const startRunStartedAt = Date.now();
  try {
    return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
      replaceRunning: params.replaceRunning ?? true,
      onDispatch: params.onDispatch,
      activeTurnBehavior: params.activeTurnBehavior,
      clearPendingPermissions: params.clearPendingPermissions,
      runOptions,
    });
  } finally {
    // "I pressed send and nothing happened for a while" is measured here.
    // `startAgentRun` returns before the provider acknowledges the prompt, so
    // the remaining latency to the spinner lives in `agent.turn.dispatched`.
    const totalMs = Date.now() - startedAt;
    const payload = {
      agentId: params.agentId,
      wasClosed,
      unarchiveMs,
      ensureLoadedMs,
      setModeMs,
      startRunMs: Date.now() - startRunStartedAt,
      totalMs,
    };
    if (totalMs >= SLOW_PROMPT_DISPATCH_MS) {
      params.logger.warn(payload, "agent.prompt.dispatch_slow");
    } else {
      params.logger.info(payload, "agent.prompt.dispatch");
    }
  }
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const delivery = prepareAgentMessage(
    params.prompt,
    await resolvePromptSource(params.source, params.agentManager, params.agentStorage),
    params.runOptions?.clientMessageId,
  );
  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    delivery.prompt,
    params.logger,
    { runOptions: { ...params.runOptions, clientMessageId: delivery.messageId } },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}
