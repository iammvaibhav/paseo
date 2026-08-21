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
  // Called after every completed fresh fetch (client-triggered or RPC
  // force-refresh) so the owner can push the updated usage to clients.
  onUsageRefreshed?: (result: ProviderUsageListResult) => void;
  // Dynamic enablement resolver: consulted per refresh so config toggles apply live.
  isFetcherEnabled?: (fetcher: ProviderUsageFetcher) => boolean;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly onUsageRefreshed: (result: ProviderUsageListResult) => void;
  private readonly isFetcherEnabled: (fetcher: ProviderUsageFetcher) => boolean;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private enablementChangedDuringFetch = false;
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
    this.onUsageRefreshed = options.onUsageRefreshed ?? (() => {});
    this.isFetcherEnabled = options.isFetcherEnabled ?? (() => true);
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
      const result = await request;
      if (this.enablementChangedDuringFetch) {
        this.enablementChangedDuringFetch = false;
        this.cached = null;
        return await this.listUsage({ forceRefresh: true });
      }
      return result;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
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
  /**
   * The set of enabled providers has changed in configuration.
   * Drops cached usage and triggers a fresh fetch so disabled provider cards
   * disappear immediately and newly enabled ones are fetched and broadcast.
   */
  notifyProviderEnablementChanged(): void {
    if (this.disposed) {
      return;
    }
    this.cached = null;
    if (this.inFlight) {
      this.enablementChangedDuringFetch = true;
      return;
    }
    void this.listUsage({ forceRefresh: true });
  }

  dispose(): void {
    this.disposed = true;
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const activeFetchers = this.fetchers.filter((fetcher) => this.isFetcherEnabled(fetcher));
    const settled = await Promise.allSettled(activeFetchers.map((fetcher) => fetcher.fetchUsage()));
    const fetchedAt = new Date(nowMs).toISOString();
    const providers: ProviderUsage[] = [];
    for (const [index, result] of settled.entries()) {
      const fetcher = activeFetchers[index];
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
