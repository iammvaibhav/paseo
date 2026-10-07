import { z } from "zod";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { PagePreviewBrowser } from "./preview-browser.js";

export interface RegisterPageToolsOptions {
  registerTool: <TInput>(
    name: string,
    config: PaseoToolConfig,
    handler: (input: TInput, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  previewBrowser: Pick<PagePreviewBrowser, "capture">;
}

export const PAGE_HTML_MAX_LENGTH = 512_000;
export const PAGE_MIN_HEIGHT = 80;
export const PAGE_MAX_HEIGHT = 2000;
const PAGE_DEFAULT_PREVIEW_WIDTH = 760;

const PAGE_LIBRARIES = [
  'Tailwind v4 (https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4): map colors to the kit vars in <style type="text/tailwindcss">@theme{--color-fg:var(--paseo-fg);--color-muted:var(--paseo-muted);--color-line:var(--paseo-border)}</style>',
  "Alpine.js (https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js, defer): tabs, toggles, filters in markup",
  "Web Awesome (https://cdn.jsdelivr.net/npm/@awesome.me/webawesome@3): tabs, tooltips, dialogs",
  "Observable Plot (https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm): quick statistical charts",
  "Cytoscape.js (https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js): graphs and networks",
  "Grid.js (https://cdn.jsdelivr.net/npm/gridjs@6/dist/gridjs.umd.js): sortable, searchable tables",
  "Motion (https://cdn.jsdelivr.net/npm/motion@12/+esm): transitions",
  "Lucide (https://cdn.jsdelivr.net/npm/lucide@0/dist/umd/lucide.min.js): icons, the app's own icon set",
];

const PAGE_RULES = [
  "Write one self-contained HTML document or fragment with inline <style> and <script>. Pages may load https CDN libraries and fetch any URL the reader's device can reach, including localhost.",
  "Paseo injects a kit before your code. CSS variables follow the reader's theme live: --paseo-fg, --paseo-muted, --paseo-faint, --paseo-border, --paseo-accent, --paseo-surface-1..3 (in-flow panels, cards, rows), --paseo-floating and --paseo-floating-border (anything over content: tooltips, menus), --paseo-cover, --paseo-background (opaque), --paseo-success, --paseo-warning, --paseo-danger, --paseo-chart-1..8, --paseo-font-ui, --paseo-font-mono, --paseo-radius.",
  "Base styles for text, tables, code, buttons, and inputs are already set. Helper classes: .p-card, .p-floating, .p-muted, .p-faint, .p-row, .p-grid, .p-stat, .p-badge (.ok/.warn/.bad), .p-chart.",
  "Charts: call paseo.chart(elementOrSelector, spec) with a Flint ChartAssemblyInput (same format as the flint fence) or a raw ECharts option. It loads ECharts and Flint and applies the reader's theme. A Flint chart takes the height Flint lays it out for; set chart_spec.baseSize to change it. A raw ECharts option fills the element, so give that element a fixed pixel height.",
  "Blend with the chat: leave html, body, and the outer element without a background, border, or banner title. Use fluid width with no outer horizontal padding. Never set a page background color. Never use backdrop-filter.",
  "Let content set the height. Do not use 100vh or height:100% on html or body.",
  "Links open in the reader's browser; window.open and popups are routed there too.",
];

const ShowPageInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).describe("Short name for the page."),
    html: z
      .string()
      .min(1)
      .max(PAGE_HTML_MAX_LENGTH)
      .optional()
      .describe("A self-contained HTML document or fragment. Give exactly one of html or url."),
    url: z
      .string()
      .url()
      .regex(/^https?:\/\//i, "url must use http or https")
      .optional()
      .describe(
        "An http(s) URL to embed instead of HTML, such as an app you started (http://localhost:5173). A localhost URL means this daemon's machine; Paseo proxies it to the reader. Give exactly one of html or url.",
      ),
    height: z
      .number()
      .int()
      .min(PAGE_MIN_HEIGHT)
      .max(PAGE_MAX_HEIGHT)
      .optional()
      .describe(
        `Frame height cap in CSS pixels, ${PAGE_MIN_HEIGHT}-${PAGE_MAX_HEIGHT}. HTML pages size to their content when omitted; content taller than the cap scrolls inside the frame. URL pages default to 640.`,
      ),
  })
  .refine((input) => Number(Boolean(input.html)) + Number(Boolean(input.url)) === 1, {
    message: "show_page requires exactly one of html or url",
  });

const PreviewPageInputSchema = z
  .object({
    html: z.string().min(1).max(PAGE_HTML_MAX_LENGTH).optional(),
    url: z
      .string()
      .url()
      .regex(/^https?:\/\//i, "url must use http or https")
      .optional(),
    width: z
      .number()
      .int()
      .min(240)
      .max(1600)
      .optional()
      .describe(
        `Viewport width in CSS pixels. Defaults to ${PAGE_DEFAULT_PREVIEW_WIDTH}, the chat column; use about 390 to check phones.`,
      ),
    appearance: z
      .enum(["dark", "light"])
      .optional()
      .describe("Theme to preview. Defaults to dark."),
  })
  .refine((input) => Number(Boolean(input.html)) + Number(Boolean(input.url)) === 1, {
    message: "preview_page requires exactly one of html or url",
  });

const HTML_TAG_RE = /<[a-z!][^>]*>/i;

export function registerPageTools(options: RegisterPageToolsOptions): void {
  options.registerTool(
    "show_page",
    {
      title: "Show page",
      description: [
        "Show an interactive HTML page inline in this chat, in the reply, above your final text. Use it when the answer needs interaction (filter, sort, tabs, hover), a table of more than 15 rows, a many-attribute comparison, a gallery, a mockup, a dashboard, or a running app (url). Prefer markdown, mermaid, or a flint fence for anything simpler.",
        "Check the page first with preview_page. The reader already sees the page, so the text reply must not announce it, describe where it is, or restate it: add only what the page does not show.",
        "Call show_page as its own tool call. The reader's app renders the page from that call, so a call made from inside eval, a script, or a subagent never reaches the chat. Put the full markup in html: a file path or a shell expression such as $(cat page.html) is not expanded.",
        ...PAGE_RULES,
        `Good libraries: ${PAGE_LIBRARIES.join("; ")}. Avoid CSS frameworks that paint their own page background (Pico, Bootstrap, DaisyUI defaults).`,
      ].join("\n"),
      inputSchema: ShowPageInputSchema,
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
      },
    },
    async (input: z.infer<typeof ShowPageInputSchema>) => {
      if (input.html !== undefined && !HTML_TAG_RE.test(input.html)) {
        const message =
          "html holds no HTML tag, so the reader would see it as plain text. Pass the page markup itself in html, not a file path or a command such as $(cat page.html), and call show_page directly, not from eval.";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          structuredContent: { ok: false, message },
        };
      }
      return {
        content: [],
        structuredContent: {
          ok: true,
          message:
            "The page is shown in the chat above your reply. Do not describe or restate it; add only what it does not show.",
        },
      };
    },
  );

  options.registerTool(
    "preview_page",
    {
      title: "Preview page",
      description: [
        "Render an HTML page (or an http(s) URL reachable from this machine) in Paseo's headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output, including uncaught errors with stacks. Use it to check and fix a page before show_page; console.log is a fine way to report your own checks.",
        "The page gets the same kit and theme variables as show_page. The first preview on a machine may report that Paseo is installing its preview browser; call again a minute later.",
      ].join("\n"),
      inputSchema: PreviewPageInputSchema,
    },
    async (input: z.infer<typeof PreviewPageInputSchema>) => {
      const result = await options.previewBrowser.capture({
        ...(input.html ? { html: input.html } : {}),
        ...(input.url ? { url: input.url } : {}),
        width: input.width ?? PAGE_DEFAULT_PREVIEW_WIDTH,
        appearance: input.appearance ?? "dark",
      });
      if (result.kind !== "captured") {
        return {
          content: [{ type: "text", text: result.message }],
          isError: result.kind === "failed",
          structuredContent: { ok: false, status: result.kind, message: result.message },
        };
      }
      const summary = {
        ok: true,
        width: result.width,
        contentHeight: result.contentHeight,
        capturedHeight: result.capturedHeight,
        consoleMessages: result.consoleMessages,
      };
      return {
        content: [
          { type: "image", data: result.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: JSON.stringify(summary) },
        ],
        structuredContent: summary,
      };
    },
  );
}
