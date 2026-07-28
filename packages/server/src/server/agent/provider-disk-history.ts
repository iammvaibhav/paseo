/**
 * Offline provider timeline readers for fast agent open without process spawn.
 *
 * Supported today:
 * - grok: ~/.grok/sessions/.../updates.jsonl (ACP update stream)
 * - claude: ~/.claude/projects/.../<sessionId>.jsonl (existing history ingest)
 */
import type { Logger } from "pino";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { readClaudeTimelineFromDisk } from "./providers/claude-history.js";
import { readGrokTimelineFromDisk } from "./providers/grok-history.js";

export interface DiskHistorySource {
  provider: string;
  cwd: string;
  sessionId: string;
}

export async function tryReadProviderTimelineFromDisk(
  source: DiskHistorySource,
  options?: { logger?: Logger },
): Promise<AgentTimelineItem[] | null> {
  const { provider, cwd, sessionId } = source;
  if (!cwd || !sessionId) {
    return null;
  }

  if (provider === "grok") {
    try {
      return readGrokTimelineFromDisk({ cwd, sessionId });
    } catch (error) {
      options?.logger?.warn({ err: error, sessionId, provider }, "Grok disk history read failed");
      return null;
    }
  }

  if (provider === "claude") {
    return readClaudeTimelineFromDisk({ cwd, sessionId, logger: options?.logger });
  }

  return null;
}

export function supportsDiskTimeline(provider: string): boolean {
  return provider === "grok" || provider === "claude";
}
