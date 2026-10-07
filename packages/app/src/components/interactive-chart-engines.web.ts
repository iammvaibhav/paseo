import type * as EChartsApi from "echarts";
import type { ChartAssemblyInput } from "flint-chart";
import {
  buildEChartsTheme,
  buildPlotlyLayout,
  buildVegaLiteConfig,
  recolorChartSpec,
  type PageThemeTokens,
} from "@getpaseo/protocol/page/theme";
import type { ChartFenceLanguage } from "./interactive-chart-fence";
import { applyChartRows, findChartDataUrl } from "./chart-data-source";
import type { ChartRow } from "./chart-data-source";

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
  /** The app theme's chart colors; every backend paints a transparent background. */
  tokens: PageThemeTokens;
  /** Reads a workspace file when the spec references one instead of inlining rows. */
  resolveData?: ((path: string) => Promise<ChartRow[]>) | null;
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
  palette: readonly string[],
): Promise<Record<string, unknown>> {
  if (language !== "flint") {
    return spec;
  }
  const flint = await loadFlint();
  const input = spec as unknown as ChartAssemblyInput;
  let compiled: unknown;
  if (backend === "vegalite") {
    compiled = flint.assembleVegaLite(input);
  } else if (backend === "plotly") {
    compiled = flint.assemblePlotly(input);
  } else {
    compiled = flint.assembleECharts(input);
  }
  // Flint writes each backend's default palette into the spec; a raw fence keeps its colors.
  return recolorChartSpec(compiled as Record<string, unknown>, palette);
}

/** Height the default range slider needs below the plot, so it never covers the axis name. */
const SLIDER_ROOM_PX = 32;

/**
 * ECharts draws nothing interactive unless asked, so every chart gets a
 * crosshair tooltip plus wheel/slider zoom. A spec that sets either keeps its
 * own choice. Non-cartesian series (pie, gauge, sankey) ignore `dataZoom`.
 */
function withEchartsInteractions(option: EChartsApi.EChartsOption): EChartsApi.EChartsOption {
  const addsSlider = option.dataZoom === undefined;
  const grid = option.grid as { bottom?: unknown } | undefined;
  return {
    ...option,
    tooltip: { trigger: "axis", axisPointer: { type: "cross" }, ...option.tooltip },
    dataZoom: option.dataZoom ?? [{ type: "inside" }, { type: "slider", bottom: 8, height: 20 }],
    ...(addsSlider && grid && typeof grid.bottom === "number"
      ? { grid: { ...grid, bottom: grid.bottom + SLIDER_ROOM_PX } }
      : {}),
  };
}

async function mountECharts(
  host: HTMLElement,
  spec: Record<string, unknown>,
  tokens: PageThemeTokens,
): Promise<ChartMount> {
  const echarts = await loadECharts();
  // Flint lays out label rotation and margins for the height it reports; give it that height.
  const { height } = flintSize(spec);
  if (height !== undefined) {
    host.style.height = `${height + (spec.dataZoom === undefined ? SLIDER_ROOM_PX : 0)}px`;
  }
  const chart = echarts.init(host, buildEChartsTheme(tokens), { renderer: "canvas" });
  chart.setOption(withEchartsInteractions(spec as EChartsApi.EChartsOption), true);
  return { dispose: () => chart.dispose(), resize: () => chart.resize() };
}

async function mountVegaLite(
  host: HTMLElement,
  spec: Record<string, unknown>,
  tokens: PageThemeTokens,
): Promise<ChartMount> {
  const vegaEmbed = await loadVegaEmbed();
  const { width, height, ...rest } = spec;
  const flintDefaults = flintSize(spec);
  const resolvedWidth = width ?? flintDefaults.width;
  const resolvedHeight = height ?? flintDefaults.height;
  const themeConfig = buildVegaLiteConfig(tokens);
  const specConfig = (rest.config as Record<string, unknown> | undefined) ?? {};
  const embedded = {
    // A spec may still declare its own background or config keys; they win.
    background: "transparent",
    ...rest,
    config: { ...themeConfig, ...specConfig },
    ...(resolvedWidth === undefined ? {} : { width: resolvedWidth }),
    ...(resolvedHeight === undefined ? {} : { height: resolvedHeight }),
  } as Parameters<typeof vegaEmbed>[1];

  // Flint omits $schema and a raw fence is declared vega-lite by its language,
  // so the mode is never ambiguous and never needs sniffing.
  const result = await vegaEmbed(host, embedded, {
    mode: "vega-lite",
    actions: false,
    renderer: "canvas",
  });

  return {
    dispose: () => result.finalize(),
    resize: () => void result.view.resize().run(),
  };
}

async function mountPlotly(
  host: HTMLElement,
  spec: Record<string, unknown>,
  tokens: PageThemeTokens,
): Promise<ChartMount> {
  const Plotly = await loadPlotly();
  const data = Array.isArray(spec.data) ? spec.data : [];
  const layout = (spec.layout as Record<string, unknown> | undefined) ?? {};
  const themeLayout = buildPlotlyLayout(tokens);
  const axis = (key: "xaxis" | "yaxis") => ({
    ...(themeLayout[key] as Record<string, unknown>),
    ...(layout[key] as Record<string, unknown> | undefined),
  });

  await Plotly.newPlot(
    host,
    data,
    {
      autosize: true,
      ...flintSize(spec),
      ...themeLayout,
      ...layout,
      xaxis: axis("xaxis"),
      yaxis: axis("yaxis"),
    },
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
  tokens,
  resolveData,
}: MountChartParams): Promise<ChartMount> {
  const backend = resolveChartBackend(spec, language);

  // A referenced file has to become rows before Flint compiles or a backend
  // reads the spec — none of them can fetch from the daemon themselves.
  const dataUrl = findChartDataUrl(spec, language);
  let resolved = spec;
  if (dataUrl !== null) {
    if (!resolveData) {
      throw new Error("Chart data files are only available inside a workspace");
    }
    resolved = applyChartRows(spec, language, await resolveData(dataUrl));
  }

  const compiled = await compileSpec(resolved, language, backend, tokens.palette);

  if (backend === "vegalite") {
    return mountVegaLite(host, compiled, tokens);
  }
  if (backend === "plotly") {
    return mountPlotly(host, compiled, tokens);
  }
  return mountECharts(host, compiled, tokens);
}
