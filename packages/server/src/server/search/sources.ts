import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
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
  logger: Logger;
}

/**
 * Load the indexable transcript for one stored agent. Native harness files
 * (omp/claude/grok) are the source of truth. Agents whose provider keeps no
 * readable local file are not indexable: Paseo's own agent-timelines JSON
 * store was removed when timelines returned to runtime memory, so there is no
 * second source to fall back to.
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

  return null;
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
