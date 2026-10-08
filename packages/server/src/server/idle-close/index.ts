import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import {
  MISSION_CONTROL_LABEL_KEY,
  MISSION_CONTROL_LABEL_VALUE,
} from "../mission-control/commander-contract.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";

// How often the sweep runs.
const SWEEP_INTERVAL_MS = 30_000;
// The only provider whose processes resume from the warm pool.
const OMP_PROVIDER = "omp";
// Applied when the daemon config does not carry the knob (defensive; the
// schema default is 1800).
const DEFAULT_IDLE_CLOSE_AFTER_SECONDS = 1800;

export interface IdleCloseOmpOptions {
  agentManager: AgentManager;
  daemonConfigStore: DaemonConfigStore;
  logger: Logger;
  /** Overridable for tests. */
  sweepIntervalMs?: number;
}

/**
 * Periodically closes idle OMP processes so the host does not keep warm
 * processes the user has stopped using. The knob lives in the daemon config
 * (`ompIdleCloseAfterSeconds`; 0 disables the sweep), so a settings change
 * takes effect on the next sweep without a restart. A closed agent resumes
 * from the warm pool on the next send.
 *
 * The sweep only touches idle OMP agents: it skips the Commander, agents with
 * a pending permission prompt, and agents with a running provider subagent.
 * Non-OMP providers are never closed here.
 */
export class IdleCloseOmpService {
  private readonly agentManager: AgentManager;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly logger: Logger;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(options: IdleCloseOmpOptions) {
    this.agentManager = options.agentManager;
    this.daemonConfigStore = options.daemonConfigStore;
    this.logger = options.logger.child({ module: "idle-close" });
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const timer = setInterval(() => {
      void this.sweep().catch((error) => {
        this.logger.error({ err: error }, "Failed to sweep idle OMP agents");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep pass; exposed so tests can drive it without waiting. */
  async sweep(): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      await this.closeEligibleIdleAgents();
    } finally {
      this.sweeping = false;
    }
  }

  private async closeEligibleIdleAgents(): Promise<void> {
    const configured = this.daemonConfigStore.get().ompIdleCloseAfterSeconds;
    const thresholdSeconds =
      typeof configured === "number" ? configured : DEFAULT_IDLE_CLOSE_AFTER_SECONDS;
    if (thresholdSeconds <= 0) {
      return;
    }

    const cutoffMs = Date.now() - thresholdSeconds * 1000;
    const runningSubagentParentIds = new Set<string>();
    for (const subagent of this.agentManager.listProviderSubagentActivity()) {
      if (subagent.status === "running") {
        runningSubagentParentIds.add(subagent.parentAgentId);
      }
    }

    const closeTasks: Promise<void>[] = [];
    for (const agent of this.agentManager.listAgents()) {
      if (agent.provider !== OMP_PROVIDER) {
        continue;
      }
      if (agent.lifecycle !== "idle") {
        continue;
      }
      if (agent.labels[MISSION_CONTROL_LABEL_KEY] === MISSION_CONTROL_LABEL_VALUE) {
        continue;
      }
      if (agent.pendingPermissions.size > 0) {
        continue;
      }
      if (runningSubagentParentIds.has(agent.id)) {
        continue;
      }
      if (agent.updatedAt.getTime() > cutoffMs) {
        continue;
      }
      closeTasks.push(this.closeAgentSafely(agent.id, agent.updatedAt.getTime()));
    }

    await Promise.all(closeTasks);
  }

  private async closeAgentSafely(agentId: string, updatedAtMs: number): Promise<void> {
    try {
      await this.agentManager.closeAgent(agentId);
      this.logger.info(
        {
          agentId,
          idleSeconds: Math.round((Date.now() - updatedAtMs) / 1000),
        },
        "Closed idle OMP agent",
      );
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to close idle OMP agent");
    }
  }
}
