import { setImmediate as scheduleImmediate } from "node:timers";
import pThrottle from "p-throttle";

export interface GitProcessPolicy {
  maxProcessesPerSecond: number;
  maxProcessConcurrency: number;
  /** Concurrency slots normal-priority git work may never fully consume, so a
   * high-priority create-path command always finds a free slot instead of
   * queuing behind bulk metadata-watch/observation traffic. */
  reservedHighPrioritySlots?: number;
}

export const DEFAULT_GIT_PROCESS_POLICY: GitProcessPolicy = {
  maxProcessesPerSecond: 64,
  maxProcessConcurrency: 8,
  reservedHighPrioritySlots: 2,
};

export interface ScheduledGitProcess<T> {
  result: Promise<T>;
  exited: Promise<void>;
}

export type GitProcessPriority = "normal" | "high";

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveGitProcessPolicy(input: {
  env: NodeJS.ProcessEnv;
  persisted?: Partial<GitProcessPolicy>;
}): GitProcessPolicy {
  return {
    maxProcessesPerSecond:
      parsePositiveInteger(input.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND) ??
      input.persisted?.maxProcessesPerSecond ??
      DEFAULT_GIT_PROCESS_POLICY.maxProcessesPerSecond,
    maxProcessConcurrency:
      parsePositiveInteger(input.env.PASEO_GIT_MAX_PROCESS_CONCURRENCY) ??
      // COMPAT(gitConcurrencyEnv): renamed in v0.2.6; remove after 2027-02-02.
      parsePositiveInteger(input.env.PASEO_GIT_CONCURRENCY) ??
      input.persisted?.maxProcessConcurrency ??
      DEFAULT_GIT_PROCESS_POLICY.maxProcessConcurrency,
    reservedHighPrioritySlots:
      (input.persisted?.reservedHighPrioritySlots !== undefined &&
      Number.isInteger(input.persisted.reservedHighPrioritySlots) &&
      input.persisted.reservedHighPrioritySlots >= 0
        ? input.persisted.reservedHighPrioritySlots
        : undefined) ?? DEFAULT_GIT_PROCESS_POLICY.reservedHighPrioritySlots,
  };
}

export class GitProcessScheduler {
  private readonly startThrottled;
  private readonly highPriorityQueue: Array<() => void> = [];
  private readonly normalPriorityQueue: Array<() => void> = [];
  // Normal-priority work never occupies more than maxProcessConcurrency minus
  // this many slots, clamped so it always keeps at least one slot even when
  // the configured reserve would otherwise consume the whole pool.
  private readonly reservedHighPrioritySlots: number;
  private admitted = 0;
  private running = 0;
  private waiting = 0;
  private drainScheduled = false;

  constructor(readonly policy: GitProcessPolicy) {
    const throttle = pThrottle({
      limit: policy.maxProcessesPerSecond,
      interval: 1_000,
      strict: true,
    });
    this.startThrottled = throttle((start: () => Promise<void>) => start());
    this.reservedHighPrioritySlots = Math.min(
      policy.reservedHighPrioritySlots ?? DEFAULT_GIT_PROCESS_POLICY.reservedHighPrioritySlots ?? 0,
      Math.max(0, policy.maxProcessConcurrency - 1),
    );
  }

  get activeCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.waiting;
  }

  run<T>(
    start: () => ScheduledGitProcess<T>,
    options?: { priority?: GitProcessPriority },
  ): Promise<T> {
    this.waiting += 1;
    return new Promise<T>((resolve, reject) => {
      const admit = () => {
        void this.startThrottled(() => this.execute(start, resolve, reject)).catch((error) => {
          // The throttle never released this job into `execute`, so it never
          // occupied a concurrency slot — only `waiting` needs unwinding.
          this.waiting = Math.max(0, this.waiting - 1);
          reject(error);
          this.scheduleDrain();
        });
      };
      const queue =
        options?.priority === "high" ? this.highPriorityQueue : this.normalPriorityQueue;
      queue.push(admit);
      if (this.admitted === 0 && !this.drainScheduled) {
        this.drainOne();
      } else {
        this.scheduleDrain();
      }
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.admitted >= this.policy.maxProcessConcurrency) {
      return;
    }
    if (this.highPriorityQueue.length === 0 && this.normalPriorityQueue.length === 0) {
      return;
    }
    this.drainScheduled = true;
    scheduleImmediate(() => this.drainOne());
  }

  private drainOne(): void {
    this.drainScheduled = false;
    if (this.admitted >= this.policy.maxProcessConcurrency) {
      return;
    }
    if (this.highPriorityQueue.length > 0) {
      this.highPriorityQueue.shift()!();
      return;
    }
    // Reserved slots are held back from normal-priority work even when no
    // high-priority job is currently queued, so one always finds a slot
    // immediately instead of waiting behind bulk observation traffic.
    if (this.admitted >= this.policy.maxProcessConcurrency - this.reservedHighPrioritySlots) {
      return;
    }
    const admit = this.normalPriorityQueue.shift();
    if (!admit) {
      return;
    }
    admit();
  }

  private async execute<T>(
    start: () => ScheduledGitProcess<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ): Promise<void> {
    this.waiting = Math.max(0, this.waiting - 1);
    this.running += 1;
    // Only now — once the rate throttle has actually released this job — does
    // it occupy a real concurrency slot. Counting it earlier (while it merely
    // waited its turn in the throttle) understated free capacity and starved
    // the reserved high-priority lane. Re-arm the drain loop against this
    // fresh count instead of the stale one at admission time.
    this.admitted += 1;
    this.scheduleDrain();
    try {
      const process = start();
      void process.result.then(resolve, reject);
      await process.exited;
    } catch (error) {
      reject(error);
    } finally {
      this.running = Math.max(0, this.running - 1);
      this.admitted = Math.max(0, this.admitted - 1);
      this.scheduleDrain();
    }
  }
}
