/** Fence languages the timeline renders as a live chart. */
export type ChartFenceLanguage = "flint" | "echarts" | "vegalite" | "plotly";

// `chartjs` is deliberately absent: Flint can compile to it, but Chart.js is a
// canvas-only engine with no advantage over ECharts here, so a `chartjs` fence
// stays highlighted source rather than being silently drawn by another backend.
const CHART_FENCE_LANGUAGES: Record<string, ChartFenceLanguage> = {
  flint: "flint",
  echarts: "echarts",
  vegalite: "vegalite",
  "vega-lite": "vegalite",
  plotly: "plotly",
};

/**
 * Reads the first token of a fence info string, so ` ```echarts title=Revenue `
 * still resolves. Returns null for fences the timeline should leave as source.
 */
export function resolveChartFenceLanguage(
  info: string | null | undefined,
): ChartFenceLanguage | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\./, "");
  return first === undefined ? null : (CHART_FENCE_LANGUAGES[first] ?? null);
}
