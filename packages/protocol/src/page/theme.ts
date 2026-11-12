/**
 * Theme tokens that agent-authored visuals (chart fences and inline pages) paint with.
 *
 * The app builds them from its active theme; the daemon uses the preview set below when
 * it screenshots a page for the agent. Every fill is a token, so a glass theme's
 * translucent washes reach charts and pages without a second palette.
 */
export interface PageThemeTokens {
  colorScheme: "dark" | "light";
  glass: boolean;
  foreground: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  /** In-flow fills: panels, cards, table rows. Washes on a glass theme. */
  surface1: string;
  surface2: string;
  surface3: string;
  /** Opaque page color, for text on a filled chip. Never transparent. */
  background: string;
  /** Anything that sits over content: tooltips, menus, popovers. */
  floating: string;
  floatingBorder: string;
  /** Covers what scrolls under it, such as a sticky header. */
  cover: string;
  success: string;
  warning: string;
  danger: string;
  /** Series colors for charts, first color first. */
  palette: readonly string[];
  fontUi: string;
  fontMono: string;
  fontSize: number;
  radius: number;
}

const DARK_PALETTE = [
  "#5caaf6",
  "#35c264",
  "#db932e",
  "#f7796d",
  "#a890d5",
  "#4aabb8",
  "#e879a6",
  "#b5c45a",
] as const;

const LIGHT_PALETTE = [
  "#2563eb",
  "#16a34a",
  "#b45309",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
] as const;

/** Series colors for a color scheme. The app and the preview use the same ones. */
export function pagePaletteFor(colorScheme: "dark" | "light"): readonly string[] {
  return colorScheme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

const UI_FONT =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_FONT =
  "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

/**
 * The theme a daemon-side preview paints with: Mono dark and the default light theme.
 * `backdrop` is what the preview screenshot shows behind the transparent page.
 */
export const PAGE_PREVIEW_THEMES: Record<"dark" | "light", PageThemeTokens & { backdrop: string }> =
  {
    dark: {
      colorScheme: "dark",
      glass: false,
      backdrop: "#171717",
      foreground: "#ebebeb",
      muted: "#8c8c8c",
      faint: "#636363",
      border: "#262626",
      accent: "#1f7ce0",
      surface1: "#1e1e1e",
      surface2: "#2a2a2a",
      surface3: "#3a3a3a",
      background: "#171717",
      floating: "#171717",
      floatingBorder: "#2e2e2e",
      cover: "#171717",
      success: "#35c264",
      warning: "#db932e",
      danger: "#f7796d",
      palette: DARK_PALETTE,
      fontUi: UI_FONT,
      fontMono: MONO_FONT,
      fontSize: 14,
      radius: 8,
    },
    light: {
      colorScheme: "light",
      glass: false,
      backdrop: "#ffffff",
      foreground: "#1a1a1e",
      muted: "#71717a",
      faint: "#a1a1aa",
      border: "#e4e4e7",
      accent: "#20744A",
      surface1: "#fafafa",
      surface2: "#f4f4f5",
      surface3: "#e4e4e7",
      background: "#ffffff",
      floating: "#ffffff",
      floatingBorder: "#ececf1",
      cover: "#ffffff",
      success: "#299f51",
      warning: "#b37824",
      danger: "#f12e2f",
      palette: LIGHT_PALETTE,
      fontUi: UI_FONT,
      fontMono: MONO_FONT,
      fontSize: 14,
      radius: 8,
    },
  };

/** CSS custom properties a page reads. The names are the contract agents write against. */
export function pageCssVariables(tokens: PageThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {
    "--paseo-fg": tokens.foreground,
    "--paseo-muted": tokens.muted,
    "--paseo-faint": tokens.faint,
    "--paseo-border": tokens.border,
    "--paseo-accent": tokens.accent,
    "--paseo-surface-1": tokens.surface1,
    "--paseo-surface-2": tokens.surface2,
    "--paseo-surface-3": tokens.surface3,
    "--paseo-background": tokens.background,
    "--paseo-floating": tokens.floating,
    "--paseo-floating-border": tokens.floatingBorder,
    "--paseo-cover": tokens.cover,
    "--paseo-success": tokens.success,
    "--paseo-warning": tokens.warning,
    "--paseo-danger": tokens.danger,
    "--paseo-font-ui": tokens.fontUi,
    "--paseo-font-mono": tokens.fontMono,
    "--paseo-font-size": `${tokens.fontSize}px`,
    "--paseo-radius": `${tokens.radius}px`,
  };
  tokens.palette.forEach((color, index) => {
    vars[`--paseo-chart-${index + 1}`] = color;
  });
  return vars;
}

/**
 * An ECharts theme object. Its background is transparent so a chart sits on whatever
 * fill is under it; a glass wash stays a wash.
 */
export function buildEChartsTheme(tokens: PageThemeTokens): Record<string, unknown> {
  const axis = {
    axisLine: { lineStyle: { color: tokens.border } },
    axisTick: { lineStyle: { color: tokens.border } },
    axisLabel: { color: tokens.muted },
    splitLine: { lineStyle: { color: tokens.border } },
    splitArea: { areaStyle: { color: ["transparent"] } },
    nameTextStyle: { color: tokens.muted },
  };
  const floatingLabel = {
    backgroundColor: tokens.floating,
    borderColor: tokens.floatingBorder,
    color: tokens.foreground,
  };
  return {
    backgroundColor: "transparent",
    color: [...tokens.palette],
    textStyle: { color: tokens.foreground, fontFamily: tokens.fontUi },
    title: {
      textStyle: { color: tokens.foreground },
      subtextStyle: { color: tokens.muted },
    },
    legend: {
      textStyle: { color: tokens.muted },
      pageTextStyle: { color: tokens.muted },
      inactiveColor: tokens.faint,
    },
    tooltip: {
      backgroundColor: tokens.floating,
      borderColor: tokens.floatingBorder,
      textStyle: { color: tokens.foreground },
      axisPointer: {
        lineStyle: { color: tokens.muted },
        crossStyle: { color: tokens.muted },
        label: floatingLabel,
      },
    },
    axisPointer: { label: floatingLabel },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
    dataZoom: {
      borderColor: tokens.border,
      backgroundColor: "transparent",
      fillerColor: tokens.surface2,
      textStyle: { color: tokens.muted },
      handleStyle: { color: tokens.surface3, borderColor: tokens.muted },
      moveHandleStyle: { color: tokens.surface3 },
      dataBackground: {
        lineStyle: { color: tokens.border },
        areaStyle: { color: tokens.surface1 },
      },
      selectedDataBackground: {
        lineStyle: { color: tokens.palette[0] },
        areaStyle: { color: tokens.surface2 },
      },
      emphasis: { handleStyle: { borderColor: tokens.foreground } },
    },
    visualMap: { textStyle: { color: tokens.muted } },
    graph: { color: [...tokens.palette] },
  };
}

/** A Vega-Lite `config` block with the same colors. */
export function buildVegaLiteConfig(tokens: PageThemeTokens): Record<string, unknown> {
  return {
    background: "transparent",
    font: tokens.fontUi,
    view: { stroke: "transparent" },
    title: { color: tokens.foreground },
    axis: {
      domainColor: tokens.border,
      gridColor: tokens.border,
      tickColor: tokens.border,
      labelColor: tokens.muted,
      titleColor: tokens.muted,
    },
    legend: { labelColor: tokens.muted, titleColor: tokens.muted },
    header: { labelColor: tokens.muted, titleColor: tokens.muted },
    range: { category: [...tokens.palette] },
  };
}

/** A Plotly layout fragment with the same colors. */
export function buildPlotlyLayout(tokens: PageThemeTokens): Record<string, unknown> {
  const axis = {
    gridcolor: tokens.border,
    linecolor: tokens.border,
    zerolinecolor: tokens.border,
    tickcolor: tokens.border,
  };
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: tokens.muted, family: tokens.fontUi },
    colorway: [...tokens.palette],
    xaxis: axis,
    yaxis: axis,
    hoverlabel: {
      bgcolor: tokens.floating,
      bordercolor: tokens.floatingBorder,
      font: { color: tokens.foreground },
    },
  };
}

/** The ECharts default palette, which Flint writes into every ECharts spec it compiles. */
export const ECHARTS_DEFAULT_PALETTE: readonly string[] = [
  "#5470c6",
  "#91cc75",
  "#fac858",
  "#ee6666",
  "#73c0de",
  "#3ba272",
  "#fc8452",
  "#9a60b4",
  "#ea7ccc",
  "#d48265",
];

/**
 * Library default palettes that Flint writes into the specs it compiles. Matched
 * case-insensitively and swapped index for index with the theme palette.
 */
const LIBRARY_DEFAULT_PALETTES: readonly (readonly string[])[] = [
  ECHARTS_DEFAULT_PALETTE,
  // Plotly
  [
    "#636efa",
    "#ef553b",
    "#00cc96",
    "#ab63fa",
    "#ffa15a",
    "#19d3f3",
    "#ff6692",
    "#b6e880",
    "#ff97ff",
    "#fecb52",
  ],
];

function buildRecolorMap(palette: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const defaults of LIBRARY_DEFAULT_PALETTES) {
    defaults.forEach((color, index) => {
      map.set(color, palette[index % palette.length] ?? color);
    });
  }
  return map;
}

/**
 * Flint hard-codes each backend's default palette into the spec, which outranks any theme.
 * Swap those colors for the theme palette, and drop Flint's default Vega scheme so the
 * config's category range applies. A color the spec author chose stays as written.
 */
export function recolorChartSpec<T>(spec: T, palette: readonly string[]): T {
  const recolor = buildRecolorMap(palette);
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      return recolor.get(value.toLowerCase()) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (key === "scheme" && child === "tableau10") {
          out.range = [...palette];
          continue;
        }
        out[key] = visit(child);
      }
      return out;
    }
    return value;
  };
  return visit(spec) as T;
}
