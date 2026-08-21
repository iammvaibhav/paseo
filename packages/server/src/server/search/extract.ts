import type { AgentTimelineItem, ToolCallDetail } from "../agent/agent-sdk-types.js";

/** A single tool output larger than this is truncated before indexing. */
export const TOOL_OUTPUT_MAX_CHARS = 8 * 1024;

export interface ExtractedChunk {
  role: string;
  ts: number | null;
  text: string;
}

export interface ExtractableTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

/**
 * Flatten one timeline item into searchable text. Tool outputs are included
 * (that is where PR URLs from `gh pr create` live) but capped so a 32 MB
 * session does not become a 32 MB FTS row.
 */
export function extractChunks(entries: readonly ExtractableTimelineEntry[]): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];
  for (const entry of entries) {
    const ts = parseTimestamp(entry.timestamp);
    for (const text of extractItemTexts(entry.item)) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      chunks.push({ role: entry.item.type, ts, text: trimmed });
    }
  }
  return chunks;
}

export function extractItemTexts(item: AgentTimelineItem): string[] {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return [item.text];
    case "error":
      return [item.message];
    case "todo":
      return item.items.map((todo) => todo.text);
    case "compaction":
      return [];
    case "tool_call":
      return extractToolCallTexts(item.name, item.detail);
    default:
      return [];
  }
}

function extractToolCallTexts(name: string, detail: ToolCallDetail): string[] {
  return [name, ...extractToolDetailTexts(detail)];
}

function extractToolDetailTexts(detail: ToolCallDetail): string[] {
  switch (detail.type) {
    case "shell":
      return [detail.command, ...(detail.output ? [truncate(detail.output)] : [])];
    case "read":
      return [detail.filePath];
    case "edit":
      return [
        detail.filePath,
        ...(detail.newString ? [truncate(detail.newString)] : []),
        ...(detail.unifiedDiff ? [truncate(detail.unifiedDiff)] : []),
      ];
    case "write":
      return [detail.filePath];
    case "search":
      return searchTexts(detail);
    case "fetch":
      return [detail.url, ...(detail.result ? [truncate(detail.result)] : [])];
    case "worktree_setup":
      return worktreeSetupTexts(detail);
    case "sub_agent":
      return [...(detail.description ? [detail.description] : []), truncate(detail.log)];
    case "plain_text":
      return detail.text ? [truncate(detail.text)] : [];
    case "plan":
      return [truncate(detail.text)];
    case "unknown":
      return [stringifyUnknown(detail.input), stringifyUnknown(detail.output)];
    default:
      return [];
  }
}

function searchTexts(detail: Extract<ToolCallDetail, { type: "search" }>): string[] {
  const parts = [detail.query];
  if (detail.content) parts.push(truncate(detail.content));
  if (detail.filePaths) parts.push(detail.filePaths.join("\n"));
  if (detail.webResults) {
    for (const result of detail.webResults) {
      parts.push(`${result.title} ${result.url}`);
    }
  }
  return parts;
}

function worktreeSetupTexts(detail: Extract<ToolCallDetail, { type: "worktree_setup" }>): string[] {
  const parts = [detail.worktreePath, detail.branchName, truncate(detail.log)];
  for (const command of detail.commands) {
    parts.push(command.command, truncate(command.log));
  }
  return parts;
}

function truncate(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return truncate(value);
  if (value == null) return "";
  try {
    return truncate(JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
