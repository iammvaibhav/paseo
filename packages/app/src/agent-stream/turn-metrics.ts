import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";
import { continuesResponse } from "./turn-membership";

const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Compact token count notation (e.g. "1.4k", "512", "12.6k", "1m").
 */
export function compactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "0";
  }
  return COMPACT_NUMBER_FORMAT.format(tokens).toLowerCase();
}

/**
 * Bounds text to `limit` characters, appending '…' when truncated.
 */
export function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(0, limit) + "…";
}

export interface TurnMetricsLineInput {
  metrics?: AgentUsage;
  fallbackDurationMs?: number | null;
}

/**
 * Human-readable metrics line for completed turns.
 * Formats duration, model, output tok/s, cache hit %, and input/output/cached tokens.
 * Omit unknown fields. Returns null when no fields are present.
 */
export function formatTurnMetricsLine(input: TurnMetricsLineInput): string | null {
  const fields: string[] = [];
  const metrics = input.metrics;

  const durationMs = resolveDisplayDuration(metrics?.durationMs, input.fallbackDurationMs);
  if (durationMs !== undefined) {
    fields.push(`Worked for ${formatDuration(durationMs)}`);
  }

  const model = metrics?.model?.trim();
  if (model) {
    fields.push(model);
  }

  const rate = formatOutputRate(metrics);
  if (rate !== null) {
    fields.push(rate);
  }

  const cacheHit = formatCacheHit(metrics);
  if (cacheHit !== null) {
    fields.push(cacheHit);
  }

  if (metrics?.inputTokens !== undefined) {
    fields.push(`in ${compactTokens(metrics.inputTokens)}`);
  }

  if (metrics?.outputTokens !== undefined) {
    fields.push(`out ${compactTokens(metrics.outputTokens)}`);
  }

  if (metrics?.cachedInputTokens !== undefined) {
    fields.push(`cached ${compactTokens(metrics.cachedInputTokens)}`);
  }

  if (fields.length === 0) {
    return null;
  }

  return fields.join(" · ");
}

function resolveDisplayDuration(
  metricsMs: number | undefined,
  fallbackMs: number | null | undefined,
): number | undefined {
  if (metricsMs !== undefined && metricsMs > 0) {
    return metricsMs;
  }
  if (fallbackMs != null && fallbackMs > 0) {
    return fallbackMs;
  }
  return undefined;
}

function formatOutputRate(metrics: AgentUsage | undefined): string | null {
  if (metrics?.outputTokens === undefined) {
    return null;
  }
  if (metrics.durationMs === undefined || metrics.durationMs <= 0) {
    return null;
  }
  const rate = Math.round(metrics.outputTokens / (metrics.durationMs / 1000));
  return `${rate} tok/s`;
}

function formatCacheHit(metrics: AgentUsage | undefined): string | null {
  if (metrics?.cachedInputTokens === undefined) {
    return null;
  }
  const cached = metrics.cachedInputTokens;
  const total = (metrics.inputTokens ?? 0) + cached + (metrics.cacheWriteTokens ?? 0);
  if (total <= 0) {
    return "cache 0%";
  }
  return `cache ${Math.round((cached / total) * 100)}%`;
}

/**
 * Extracts file paths edited or written during a completed turn.
 */
export function collectTurnEditedFiles(params: {
  items: readonly StreamItem[];
  startIndex: number;
  getNeighborIndex?: (index: number, relation: "above" | "below") => number;
}): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const getNeighbor = params.getNeighborIndex ?? ((i, rel) => (rel === "above" ? i - 1 : i + 1));

  let index = params.startIndex;
  let laterItem: StreamItem | null = null;

  while (index >= 0 && index < params.items.length) {
    const item = params.items[index];
    if (!item || (laterItem && !continuesResponse(item, laterItem))) {
      break;
    }

    if (item.kind === "tool_call") {
      const path = extractEditedFilePath(item);
      if (path && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }

    laterItem = item;
    index = getNeighbor(index, "above");
  }

  return files;
}

function extractEditedFilePath(item: Extract<StreamItem, { kind: "tool_call" }>): string | null {
  if (item.payload.source === "agent") {
    const detail = item.payload.data.detail;
    if (detail.type === "edit" || detail.type === "write") {
      return detail.filePath || null;
    }
  }
  return null;
}

/**
 * Builds the critique prompt for the Second opinion fork action.
 */
export function buildSecondOpinionPrompt(params: {
  provider: string;
  userText?: string | null;
  assistantText?: string | null;
  files?: string[];
}): string {
  const provider = params.provider.trim() || "the agent";
  const userSection = truncate(params.userText?.trim() || "(not recorded)", 400);
  const assistantReport = params.assistantText?.trim()
    ? truncate(params.assistantText.trim(), 4000)
    : "(no written summary — inspect the files)";
  const filesSection =
    params.files && params.files.length > 0
      ? params.files.join("\n")
      : "(none recorded on this turn)";

  return [
    `Give a second opinion on work ${provider} just finished in this same working copy.`,
    "",
    "## User request",
    userSection,
    "",
    `## What ${provider} reported`,
    assistantReport,
    "",
    "## Files it edited",
    filesSection,
  ].join("\n");
}
