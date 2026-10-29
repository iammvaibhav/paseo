import { autoType, csvParse, tsvParse } from "d3-dsv";
import type { ChartFenceLanguage } from "./interactive-chart-fence";

export type ChartRow = Record<string, unknown>;

/**
 * A chart may exceed what a reader can perceive long before it exceeds memory,
 * so these caps exist to stop a runaway file wedging the renderer, not to
 * express a sensible chart size.
 */
const MAX_DATA_BYTES = 8 * 1024 * 1024;
const MAX_DATA_ROWS = 200_000;

/**
 * Rejects anything that could read outside the workspace the chart belongs to.
 * The daemon confines reads to the workspace root as well, but a clear message
 * here beats a generic failure from the far side of the wire.
 */
export function assertWorkspaceRelativePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Chart data path is empty");
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(`Chart data path must be workspace-relative, got "${trimmed}"`);
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) {
    throw new Error(`Remote chart data is not supported, got "${trimmed}"`);
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new Error(`Chart data path must be workspace-relative, got "${trimmed}"`);
  }
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) {
    throw new Error(`Chart data path may not traverse outside the workspace, got "${trimmed}"`);
  }
  return normalized;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Each language keeps its data in a different slot, so a reference is only
 * recognised where the slot is unambiguous:
 *   flint / vegalite → `data.url` (part of both spec languages)
 *   echarts          → `dataset.url` (ECharts' own tabular slot)
 * Plotly splits data across per-trace arrays with no single slot, so it has to
 * inline.
 */
export function findChartDataUrl(
  spec: Record<string, unknown>,
  language: ChartFenceLanguage,
): string | null {
  const slot = language === "echarts" ? readObject(spec.dataset) : readObject(spec.data);
  if (!slot) return null;
  return typeof slot.url === "string" ? slot.url : null;
}

/** Replaces the reference with the resolved rows, in that language's slot. */
export function applyChartRows(
  spec: Record<string, unknown>,
  language: ChartFenceLanguage,
  rows: ChartRow[],
): Record<string, unknown> {
  if (language === "echarts") {
    const { url: _discarded, ...dataset } = readObject(spec.dataset) ?? {};
    return { ...spec, dataset: { ...dataset, source: rows } };
  }
  const { url: _discarded, ...data } = readObject(spec.data) ?? {};
  return { ...spec, data: { ...data, values: rows } };
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function parseJsonRows(text: string, path: string): ChartRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of row objects`);
  }
  return parsed as ChartRow[];
}

/**
 * `autoType` is what turns "220.5" into a number; without it every CSV column
 * arrives as a string and charts silently render a category axis.
 */
export function parseChartRows(bytes: Uint8Array, path: string): ChartRow[] {
  if (bytes.byteLength > MAX_DATA_BYTES) {
    throw new Error(
      `${path} is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; chart data is capped at ${MAX_DATA_BYTES / 1024 / 1024}MB`,
    );
  }

  const text = new TextDecoder().decode(bytes);
  const extension = extensionOf(path);

  let rows: ChartRow[];
  if (extension === ".json") {
    rows = parseJsonRows(text, path);
  } else if (extension === ".csv") {
    rows = Array.from(csvParse(text, autoType)) as ChartRow[];
  } else if (extension === ".tsv") {
    rows = Array.from(tsvParse(text, autoType)) as ChartRow[];
  } else {
    throw new Error(
      `Cannot read chart data from "${path}" — supported types are .json, .csv and .tsv`,
    );
  }

  if (rows.length > MAX_DATA_ROWS) {
    throw new Error(
      `${path} has ${rows.length} rows; chart data is capped at ${MAX_DATA_ROWS}. Aggregate before charting.`,
    );
  }
  return rows;
}
