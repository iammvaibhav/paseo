import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { ProviderSnapshotEntrySchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentProvider, ProviderSnapshotEntry } from "./agent-sdk-types.js";

const PROVIDER_CATALOG_STORE_VERSION = 1;

const PersistedProviderCatalogEntrySchema = z.object({
  cacheKey: z.string(),
  fetchedAt: z.string(),
  daemonVersion: z.string(),
  result: ProviderSnapshotEntrySchema,
});

const PersistedProviderCatalogFileSchema = z.object({
  version: z.literal(PROVIDER_CATALOG_STORE_VERSION),
  providers: z.record(z.string(), PersistedProviderCatalogEntrySchema),
});

export type PersistedProviderCatalogEntry = z.infer<typeof PersistedProviderCatalogEntrySchema>;

export interface ProviderCatalogStoreOptions {
  paseoHome: string;
  logger: Logger;
  daemonVersion: string;
}

/**
 * Persists the last successful provider catalog fetch (models/modes) to
 * `$PASEO_HOME/provider-catalogs.json`, so a daemon restart can serve a
 * ready snapshot without spawning a provider process just to answer "what
 * models does this provider have". Models are host-scoped and rarely
 * change, so this cache never goes stale on its own — only a genuine
 * catalog-affecting config change or the composer refresh button replaces
 * an entry.
 *
 * There is no migration framework: an unreadable file, a version mismatch
 * on the whole file, or a `daemonVersion` mismatch on one entry is dropped
 * (that entry, or the whole file) and rebuilt on the next successful fetch.
 */
export class ProviderCatalogStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly daemonVersion: string;
  private entries: Map<AgentProvider, PersistedProviderCatalogEntry> | null = null;

  constructor(options: ProviderCatalogStoreOptions) {
    this.filePath = path.join(options.paseoHome, "provider-catalogs.json");
    this.logger = options.logger.child({ module: "provider-catalog-store" });
    this.daemonVersion = options.daemonVersion;
  }

  /**
   * Synchronous so callers (the snapshot manager's constructor) can restore
   * before anything else has a chance to race a first read and spawn a
   * provider process for a catalog that is already on disk.
   */
  loadSync(): ReadonlyMap<AgentProvider, PersistedProviderCatalogEntry> {
    if (this.entries) return this.entries;
    this.entries = this.readEntriesSync();
    if (this.entries.size > 0) {
      this.logger.info(
        {
          providers: [...this.entries.keys()],
          fetchedAt: Object.fromEntries(
            [...this.entries].map(([provider, entry]) => [provider, entry.fetchedAt]),
          ),
        },
        "provider.catalog.restored",
      );
    }
    return this.entries;
  }

  async persist(
    provider: AgentProvider,
    cacheKey: string,
    result: ProviderSnapshotEntry,
  ): Promise<void> {
    const entries = new Map(this.entries ?? this.readEntriesSync());
    const entry: PersistedProviderCatalogEntry = {
      cacheKey,
      fetchedAt: new Date().toISOString(),
      daemonVersion: this.daemonVersion,
      result,
    };
    entries.set(provider, entry);
    this.entries = entries;
    await writeJsonFileAtomic(this.filePath, {
      version: PROVIDER_CATALOG_STORE_VERSION,
      providers: Object.fromEntries(entries),
    });
    this.logger.info({ provider, fetchedAt: entry.fetchedAt }, "provider.catalog.persisted");
  }

  private readEntriesSync(): Map<AgentProvider, PersistedProviderCatalogEntry> {
    if (!existsSync(this.filePath)) return new Map();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read persisted provider catalog");
      return new Map();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn({ err: error }, "Persisted provider catalog is not valid JSON; dropping");
      return new Map();
    }
    const result = PersistedProviderCatalogFileSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        { issues: result.error.issues.map((issue) => issue.message) },
        "Persisted provider catalog failed validation; dropping",
      );
      return new Map();
    }
    const entries = new Map<AgentProvider, PersistedProviderCatalogEntry>();
    for (const [provider, entry] of Object.entries(result.data.providers)) {
      // No migration path: an entry written by a different daemon build may
      // no longer match this build's expectations even though it still
      // parses, so only reuse entries from the running version.
      if (entry.daemonVersion !== this.daemonVersion) continue;
      entries.set(provider, entry);
    }
    return entries;
  }
}
