import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import {
  markBestAlternative,
  unavailableUsage,
  withHeadroom,
  withProviderTimeout,
} from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  isFetcherEnabled?: (fetcher: ProviderUsageFetcher) => boolean;
  // Called after every completed fresh fetch (client-triggered or RPC
  // force-refresh) so the owner can push the updated usage to clients.
  onUsageRefreshed?: (result: ProviderUsageListResult) => void;
  // COMPAT(fastProviderUsage): per-provider push. Called as each individual
  // fetcher finishes its background refresh; the owner broadcasts
  // provider.usage.updated with just that provider's cards.
  onProviderRefreshed?: (result: ProviderUsageProviderResult) => void;
}
export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export interface ProviderUsageProviderResult {
  fetchedAt: string;
  providerId: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
// COMPAT(fastProviderUsage): background revalidation cadence once a client has
// asked for usage. listUsage answers from cache instantly; this keeps the cache
// warm without hammering OAuth endpoints.
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly onUsageRefreshed: (result: ProviderUsageListResult) => void;
  private readonly onProviderRefreshed: (result: ProviderUsageProviderResult) => void;
  private readonly isFetcherEnabled: (fetcher: ProviderUsageFetcher) => boolean;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private readonly providerInFlight = new Map<string, Promise<ProviderUsage[]>>();
  private readonly providerLastRefreshMs = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
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
    this.onProviderRefreshed = options.onProviderRefreshed ?? (() => {});
    this.isFetcherEnabled = options.isFetcherEnabled ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: {
    forceRefresh?: boolean;
    providerId?: string;
  }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    const scope = options?.providerId?.trim() || undefined;
    const cached = this.cached;
    if (cached && this.isFresh(cached, nowMs) && !options?.forceRefresh) {
      return this.applyScope(cached.result, scope);
    }
    // Stale-while-revalidate: serve the cached snapshot instantly and refresh
    // each provider independently in the background; per-provider pushes stream
    // the fresh cards as they land.
    if (cached && !options?.forceRefresh) {
      this.refreshInBackground();
      return this.applyScope(cached.result, scope);
    }
    if (cached && options?.forceRefresh && !scope) {
      this.refreshInBackground({ force: true });
      return cached.result;
    }

    if (this.inFlight) {
      return this.applyScope(await this.inFlight, scope);
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      const result = await request;
      if (this.enablementChangedDuringFetch) {
        this.enablementChangedDuringFetch = false;
        this.cached = null;
        return await this.listUsage({ forceRefresh: true, providerId: scope });
      }
      return this.applyScope(result, scope);
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private isFresh(
    cached: { fetchedAtMs: number; result: ProviderUsageListResult },
    nowMs: number,
  ): boolean {
    return nowMs - cached.fetchedAtMs < this.cacheTtlMs;
  }

  private applyScope(
    result: ProviderUsageListResult,
    scope: string | undefined,
  ): ProviderUsageListResult {
    return scope ? this.scopeResult(result, scope) : result;
  }

  /**
   * A client connected. Serve from cache and revalidate in the background when
   * stale, so the newly opened app renders instantly and fresh cards stream in
   * via pushes; the refresh broadcast reaches every connected client.
   */
  notifyClientConnected(): void {
    const nowMs = this.now();
    if (this.cached && nowMs - this.cached.fetchedAtMs < this.cacheTtlMs) {
      return;
    }
    if (this.cached) {
      this.refreshInBackground();
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
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scopeResult(
    result: ProviderUsageListResult,
    providerId: string,
  ): ProviderUsageListResult {
    const wanted = providerId.toLowerCase();
    return {
      fetchedAt: result.fetchedAt,
      providers: result.providers.filter(
        (usage) =>
          usage.providerId.toLowerCase() === wanted || usage.groupId?.toLowerCase() === wanted,
      ),
    };
  }

  private ensureBackgroundTimer(): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setInterval(() => {
      if (this.disposed) return;
      if (!this.cached) return;
      this.refreshInBackground();
    }, BACKGROUND_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  private refreshInBackground(options?: { force?: boolean }): void {
    this.ensureBackgroundTimer();
    const activeFetchers = this.fetchers.filter((fetcher) => this.isFetcherEnabled(fetcher));
    for (const fetcher of activeFetchers) {
      void this.refreshOneProvider(fetcher, { force: options?.force });
    }
  }

  private async refreshOneProvider(
    fetcher: ProviderUsageFetcher,
    options?: { force?: boolean },
  ): Promise<ProviderUsage[]> {
    const key = fetcher.providerId;
    const running = this.providerInFlight.get(key);
    if (running) return running;
    const last = this.providerLastRefreshMs.get(key) ?? -Infinity;
    if (!options?.force && this.cached && this.now() - last < this.cacheTtlMs) {
      return this.cardsForFetcher(this.cached.result, fetcher);
    }
    const run = this.fetchOneProvider(fetcher);
    this.providerInFlight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.providerInFlight.get(key) === run) {
        this.providerInFlight.delete(key);
      }
    }
  }

  private cardsForFetcher(
    result: ProviderUsageListResult,
    fetcher: ProviderUsageFetcher,
  ): ProviderUsage[] {
    const ids = new Set(
      [fetcher.providerId, ...(fetcher.agentProviderIds ?? [])].map((id) => id.toLowerCase()),
    );
    return result.providers.filter(
      (usage) =>
        ids.has(usage.providerId.toLowerCase()) ||
        (usage.groupId ? ids.has(usage.groupId.toLowerCase()) : false),
    );
  }

  private normalizeCards(
    value: ProviderUsage | ProviderUsage[],
    fetchedAt: string,
  ): ProviderUsage[] {
    const list = Array.isArray(value) ? value : [value];
    const nowMs = this.now();
    return list.map((usage) => withHeadroom({ ...usage, fetchedAt }, nowMs));
  }

  private mergeProviders(all: ProviderUsage[], fresh: ProviderUsage[]): ProviderUsage[] {
    const freshKeys = new Set(fresh.map((usage) => providerCardKey(usage)));
    const kept = all.filter((usage) => !freshKeys.has(providerCardKey(usage)));
    return [...kept, ...fresh];
  }

  private async fetchOneProvider(fetcher: ProviderUsageFetcher): Promise<ProviderUsage[]> {
    const fetchedAt = new Date(this.now()).toISOString();
    let cards: ProviderUsage[];
    try {
      const value = await withProviderTimeout(fetcher.fetchUsage());
      cards = this.normalizeCards(value, fetchedAt);
    } catch (error) {
      this.logger.debug(
        { err: error, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      cards = [
        withHeadroom(
          {
            ...unavailableUsage({
              providerId: fetcher.providerId,
              displayName: fetcher.displayName,
              error: error instanceof Error ? error.message : String(error),
            }),
            fetchedAt,
          },
          this.now(),
        ),
      ];
    }
    this.providerLastRefreshMs.set(fetcher.providerId, this.now());
    const previous = this.cached?.result.providers ?? [];
    const merged = markBestAlternative(this.mergeProviders(previous, cards), this.now());
    this.cached = {
      fetchedAtMs: this.cached?.fetchedAtMs ?? this.now(),
      result: { fetchedAt: this.cached?.result.fetchedAt ?? fetchedAt, providers: merged },
    };
    this.onProviderRefreshed({ fetchedAt, providerId: fetcher.providerId, providers: cards });
    return cards;
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const activeFetchers = this.fetchers.filter((fetcher) => this.isFetcherEnabled(fetcher));
    const settled = await Promise.allSettled(
      activeFetchers.map((fetcher) => withProviderTimeout(fetcher.fetchUsage())),
    );
    const fetchedAt = new Date(nowMs).toISOString();
    const providers: ProviderUsage[] = [];
    for (const [index, result] of settled.entries()) {
      const fetcher = activeFetchers[index]!;
      if (result.status === "fulfilled") {
        const value = result.value;
        if (Array.isArray(value)) {
          for (const usage of value) {
            // Always stamp the list-response time so "Updated Xm ago" reflects this
            // daemon fetch, not a nested provider-side cache timestamp (OMP CLI).
            providers.push(withHeadroom({ ...usage, fetchedAt }, nowMs));
          }
        } else {
          providers.push(withHeadroom({ ...value, fetchedAt }, nowMs));
        }
        this.providerLastRefreshMs.set(fetcher.providerId, nowMs);
        continue;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      providers.push(
        withHeadroom(
          {
            ...unavailableUsage({
              providerId: fetcher.providerId,
              displayName: fetcher.displayName,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            }),
            fetchedAt,
          },
          nowMs,
        ),
      );
    }

    const withHints = markBestAlternative(providers, nowMs);
    const result = { fetchedAt, providers: withHints };
    this.cached = { fetchedAtMs: nowMs, result };
    this.ensureBackgroundTimer();
    this.onUsageRefreshed(result);
    return result;
  }
}

function providerCardKey(usage: ProviderUsage): string {
  return [usage.providerId, usage.groupId ?? "", usage.accountEmail ?? ""].join(":");
}
