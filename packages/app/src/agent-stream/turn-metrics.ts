import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import { formatDuration } from "@/utils/time";

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
