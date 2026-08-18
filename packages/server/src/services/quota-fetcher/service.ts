import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  // Background refresh cadence while agents run vs. when the daemon is idle.
  // Injectable for tests; defaults to 60s running / 15min idle.
  refreshCadenceMs?: { running: number; idle: number };
  // True while any agent is running; the scheduler re-arms at the matching cadence.
  hasRunningAgent?: () => boolean;
  // Called after every completed fresh fetch (scheduled, client-triggered, or
  // RPC force-refresh) so the owner can push the updated usage to clients.
  onUsageRefreshed?: (result: ProviderUsageListResult) => void;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_CADENCE_MS = { running: 60_000, idle: 900_000 };

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly refreshCadenceMs: { running: number; idle: number };
  private readonly hasRunningAgent: () => boolean;
  private readonly onUsageRefreshed: (result: ProviderUsageListResult) => void;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRunningState: boolean | null = null;
  private disposed = false;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.refreshCadenceMs = options.refreshCadenceMs ?? DEFAULT_REFRESH_CADENCE_MS;
    this.hasRunningAgent = options.hasRunningAgent ?? (() => false);
    this.onUsageRefreshed = options.onUsageRefreshed ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  /**
   * Starts the background refresh loop. The next refresh fires after the cadence
   * matching the current running-agent state, and re-arms on each completed fetch.
   */
  start(): void {
    if (this.refreshTimer || this.disposed) {
      return;
    }
    this.lastRunningState = this.hasRunningAgent();
    this.armRefreshTimer();
  }

  /**
   * The daemon's running-agent state may have changed (an agent started or
   * stopped). Re-arms the timer only when the boolean state actually flipped,
   * so per-agent state events during a run never postpone the refresh.
   */
  notifyAgentStatusChanged(): void {
    if (this.disposed || this.refreshTimer === null) {
      return;
    }
    const running = this.hasRunningAgent();
    if (running === this.lastRunningState) {
      return;
    }
    this.lastRunningState = running;
    this.armRefreshTimer();
  }

  /**
   * A client connected. Fetch fresh usage now when the cache is empty or stale
   * so the newly opened app gets pushed data quickly; the refresh broadcast
   * reaches every connected client.
   */
  notifyClientConnected(): void {
    const nowMs = this.now();
    if (this.cached && nowMs - this.cached.fetchedAtMs < this.cacheTtlMs) {
      return;
    }
    void this.listUsage({ forceRefresh: true });
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private armRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const delayMs = this.hasRunningAgent()
      ? this.refreshCadenceMs.running
      : this.refreshCadenceMs.idle;
    const timer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runScheduledRefresh();
    }, delayMs);
    timer.unref?.();
    this.refreshTimer = timer;
  }

  private async runScheduledRefresh(): Promise<void> {
    await this.listUsage({ forceRefresh: true });
    if (!this.disposed) {
      this.armRefreshTimer();
    }
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(this.fetchers.map((fetcher) => fetcher.fetchUsage()));
    const fetchedAt = new Date(nowMs).toISOString();
    const providers: ProviderUsage[] = [];
    for (const [index, result] of settled.entries()) {
      const fetcher = this.fetchers[index];
      if (result.status === "fulfilled") {
        const value = result.value;
        if (Array.isArray(value)) {
          for (const usage of value) {
            // Always stamp the list-response time so "Updated Xm ago" reflects this
            // daemon fetch, not a nested provider-side cache timestamp (OMP CLI).
            providers.push({ ...usage, fetchedAt });
          }
        } else {
          providers.push({ ...value, fetchedAt });
        }
        continue;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      providers.push(
        unavailableUsage({
          providerId: fetcher.providerId,
          displayName: fetcher.displayName,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }),
      );
    }

    const result = { fetchedAt, providers };
    this.cached = { fetchedAtMs: nowMs, result };
    this.onUsageRefreshed(result);
    return result;
  }
}
