import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { FileAgentTimelineStore } from "../agent/file-agent-timeline-store.js";
import {
  supportsDiskTimeline,
  tryReadProviderTimelineFromDisk,
} from "../agent/provider-disk-history.js";
import { resolveGrokUpdatesPath } from "../agent/providers/grok-history.js";
import type { ExtractableTimelineEntry } from "./extract.js";

export interface TranscriptSource {
  path: string | null;
  mtimeMs: number;
  entries: ExtractableTimelineEntry[];
}

export interface TranscriptSourceDeps {
  timelineStore: FileAgentTimelineStore;
  logger: Logger;
}

/**
 * Load the indexable transcript for one stored agent. Native harness files
 * (omp/claude/grok) are the source of truth; Paseo's agent-timelines JSON is
 * the fallback for ACP harnesses that keep no readable local file.
 *
 * Does not call seedTimelineForRehydrate — that would write a timeline file
 * as a side effect of search.
 */
export async function loadTranscriptSource(
  record: StoredAgentRecord,
  deps: TranscriptSourceDeps,
): Promise<TranscriptSource | null> {
  const nativePath = nativeHandlePath(record);
  const diskEntries = await readProviderEntries(record, deps.logger);
  if (diskEntries) {
    const path = nativePath ?? grokPath(record);
    const mtimeMs = await statMtime(path, record);
    return { path, mtimeMs, entries: diskEntries };
  }

  const rows = await deps.timelineStore.tryReadExistingRows(record.id);
  if (!rows || rows.length === 0) {
    return null;
  }
  const path = deps.timelineStore.filePathFor(record.id);
  const mtimeMs = await statMtime(path, record);
  return {
    path,
    mtimeMs,
    entries: rows.map((row) => ({ item: row.item, timestamp: row.timestamp })),
  };
}

async function readProviderEntries(
  record: StoredAgentRecord,
  logger: Logger,
): Promise<ExtractableTimelineEntry[] | null> {
  const sessionId = record.persistence?.sessionId;
  if (!sessionId || !supportsDiskTimeline(record.provider)) {
    return null;
  }
  const nativeHandle = nativeHandlePath(record);
  const imported = await tryReadProviderTimelineFromDisk(
    {
      provider: record.provider,
      cwd: record.cwd,
      sessionId,
      ...(nativeHandle ? { nativeHandle } : {}),
    },
    { logger },
  );
  if (!imported || imported.length === 0) {
    return null;
  }
  return imported.map((entry) => ({
    item: entry.item,
    timestamp: entry.timestamp,
  }));
}

function nativeHandlePath(record: StoredAgentRecord): string | null {
  const handle = record.persistence?.nativeHandle;
  if (typeof handle !== "string") return null;
  const trimmed = handle.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function grokPath(record: StoredAgentRecord): string | null {
  if (record.provider !== "grok") return null;
  const sessionId = record.persistence?.sessionId;
  if (!sessionId) return null;
  return resolveGrokUpdatesPath({ cwd: record.cwd, sessionId });
}

async function statMtime(path: string | null, record: StoredAgentRecord): Promise<number> {
  if (path) {
    try {
      const info = await stat(path);
      return Math.trunc(info.mtimeMs);
    } catch {
      // Fall through to the record clock — missing files still need a
      // stable signal so the sweep does not re-read them every five minutes.
    }
  }
  const updated = Date.parse(record.updatedAt);
  return Number.isFinite(updated) ? updated : 0;
}
