import type { Logger } from "pino";

import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "streamAgent"
  | "reloadAgentSession"
  | "beforeAgentRun"
>;

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  runOptions?: AgentRunOptions;
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ outOfBand: boolean }> {
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
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { outOfBand: true };
  }
  await recoverDeadProviderRuntime(agentManager, agentId, logger);
  // Per-turn pre-run seam (Commander world-snapshot injection): the hook may
  // dispatch its own machinery turn ahead of this prompt. Runs after the
  // dead-runtime recovery so the injected turn starts on a live session, and
  // after the out-of-band check so OOB commands never trigger injection.
  // typeof-guarded so manager shims without the seam stay no-ops.
  if (typeof agentManager.beforeAgentRun === "function") {
    await agentManager.beforeAgentRun({
      agentId,
      prompt,
      runOptions: options?.runOptions,
      replaceRunning: options?.replaceRunning,
    });
  }
  const shouldReplace = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const runOptions = options?.runOptions;
  const iterator = shouldReplace
    ? await agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId,
      shouldReplace,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
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
  return { outOfBand: false };
}

/**
 * Reload a session whose provider runtime is gone, before the prompt is
 * dispatched at it.
 *
 * A dead runtime used to be terminal: `startTurn` rejected, the turn failed
 * with the provider's "process is closed" diagnostic, and every later prompt
 * failed the same way until someone ran Reload agent by hand. Reloading here
 * resumes the provider session from its persistence handle, keeps the timeline,
 * and clears the sticky `running` lifecycle that made the composer spin over a
 * runtime doing nothing.
 *
 * Recovery is best-effort: if the reload fails, the prompt still goes to the old
 * session so the user gets the provider's real error instead of a reload error.
 */
async function recoverDeadProviderRuntime(
  agentManager: AgentRunController,
  agentId: string,
  logger: Logger,
): Promise<void> {
  const snapshot = agentManager.getAgent(agentId);
  const session = snapshot && "session" in snapshot ? snapshot.session : null;
  if (!snapshot || session?.isRuntimeAlive?.() !== false) {
    return;
  }
  logger.warn(
    { agentId, provider: snapshot.provider, lifecycle: snapshot.lifecycle },
    "agent.run.reloading_dead_provider_runtime",
  );
  try {
    await agentManager.reloadAgentSession(agentId);
  } catch (error) {
    logger.warn({ err: error, agentId }, "agent.run.dead_provider_runtime_reload_failed");
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

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  /**
   * Who supersedes the in-flight run when this prompt replaces one (user
   * interrupt-and-send vs machinery dispatch). Rides the run options to
   * replaceAgentRun so the superseded run's terminal failure can be treated
   * as that party's interruption (see AgentRunOptions.replaceOrigin).
   */
  replaceOrigin?: "user" | "machinery";
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * One line prepended to a newly created agent's first prompt envelope so the
 * agent knows its own identity ("what's the status of the task involving X"
 * is answerable by the agent itself and by the Commander). Provider-agnostic:
 * applied here, the single dispatch chokepoint shared by every create surface
 * (Session/WS, MCP, CLI-through-MCP).
 */
export function buildAgentIdentityEnvelope(input: {
  name?: string;
  title?: string | null;
}): string {
  if (!input.name) {
    return "";
  }
  return `Your agent name is ${input.name}; task title: ${input.title ?? "(untitled)"}. Paseo tracks you by this identity.`;
}

const AGENT_RUN_START_TIMEOUT_MS = 15_000;

// Above this, "pressed send, nothing happened" is a real complaint rather than
// normal provider handshake cost. Logged as a warn so it is greppable without
// turning on trace.
const SLOW_PROMPT_DISPATCH_MS = 1_500;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const startAbort = new AbortController();
  const startTimeout = setTimeout(() => startAbort.abort("timeout"), AGENT_RUN_START_TIMEOUT_MS);

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns `{ outOfBand: false }`) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ outOfBand: boolean }> {
  const unarchive = params.unarchive ?? true;
  const startedAt = Date.now();
  let unarchiveMs = 0;
  let ensureLoadedMs = 0;
  let setModeMs = 0;

  const record = await params.agentStorage.get(params.agentId);
  const wasClosed = record?.lastStatus === "closed";
  if (record?.archivedAt) {
    if (!unarchive) {
      return { outOfBand: false };
    }
    const unarchiveStartedAt = Date.now();
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
    unarchiveMs = Date.now() - unarchiveStartedAt;
  }

  const ensureLoadedStartedAt = Date.now();
  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });
  ensureLoadedMs = Date.now() - ensureLoadedStartedAt;

  if (params.sessionMode) {
    const setModeStartedAt = Date.now();
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
    setModeMs = Date.now() - setModeStartedAt;
  }

  const runOptions: AgentRunOptions = {
    ...params.runOptions,
    ...(params.messageId ? { clientMessageId: params.messageId } : {}),
    ...(params.replaceOrigin ? { replaceOrigin: params.replaceOrigin } : {}),
  };

  const startRunStartedAt = Date.now();
  try {
    return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
      replaceRunning: true,
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

  // Identity injection: tell the created agent its own name/title before its
  // first turn. Reads the persisted record (name is stamped at registration,
  // before the initial prompt is dispatched).
  let prompt = params.prompt;
  try {
    const record = await params.agentStorage.get(params.agentId);
    const identityLine = buildAgentIdentityEnvelope({
      name: record?.name ?? currentSnapshot.name,
      title: record?.title ?? currentSnapshot.config.title,
    });
    if (identityLine) {
      prompt = Array.isArray(prompt)
        ? [{ type: "text", text: `${identityLine}\n` }, ...prompt]
        : `${identityLine}\n${prompt}`;
    }
  } catch (error) {
    params.logger.warn(
      { err: error, agentId: params.agentId },
      "Failed to inject agent identity into initial prompt",
    );
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (!dispatchResult.outOfBand) {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: "finished" | "errored" | "needs permission";
  lastAssistantMessage: string | null;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (!lastAssistantMessage) {
    return statusLine;
  }
  return `${statusLine}\n\n<agent-response>\n${lastAssistantMessage}\n</agent-response>`;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let fired = false;
  let unsubscribe: (() => void) | null = null;

  async function notify(reason: "finished" | "errored" | "needs permission"): Promise<void> {
    if (fired) {
      return;
    }
    fired = true;
    unsubscribe?.();

    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
    });

    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: callerAgentId,
      prompt: formatSystemNotificationPrompt(body),
      unarchive: false,
      logger,
    });
  }

  function notifySafely(reason: "finished" | "errored" | "needs permission"): void {
    void notify(reason).catch((error) => {
      logger.error(
        { err: error, childAgentId, callerAgentId, reason },
        "Failed to notify caller agent",
      );
    });
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired) {
        return;
      }

      if (event.type === "agent_state") {
        if (event.agent.lifecycle === "running") {
          hasSeenRunning = true;
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          notifySafely("finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          fired = true;
          unsubscribe?.();
          return;
        }
        return;
      }

      if (event.event.type === "permission_requested") {
        notifySafely("needs permission");
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    unsubscribe();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
