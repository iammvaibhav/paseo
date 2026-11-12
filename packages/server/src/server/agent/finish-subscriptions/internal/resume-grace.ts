import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import { buildStoredAgentPayload } from "../../agent-projections.js";
import type { FinishObservationResult } from "./observation-buffer.js";

export const RESTART_RESUME_GRACE_MS = 10 * 60_000;

/**
 * A daemon restart closes a running child mid-turn, but its finish subscription survives.
 * Report the run the child resumes (the deploy nudge restarts it) instead of the idle state
 * the restart left behind.
 *
 * Returns null when the child was not interrupted by the restart or once its resumed run
 * starts; returns the interruption to report when no run starts within the grace period.
 */
export async function awaitResumedChildRun(input: {
  agentManager: Pick<AgentManager, "getAgent" | "subscribe" | "getLastAssistantMessage">;
  agentStorage: Pick<AgentStorage, "get">;
  childAgentId: string;
  signal: AbortSignal;
  graceMs?: number;
}): Promise<FinishObservationResult | null> {
  const { agentManager, childAgentId, signal } = input;
  if (agentManager.getAgent(childAgentId)?.lifecycle === "running") return null;
  const stored = await input.agentStorage.get(childAgentId);
  // Shutdown closes a mid-turn agent with error attention; any other state is a real outcome.
  const interrupted =
    stored?.lastStatus === "closed" &&
    stored.requiresAttention === true &&
    stored.attentionReason === "error";
  if (!interrupted) return null;

  // The caller stops on abort; resolving keeps the abort out of the failure log.
  const { promise: resumedRun, resolve } = Promise.withResolvers<boolean>();
  const unsubscribe = agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.lifecycle === "running") resolve(true);
    },
    { agentId: childAgentId, replayState: false },
  );
  const timer = setTimeout(() => resolve(false), input.graceMs ?? RESTART_RESUME_GRACE_MS);
  const onAbort = () => resolve(true);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted || agentManager.getAgent(childAgentId)?.lifecycle === "running") {
    resolve(true);
  }
  const resumed = await resumedRun;
  clearTimeout(timer);
  unsubscribe();
  signal.removeEventListener("abort", onAbort);
  if (resumed) return null;

  const latest = (await input.agentStorage.get(childAgentId)) ?? stored;
  return {
    status: "error",
    final: buildStoredAgentPayload(latest, [latest.provider]),
    lastMessage: await agentManager.getLastAssistantMessage(childAgentId),
    error: null,
    reason: "was interrupted by a daemon restart and did not resume",
  };
}
