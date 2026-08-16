/**
 * Client-side loader observability: one span from the click that starts an
 * agent (create, fork, or send) until the agent's lifecycle flips to
 * "running", when the UI swaps the loader for the Stop control.
 *
 * The span lives client-side only: the daemon does not return timing on the
 * create/send responses, so the total is measured from the user click to the
 * status update that ends the loader. Completed spans log one structured
 * event, `agent.loader.complete`.
 */

import { useSessionStore } from "@/stores/session-store";

export type AgentLoaderPath = "create" | "resume" | "send";

interface AgentLoaderSpan {
  path: AgentLoaderPath;
  startedAt: number;
}

const activeSpans = new Map<string, AgentLoaderSpan>();

function agentSpanKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

function pendingSpanKey(serverId: string, pendingId: string): string {
  return `pending:${serverId}:${pendingId}`;
}

/**
 * Start a loader span for an agent that already has an id (the send path).
 * Idempotent: the first click wins so a span is never restarted mid-loader.
 * An agent that is already running shows no loader, so it starts no span.
 */
export function beginAgentLoaderSpan(
  serverId: string,
  agentId: string,
  path: AgentLoaderPath,
): void {
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.agents.get(agentId)?.status === "running") {
    return;
  }
  const key = agentSpanKey(serverId, agentId);
  if (activeSpans.has(key)) {
    return;
  }
  activeSpans.set(key, { path, startedAt: Date.now() });
}

/**
 * Start a loader span before the created agent has an id (the create/fork
 * path). The caller resolves it onto the real agent id once the create
 * response arrives.
 */
export function beginPendingAgentLoaderSpan(
  serverId: string,
  pendingId: string,
  path: AgentLoaderPath,
): void {
  const key = pendingSpanKey(serverId, pendingId);
  if (activeSpans.has(key)) {
    return;
  }
  activeSpans.set(key, { path, startedAt: Date.now() });
}

/**
 * Move a pending span onto the created agent id, keeping the start time.
 * `alreadyRunning` is the status carried by the create response: the daemon
 * sends agent_created after waitForAgentRunStart, so it is normally true and
 * the span completes here — the directory-sync flip (previous !== running &&
 * accepted === running) will never fire for a response that already says
 * running.
 */
export function resolvePendingAgentLoaderSpan(
  serverId: string,
  pendingId: string,
  agentId: string,
  alreadyRunning?: boolean,
): void {
  const pendingKey = pendingSpanKey(serverId, pendingId);
  const span = activeSpans.get(pendingKey);
  if (!span) {
    return;
  }
  activeSpans.delete(pendingKey);
  const agentKey = agentSpanKey(serverId, agentId);
  if (activeSpans.has(agentKey)) {
    return;
  }
  activeSpans.set(agentKey, span);
  if (alreadyRunning) {
    completeAgentLoaderSpan(serverId, agentId);
  }
}

/** Discard a pending span, e.g. after a failed create. */
export function clearPendingAgentLoaderSpan(serverId: string, pendingId: string): void {
  activeSpans.delete(pendingSpanKey(serverId, pendingId));
}

/**
 * Log the completed loader span for an agent whose lifecycle just flipped to
 * running. Idempotent; no-op when no span is active. Reports to the daemon
 * (which persists it in daemon.log) when the host advertises the feature;
 * console always gets the line so desktop devtools still show it.
 */
export function completeAgentLoaderSpan(serverId: string, agentId: string): void {
  const key = agentSpanKey(serverId, agentId);
  const span = activeSpans.get(key);
  if (!span) {
    return;
  }
  activeSpans.delete(key);
  const totalMs = Date.now() - span.startedAt;
  const startedAt = span.startedAt;
  console.info("[AgentLoader]", "agent.loader.complete", {
    path: span.path,
    totalMs,
    serverId,
    agentId,
  });
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.serverInfo?.features?.loaderSpanReport === true && session.client) {
    session.client.sendLoaderSpanReport({
      agentId,
      path: span.path,
      totalMs,
      startedAt,
    });
  }
}
