/**
 * Offline Grok timeline from on-disk ACP session logs.
 *
 * Grok writes the live ACP `session/update` stream to:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl
 *
 * Replaying that file through {@link projectAcpSessionUpdates} produces the same
 * timeline shape as `session/load` → streamHistory, without spawning the agent.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { projectAcpSessionUpdates, type AcpHistorySessionUpdate } from "./acp-history-projector.js";

export function resolveGrokSessionDir(input: {
  cwd: string;
  sessionId: string;
  grokHome?: string;
}): string {
  const home = input.grokHome ?? path.join(homedir(), ".grok");
  return path.join(home, "sessions", encodeURIComponent(input.cwd), input.sessionId);
}

export function resolveGrokUpdatesPath(input: {
  cwd: string;
  sessionId: string;
  grokHome?: string;
}): string | null {
  const updatesPath = path.join(resolveGrokSessionDir(input), "updates.jsonl");
  return fs.existsSync(updatesPath) ? updatesPath : null;
}

/**
 * Read and project Grok offline history. Returns null when the updates log is missing.
 */
export function readGrokTimelineFromDisk(input: {
  cwd: string;
  sessionId: string;
  grokHome?: string;
}): AgentTimelineItem[] | null {
  const updatesPath = resolveGrokUpdatesPath(input);
  if (!updatesPath) {
    return null;
  }
  const updates = parseGrokUpdatesJsonl(fs.readFileSync(updatesPath, "utf8"));
  return projectAcpSessionUpdates(updates);
}

export function parseGrokUpdatesJsonl(content: string): AcpHistorySessionUpdate[] {
  const updates: AcpHistorySessionUpdate[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const params = (row as { params?: unknown }).params;
    if (!params || typeof params !== "object") continue;
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== "object") continue;
    const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
    if (typeof sessionUpdate !== "string") continue;
    updates.push(update as AcpHistorySessionUpdate);
  }
  return updates;
}
