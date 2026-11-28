/**
 * Offline provider timeline readers for fast agent open without process spawn.
 *
 * Supported today:
 * - grok: ~/.grok/sessions/.../updates.jsonl (ACP update stream)
 * - claude: ~/.claude/projects/.../<sessionId>.jsonl (existing history ingest)
 * - omp: persistence.nativeHandle session JSONL (streamOmpHistory offline path)
 */
import type { Logger } from "pino";

import type { ImportedTimelineEntry } from "./agent-sdk-types.js";
import { readClaudeTimelineFromDisk } from "./providers/claude-history.js";
import { readGrokTimelineFromDisk } from "./providers/grok-history.js";
import { readOmpTimelineFromDisk } from "./providers/omp/omp-history.js";
import { readMockTimelineFromDisk } from "./providers/mock-load-test-agent.js";

export interface DiskHistorySource {
  provider: string;
  cwd: string;
  sessionId: string;
  /** Absolute native session path when the provider stores one (OMP/Pi). */
  nativeHandle?: string;
}
async function tryReadOmpDiskTimeline(
  nativeHandle: string | undefined,
  sessionId: string,
  logger?: Logger,
): Promise<ImportedTimelineEntry[] | null> {
  const sessionFile = typeof nativeHandle === "string" ? nativeHandle.trim() : "";
  if (!sessionFile) {
    return null;
  }
  try {
    return await readOmpTimelineFromDisk({ sessionFile, logger });
  } catch (error) {
    logger?.warn({ err: error, sessionId, provider: "omp" }, "OMP disk history read failed");
    return null;
  }
}

export async function tryReadProviderTimelineFromDisk(
  source: DiskHistorySource,
  options?: { logger?: Logger },
): Promise<ImportedTimelineEntry[] | null> {
  const { provider, cwd, sessionId, nativeHandle } = source;

  if (provider === "omp") {
    return tryReadOmpDiskTimeline(nativeHandle, sessionId, options?.logger);
  }
  if (provider === "mock") {
    return readMockTimelineFromDisk({ sessionId });
  }

  if (!cwd || !sessionId) {
    return null;
  }

  if (provider === "grok") {
    try {
      const items = readGrokTimelineFromDisk({ cwd, sessionId });
      return items?.map((item) => ({ item })) ?? null;
    } catch (error) {
      options?.logger?.warn({ err: error, sessionId, provider }, "Grok disk history read failed");
      return null;
    }
  }

  if (provider === "claude") {
    const items = await readClaudeTimelineFromDisk({ cwd, sessionId, logger: options?.logger });
    return items?.map((item) => ({ item })) ?? null;
  }

  return null;
}

export function supportsDiskTimeline(provider: string): boolean {
  return provider === "grok" || provider === "claude" || provider === "omp" || provider === "mock";
}
