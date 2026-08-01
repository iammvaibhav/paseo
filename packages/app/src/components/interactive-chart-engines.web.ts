import type * as EChartsApi from "echarts";
import type { ChartAssemblyInput } from "flint-chart";
import type { ChartFenceLanguage } from "./interactive-chart-fence";

/** Backends that can draw a chart in the timeline. */
export type ChartBackend = "echarts" | "vegalite" | "plotly";

/** A drawn chart, owned by the caller until `dispose` runs. */
export interface ChartMount {
  dispose: () => void;
  resize: () => void;
}

interface MountChartParams {
  host: HTMLElement;
  spec: Record<string, unknown>;
  language: ChartFenceLanguage;
  colorScheme: "light" | "dark";
}

let echartsPromise: Promise<typeof EChartsApi> | null = null;
let vegaEmbedPromise: Promise<typeof import("vega-embed").default> | null = null;
let plotlyPromise: Promise<typeof import("plotly.js-dist-min")> | null = null;
let flintPromise: Promise<typeof import("flint-chart")> | null = null;

/**
 * echarts' package entry compiles with `importHelpers`, so its modules import
 * tslib helpers that Metro's CJS interop resolves to `undefined` and throws on.
 * The prebuilt ESM bundle inlines those helpers instead.
 */
function loadECharts(): Promise<typeof EChartsApi> {
  echartsPromise ??= import("echarts/dist/echarts.esm.js");
  return echartsPromise;
}

function loadVegaEmbed(): Promise<typeof import("vega-embed").default> {
  vegaEmbedPromise ??= import("vega-embed").then((mod) => mod.default);
  return vegaEmbedPromise;
}

function loadPlotly(): Promise<typeof import("plotly.js-dist-min")> {
  plotlyPromise ??= import("plotly.js-dist-min");
  return plotlyPromise;
}

function loadFlint(): Promise<typeof import("flint-chart")> {
  flintPromise ??= import("flint-chart");
  return flintPromise;
}

/**
 * A raw fence names its own backend. A Flint fence may pick one with a
 * top-level `backend` key and otherwise compiles to ECharts, the only backend
 * that ships interaction (crosshair, zoom, range slider) without extra config.
 */
export function resolveChartBackend(
  spec: Record<string, unknown>,
  language: ChartFenceLanguage,
): ChartBackend {
  if (language !== "flint") {
    return language;
  }
  const requested = spec.backend;
  return requested === "vegalite" || requested === "plotly" ? requested : "echarts";
}

/**
 * Flint emits its stretch-layout result as private `_width`/`_height` keys that
 * the host is expected to apply; the backends themselves ignore them.
 */
function flintSize(compiled: Record<string, unknown>): { width?: number; height?: number } {
  const width = compiled._width;
  const height = compiled._height;
  return {
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  };
}

async function compileSpec(
  spec: Record<string, unknown>,
  language: ChartFenceLanguage,
  backend: ChartBackend,
): Promise<Record<string, unknown>> {
  if (language !== "flint") {
    return spec;
  }
  const flint = await loadFlint();
  const input = spec as unknown as ChartAssemblyInput;
  if (backend === "vegalite") {
    return flint.assembleVegaLite(input) as unknown as Record<string, unknown>;
  }
  if (backend === "plotly") {
    return flint.assemblePlotly(input) as unknown as Record<string, unknown>;
  }
  return flint.assembleECharts(input) as unknown as Record<string, unknown>;
}

/**
 * ECharts draws nothing interactive unless asked, so every chart gets a
 * crosshair tooltip plus wheel/slider zoom. A spec that sets either keeps its
 * own choice. Non-cartesian series (pie, gauge, sankey) ignore `dataZoom`.
 */
function withEchartsInteractions(option: EChartsApi.EChartsOption): EChartsApi.EChartsOption {
  return {
    ...option,
    tooltip: { trigger: "axis", axisPointer: { type: "cross" }, ...option.tooltip },
    dataZoom: option.dataZoom ?? [{ type: "inside" }, { type: "slider", bottom: 8, height: 20 }],
  };
}

async function mountECharts(
  host: HTMLElement,
  spec: Record<string, unknown>,
  colorScheme: "light" | "dark",
): Promise<ChartMount> {
  const echarts = await loadECharts();
  const chart = echarts.init(host, colorScheme === "light" ? undefined : "dark", {
    renderer: "canvas",
  });
  chart.setOption(withEchartsInteractions(spec as EChartsApi.EChartsOption), true);
  return { dispose: () => chart.dispose(), resize: () => chart.resize() };
}

async function mountVegaLite(
  host: HTMLElement,
  spec: Record<string, unknown>,
  colorScheme: "light" | "dark",
): Promise<ChartMount> {
  const vegaEmbed = await loadVegaEmbed();
  const { width, height, ...rest } = spec;
  const flintDefaults = flintSize(spec);
  const resolvedWidth = width ?? flintDefaults.width;
  const resolvedHeight = height ?? flintDefaults.height;
  const embedded = {
    // Vega's dark theme paints an opaque plot background that clashes with the
    // surrounding card. A spec may still declare its own.
    background: "transparent",
    ...rest,
    ...(resolvedWidth === undefined ? {} : { width: resolvedWidth }),
    ...(resolvedHeight === undefined ? {} : { height: resolvedHeight }),
  } as Parameters<typeof vegaEmbed>[1];

  // Flint omits $schema and a raw fence is declared vega-lite by its language,
  // so the mode is never ambiguous and never needs sniffing.
  const result = await vegaEmbed(host, embedded, {
    mode: "vega-lite",
    actions: false,
    renderer: "canvas",
    ...(colorScheme === "dark" ? { theme: "dark" as const } : {}),
  });

  return {
    dispose: () => result.finalize(),
    resize: () => void result.view.resize().run(),
  };
}

async function mountPlotly(
  host: HTMLElement,
  spec: Record<string, unknown>,
  colorScheme: "light" | "dark",
): Promise<ChartMount> {
  const Plotly = await loadPlotly();
  const data = Array.isArray(spec.data) ? spec.data : [];
  const layout = (spec.layout as Record<string, unknown> | undefined) ?? {};
  const darkLayout =
    colorScheme === "dark"
      ? {
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          font: { color: "#a1a1aa" },
        }
      : {};

  await Plotly.newPlot(
    host,
    data,
    { autosize: true, ...flintSize(spec), ...darkLayout, ...layout },
    { responsive: true, displaylogo: false },
  );

  return {
    dispose: () => Plotly.purge(host),
    resize: () => Plotly.Plots.resize(host),
  };
}

/**
 * Compiles the fence contents when needed, loads only the backend it resolves
 * to, and draws into `host`.
 */
export async function mountChart({
  host,
  spec,
  language,
  colorScheme,
}: MountChartParams): Promise<ChartMount> {
  const backend = resolveChartBackend(spec, language);
  const compiled = await compileSpec(spec, language, backend);

  if (backend === "vegalite") {
    return mountVegaLite(host, compiled, colorScheme);
  }
  if (backend === "plotly") {
    return mountPlotly(host, compiled, colorScheme);
  }
  return mountECharts(host, compiled, colorScheme);
}
