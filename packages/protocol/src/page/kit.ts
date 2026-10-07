import {
  buildEChartsTheme,
  ECHARTS_DEFAULT_PALETTE,
  pageCssVariables,
  pagePaletteFor,
  type PageThemeTokens,
} from "./theme.js";

/** `source` on messages a page posts to its host. */
export const PAGE_FRAME_SOURCE = "paseo-page";
/** `source` on messages a host posts to its page. */
export const PAGE_HOST_SOURCE = "paseo-page-host";

/** The pinned CDN builds `paseo.chart()` loads inside a page. */
export const PAGE_KIT_ECHARTS_URL =
  "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js";
export const PAGE_KIT_FLINT_URL = "https://cdn.jsdelivr.net/npm/flint-chart@0.4.1/+esm";

/** What the kit needs to repaint a page: CSS variables plus the chart theme. */
export interface PageKitTheme {
  colorScheme: "dark" | "light";
  vars: Record<string, string>;
  chart: Record<string, unknown>;
  palette: readonly string[];
}

export type PageFrameMessage =
  | { source: typeof PAGE_FRAME_SOURCE; type: "ready" }
  | { source: typeof PAGE_FRAME_SOURCE; type: "height"; height: number }
  | { source: typeof PAGE_FRAME_SOURCE; type: "open"; url: string };

export interface PageHostThemeMessage {
  source: typeof PAGE_HOST_SOURCE;
  type: "theme";
  theme: PageKitTheme;
}

/** How the page talks to its host: `postMessage` to a parent frame, or the RN WebView bridge. */
export type PageBridge = "iframe" | "webview";

export function buildPageKitTheme(tokens: PageThemeTokens): PageKitTheme {
  return {
    colorScheme: tokens.colorScheme,
    vars: pageCssVariables(tokens),
    chart: buildEChartsTheme(tokens),
    palette: tokens.palette.length > 0 ? tokens.palette : pagePaletteFor(tokens.colorScheme),
  };
}

/** Narrows an untrusted `postMessage` payload from a page. */
export function parsePageFrameMessage(value: unknown): PageFrameMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source !== PAGE_FRAME_SOURCE) return null;
  if (record.type === "ready") return { source: PAGE_FRAME_SOURCE, type: "ready" };
  if (record.type === "height" && typeof record.height === "number" && record.height >= 0) {
    return { source: PAGE_FRAME_SOURCE, type: "height", height: record.height };
  }
  if (
    record.type === "open" &&
    typeof record.url === "string" &&
    /^https?:\/\//i.test(record.url)
  ) {
    return { source: PAGE_FRAME_SOURCE, type: "open", url: record.url };
  }
  return null;
}

const KIT_CSS = `
html,body{margin:0;padding:0;background:transparent}
*,*::before,*::after{box-sizing:border-box}
body{color:var(--paseo-fg);font-family:var(--paseo-font-ui);font-size:var(--paseo-font-size);line-height:1.5;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
a{color:var(--paseo-accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.25;font-weight:600}
h1{font-size:1.4em}h2{font-size:1.2em}h3{font-size:1.05em}h4{font-size:1em}
p{margin:0 0 .75em}
ul,ol{margin:0 0 .75em;padding-left:1.4em}
code,pre,kbd{font-family:var(--paseo-font-mono);font-size:.92em}
code{background:var(--paseo-surface-2);padding:.1em .35em;border-radius:4px}
pre{background:var(--paseo-surface-1);border:1px solid var(--paseo-border);border-radius:var(--paseo-radius);padding:12px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--paseo-border);vertical-align:top}
th{color:var(--paseo-muted);font-weight:500;font-size:.92em}
tbody tr:hover{background:var(--paseo-surface-1)}
hr{border:0;border-top:1px solid var(--paseo-border);margin:16px 0}
button,input,select,textarea{font:inherit;color:inherit}
button{background:var(--paseo-surface-2);border:1px solid var(--paseo-border);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover{background:var(--paseo-surface-3)}
button[aria-pressed=true],button.active{background:var(--paseo-surface-3);border-color:var(--paseo-muted)}
input,select,textarea{background:var(--paseo-surface-1);border:1px solid var(--paseo-border);border-radius:6px;padding:4px 8px}
::selection{background:color-mix(in srgb,var(--paseo-accent) 35%,transparent)}
.p-card{background:var(--paseo-surface-1);border:1px solid var(--paseo-border);border-radius:var(--paseo-radius);padding:16px}
.p-floating{background:var(--paseo-floating);border:1px solid var(--paseo-floating-border);border-radius:var(--paseo-radius)}
.p-muted{color:var(--paseo-muted)}
.p-faint{color:var(--paseo-faint)}
.p-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.p-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}
.p-stat{font-size:1.6em;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}
.p-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:.85em;background:var(--paseo-surface-2);color:var(--paseo-muted)}
.p-badge.ok{color:var(--paseo-success)}
.p-badge.warn{color:var(--paseo-warning)}
.p-badge.bad{color:var(--paseo-danger)}
.p-chart{width:100%;height:320px}
`;

/**
 * Runs before the page's own scripts. Reports the content height, routes link clicks to
 * the host (pages cannot open windows), applies theme updates, and exposes `paseo.chart`.
 * Plain ES5-ish source: it is a string, so no bundler or minifier touches it.
 */
const KIT_SCRIPT = `
(function(){
  var BRIDGE = __BRIDGE__;
  var theme = __THEME__;
  var charts = [];
  var libs = null;
  function post(message){
    message.source = ${JSON.stringify(PAGE_FRAME_SOURCE)};
    try {
      if (BRIDGE === "webview") {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, "*");
      }
    } catch (error) {}
  }
  function applyTheme(next){
    theme = next;
    var root = document.documentElement;
    for (var key in next.vars) root.style.setProperty(key, next.vars[key]);
    root.style.colorScheme = next.colorScheme;
    root.setAttribute("data-theme", next.colorScheme);
    for (var i = 0; i < charts.length; i++) charts[i].redraw();
  }
  var lastHeight = -1;
  function measure(){
    var body = document.body;
    if (!body) return;
    var rect = body.getBoundingClientRect();
    var style = window.getComputedStyle(body);
    var height = Math.ceil(rect.height + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0"));
    var children = body.children;
    for (var i = 0; i < children.length; i++) {
      var bottom = children[i].getBoundingClientRect().bottom + window.scrollY;
      if (bottom > height) height = Math.ceil(bottom);
    }
    if (Math.abs(height - lastHeight) < 1) return;
    lastHeight = height;
    post({ type: "height", height: height });
  }
  var scheduled = false;
  function scheduleMeasure(){
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function(){ scheduled = false; measure(); });
  }
  function recolor(value){
    if (typeof value === "string") {
      var mapped = RECOLOR[value.toLowerCase()];
      return mapped === undefined ? value : theme.palette[mapped % theme.palette.length];
    }
    if (Array.isArray(value)) return value.map(recolor);
    if (value && typeof value === "object") {
      var out = {};
      for (var key in value) out[key] = recolor(value[key]);
      return out;
    }
    return value;
  }
  var RECOLOR = __RECOLOR__;
  function loadLibs(){
    if (libs) return libs;
    libs = new Promise(function(resolve, reject){
      var script = document.createElement("script");
      script.src = ${JSON.stringify(PAGE_KIT_ECHARTS_URL)};
      script.onload = function(){ resolve(window.echarts); };
      script.onerror = function(){ reject(new Error("paseo.chart: ECharts failed to load")); };
      document.head.appendChild(script);
    }).then(function(echarts){
      return import(${JSON.stringify(PAGE_KIT_FLINT_URL)}).then(function(flint){
        return { echarts: echarts, flint: flint };
      });
    });
    return libs;
  }
  function withInteractions(option){
    var out = {};
    for (var key in option) out[key] = option[key];
    if (!out.tooltip) out.tooltip = { trigger: "axis", axisPointer: { type: "cross" } };
    return out;
  }
  function chart(target, spec){
    var element = typeof target === "string" ? document.querySelector(target) : target;
    if (!element) return Promise.reject(new Error("paseo.chart: no element for " + target));
    if (!element.style.height && element.getBoundingClientRect().height < 40) element.style.height = "320px";
    return loadLibs().then(function(lib){
      var isFlint = spec && typeof spec === "object" && spec.chart_spec;
      var entry = { instance: null, redraw: null };
      entry.redraw = function(){
        var option = isFlint ? recolor(lib.flint.assembleECharts(spec)) : spec;
        // Flint lays out margins and label rotation for the height it reports; a shorter
        // box squashes the plot. chart_spec.baseSize is how a page asks for another size.
        if (isFlint && typeof option._height === "number") element.style.height = option._height + "px";
        delete option._width; delete option._height; delete option._dataLength;
        if (entry.instance) entry.instance.dispose();
        entry.instance = lib.echarts.init(element, theme.chart, { renderer: "canvas" });
        entry.instance.setOption(withInteractions(option), true);
      };
      entry.redraw();
      charts.push(entry);
      if (window.ResizeObserver) new ResizeObserver(function(){ entry.instance && entry.instance.resize(); }).observe(element);
      scheduleMeasure();
      return entry.instance;
    });
  }
  window.paseo = {
    get theme(){ return theme; },
    chart: chart,
    open: function(url){ post({ type: "open", url: String(url) }); }
  };
  function receive(message){
    if (!message || message.source !== ${JSON.stringify(PAGE_HOST_SOURCE)}) return;
    if (message.type === "theme" && message.theme) applyTheme(message.theme);
  }
  window.__paseoPageReceive = receive;
  window.addEventListener("message", function(event){ receive(event.data); });
  document.addEventListener("click", function(event){
    var node = event.target;
    while (node && node.nodeType === 1 && node.tagName !== "A") node = node.parentElement;
    if (!node || node.tagName !== "A") return;
    var href = node.getAttribute("href") || "";
    if (/^https?:\\/\\//i.test(href)) {
      event.preventDefault();
      post({ type: "open", url: href });
    } else if (href.charAt(0) !== "#") {
      event.preventDefault();
    }
  }, true);
  window.open = function(url){ if (url) post({ type: "open", url: String(url) }); return null; };
  applyTheme(theme);
  document.addEventListener("DOMContentLoaded", function(){
    measure();
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(scheduleMeasure);
      observer.observe(document.documentElement);
      observer.observe(document.body);
    }
    if (window.MutationObserver) new MutationObserver(scheduleMeasure).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    post({ type: "ready" });
  });
  window.addEventListener("load", measure);
})();
`;

// The ECharts defaults Flint writes into specs, by index, so the page swaps the same colors
// that `recolorChartSpec` swaps in chat.
const RECOLOR_INDEX: Record<string, number> = Object.fromEntries(
  ECHARTS_DEFAULT_PALETTE.map((color, position) => [color, position]),
);

/** Escapes a JSON value for a `<script>` body, so a `</script>` in a string cannot end it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildKitHead(theme: PageKitTheme, bridge: PageBridge): string {
  // A `<` in a value could close the style element; no valid color or font stack needs one.
  const rootVars = Object.entries(theme.vars)
    .map(([key, value]) => `${key}:${value.replace(/[<>]/g, "")}`)
    .join(";");
  // Replacer functions: a `$` in the JSON must not read as a replacement pattern.
  const script = KIT_SCRIPT.replace("__BRIDGE__", () => scriptJson(bridge))
    .replace("__THEME__", () => scriptJson(theme))
    .replace("__RECOLOR__", () => scriptJson(RECOLOR_INDEX));
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="color-scheme" content="${theme.colorScheme}">`,
    `<style id="paseo-kit">:root{${rootVars};color-scheme:${theme.colorScheme}}${KIT_CSS}</style>`,
    `<script id="paseo-kit-script">${script}</script>`,
  ].join("");
}

const HEAD_OPEN_RE = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN_RE = /<html(?:\s[^>]*)?>/i;
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i;

/**
 * Wraps an agent's HTML in a document that carries the kit. A full document keeps its own
 * head and body; the kit goes first in the head, so the page's own styles win.
 */
export function buildPageDocument(input: {
  html: string;
  theme: PageKitTheme;
  bridge: PageBridge;
}): string {
  const head = buildKitHead(input.theme, input.bridge);
  const { html } = input;
  const headMatch = HEAD_OPEN_RE.exec(html);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + head + html.slice(at);
  }
  const htmlMatch = HTML_OPEN_RE.exec(html);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, at)}<head>${head}</head>${html.slice(at)}`;
  }
  const doctype = DOCTYPE_RE.exec(html)?.[0] ?? "<!doctype html>";
  const body = html.replace(DOCTYPE_RE, "");
  return `${doctype}<html><head>${head}</head><body>${body}</body></html>`;
}
