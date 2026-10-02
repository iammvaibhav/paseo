import type { AgentUsage } from "../../agent-sdk-types.js";
import type { OmpSessionStats } from "./rpc-types.js";

export interface OmpUsagePollScheduler {
  schedulePoll(callback: () => void): () => void;
}

interface OmpUsagePollerOptions {
  readStats(): Promise<OmpSessionStats>;
  onUsage(usage: AgentUsage, turnId?: string): void;
  onPollError(error: unknown): void;
  scheduler?: OmpUsagePollScheduler;
}

function createScheduler(): OmpUsagePollScheduler {
  return {
    schedulePoll: (callback) => {
      const timer = setTimeout(callback, 3_000);
      return () => clearTimeout(timer);
    },
  };
}

interface OmpUsageCounters {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  contextWindowMaxTokens: number | undefined;
  contextWindowUsedTokens: number | undefined;
}

function readOmpUsageCounters(stats: OmpSessionStats): OmpUsageCounters {
  return {
    inputTokens: stats.tokens?.input ?? 0,
    cachedInputTokens: stats.tokens?.cacheRead ?? 0,
    // Turn-metrics: report session cacheWrite alongside the other counters.
    cacheWriteTokens: stats.tokens?.cacheWrite ?? 0,
    outputTokens: stats.tokens?.output ?? 0,
    totalCostUsd: stats.cost ?? 0,
    contextWindowMaxTokens: stats.contextUsage?.contextWindow ?? undefined,
    contextWindowUsedTokens: stats.contextUsage?.tokens ?? undefined,
  };
}

function hasOmpUsage(counters: OmpUsageCounters): boolean {
  return (
    counters.inputTokens !== 0 ||
    counters.cachedInputTokens !== 0 ||
    counters.cacheWriteTokens !== 0 ||
    counters.outputTokens !== 0 ||
    counters.totalCostUsd !== 0 ||
    counters.contextWindowMaxTokens !== undefined ||
    counters.contextWindowUsedTokens !== undefined
  );
}

function toAgentUsage(stats: OmpSessionStats): AgentUsage | undefined {
  const counters = readOmpUsageCounters(stats);
  if (!hasOmpUsage(counters)) return undefined;
  const { cacheWriteTokens, contextWindowMaxTokens, contextWindowUsedTokens, ...rest } = counters;
  return {
    ...rest,
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(typeof contextWindowMaxTokens === "number" ? { contextWindowMaxTokens } : {}),
    ...(typeof contextWindowUsedTokens === "number" ? { contextWindowUsedTokens } : {}),
  };
}

function isSameUsage(left: AgentUsage, right: AgentUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalCostUsd === right.totalCostUsd &&
    left.contextWindowMaxTokens === right.contextWindowMaxTokens &&
    left.contextWindowUsedTokens === right.contextWindowUsedTokens
  );
}

export class OmpUsagePoller {
  private readonly scheduler: OmpUsagePollScheduler;
  private active = false;
  private closed = false;
  private generation = 0;
  private cancelScheduledPoll: (() => void) | null = null;
  private lastUsage: AgentUsage | null = null;

  constructor(private readonly options: OmpUsagePollerOptions) {
    this.scheduler = options.scheduler ?? createScheduler();
  }

  startTurn(): void {
    if (this.closed || this.active) {
      return;
    }
    this.active = true;
    this.generation += 1;
    this.schedule(this.generation);
  }

  stopTurn(): void {
    this.active = false;
    this.invalidatePendingWork();
  }

  async completeTurn(turnId?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.active = false;
    const completionGeneration = this.invalidatePendingWork();
    let usage: AgentUsage | undefined;
    try {
      usage = toAgentUsage(await this.options.readStats());
    } catch {
      return;
    }
    if (this.closed || this.generation !== completionGeneration) {
      return;
    }
    this.publishUsage(usage, turnId);
  }

  close(): void {
    this.closed = true;
    this.active = false;
    this.invalidatePendingWork();
  }

  private invalidatePendingWork(): number {
    this.generation += 1;
    this.cancelScheduledPoll?.();
    this.cancelScheduledPoll = null;
    return this.generation;
  }

  private schedule(generation: number): void {
    this.cancelScheduledPoll = this.scheduler.schedulePoll(() => {
      this.cancelScheduledPoll = null;
      void this.poll(generation);
    });
  }

  private async poll(generation: number): Promise<void> {
    let usage: AgentUsage | undefined;
    try {
      usage = toAgentUsage(await this.options.readStats());
    } catch (error) {
      try {
        if (this.active && !this.closed && this.generation === generation) {
          this.options.onPollError(error);
        }
      } finally {
        if (this.active && !this.closed && this.generation === generation) {
          this.schedule(generation);
        }
      }
      return;
    }
    try {
      if (this.active && !this.closed && this.generation === generation) {
        this.publishUsage(usage);
      }
    } finally {
      if (this.active && !this.closed && this.generation === generation) {
        this.schedule(generation);
      }
    }
  }

  private takeChangedUsage(usage: AgentUsage | undefined): AgentUsage | undefined {
    if (!usage || (this.lastUsage && isSameUsage(this.lastUsage, usage))) {
      return undefined;
    }
    this.lastUsage = usage;
    return usage;
  }

  private publishUsage(usage: AgentUsage | undefined, turnId?: string): void {
    const changedUsage = this.takeChangedUsage(usage);
    if (changedUsage) {
      this.options.onUsage(changedUsage, turnId);
    }
  }
}
