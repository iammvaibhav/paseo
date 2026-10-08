import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { PageStore } from "./page-store.js";
import type { PagePreviewBrowser } from "./preview-browser.js";

export interface RegisterPageToolsOptions {
  registerTool: <TInput>(
    name: string,
    config: PaseoToolConfig,
    handler: (input: TInput, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  /** The page tools are registered only when both are present. */
  previewBrowser: Pick<PagePreviewBrowser, "capture"> | null | undefined;
  pageStore: Pick<PageStore, "save"> | null | undefined;
  /** The calling agent's working directory, for relative page paths. */
  resolveCallerCwd: () => string | null;
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

const PagePathSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Path to an HTML file on this machine, absolute or relative to your working directory. Paseo reads it, so you never repeat the markup in a tool call.",
  );

const PageUrlSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//i, "url must use http or https");

function countSources(input: { html?: string; url?: string; path?: string }): number {
  return Number(Boolean(input.html)) + Number(Boolean(input.url)) + Number(Boolean(input.path));
}

const ShowPageInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).describe("Short name for the page."),
    path: PagePathSchema.optional(),
    html: z
      .string()
      .min(1)
      .max(PAGE_HTML_MAX_LENGTH)
      .optional()
      .describe("The page markup itself, for a small page you write once."),
    url: PageUrlSchema.optional().describe(
      "An http(s) URL to embed instead of HTML, such as an app you started (http://localhost:5173). A localhost URL means this daemon's machine; Paseo proxies it to the reader.",
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
  .refine((input) => countSources(input) === 1, {
    message: "show_page requires exactly one of path, html, or url",
  });

const PreviewPageInputSchema = z
  .object({
    path: PagePathSchema.optional(),
    html: z.string().min(1).max(PAGE_HTML_MAX_LENGTH).optional(),
    url: PageUrlSchema.optional(),
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
  .refine((input) => countSources(input) === 1, {
    message: "preview_page requires exactly one of path, html, or url",
  });

const HTML_TAG_RE = /<[a-z!][^>]*>/i;

function errorResult(message: string): PaseoToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { ok: false, message },
  };
}

/** Reads a page file, or returns the error the agent should see. */
async function readPageFile(
  filePath: string,
  cwd: string | null,
): Promise<{ html: string } | { error: string }> {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd ?? process.cwd(), filePath);
  let html: string;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return { error: `${resolved} is not a file.` };
    if (info.size > PAGE_HTML_MAX_LENGTH) {
      return {
        error: `${resolved} is ${info.size} bytes; pages are limited to ${PAGE_HTML_MAX_LENGTH}.`,
      };
    }
    html = await readFile(resolved, "utf8");
  } catch (error) {
    return {
      error: `Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return HTML_TAG_RE.test(html) ? { html } : { error: `${resolved} holds no HTML tag.` };
}

export function registerPageTools(options: RegisterPageToolsOptions): void {
  const { previewBrowser, pageStore } = options;
  if (!previewBrowser || !pageStore) return;
  options.registerTool(
    "show_page",
    {
      title: "Show page",
      description: [
        "Show an interactive HTML page inline in this chat, in the reply, above your final text. Use it when the answer needs interaction (filter, sort, tabs, hover), a table of more than 15 rows, a many-attribute comparison, a gallery, a mockup, a dashboard, or a running app (url). Prefer markdown, mermaid, or a flint fence for anything simpler.",
        "Workflow: write the page to a file, check it with preview_page({ path }), fix and re-check, then show_page({ title, path }). The file is read when you call, so you never paste the markup into a tool call; later edits to the file do not change a page already shown. Use html only for a small page you write once.",
        "Call show_page as its own tool call. The reader's app renders the page from that call, so a call made from inside eval, a script, or a subagent never reaches the chat.",
        "The reader already sees the page, so the text reply must not announce it, describe where it is, or restate it: add only what the page does not show.",
        ...PAGE_RULES,
        `Good libraries: ${PAGE_LIBRARIES.join("; ")}. Avoid CSS frameworks that paint their own page background (Pico, Bootstrap, DaisyUI defaults).`,
      ].join("\n"),
      inputSchema: ShowPageInputSchema,
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        pageId: z.string().optional(),
      },
    },
    async (input: z.infer<typeof ShowPageInputSchema>) => {
      if (input.html !== undefined && !HTML_TAG_RE.test(input.html)) {
        return errorResult(
          "html holds no HTML tag, so the reader would see it as plain text. Pass a file with path, or the markup itself in html; a shell expression such as $(cat page.html) is not expanded.",
        );
      }
      const shown =
        "The page is shown in the chat above your reply. Do not describe or restate it; add only what it does not show.";
      if (input.path === undefined) {
        return { content: [], structuredContent: { ok: true, message: shown } };
      }
      const page = await readPageFile(input.path, options.resolveCallerCwd());
      if ("error" in page) return errorResult(page.error);
      const pageId = await pageStore.save(page.html);
      // The reader's app finds the id in this text whatever shape the provider gives results.
      return {
        content: [{ type: "text", text: `Shown page ${pageId}. ${shown}` }],
        structuredContent: { ok: true, message: shown, pageId },
      };
    },
  );

  options.registerTool(
    "preview_page",
    {
      title: "Preview page",
      description: [
        "Render an HTML page (a file path, the markup, or an http(s) URL reachable from this machine) in Paseo's headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output, including uncaught errors with stacks. Use it to check and fix a page before show_page; console.log is a fine way to report your own checks. Prefer path: edit the file and preview again without repeating the markup.",
        "The page gets the same kit and theme variables as show_page. The first preview on a machine may report that Paseo is installing its preview browser; call again a minute later.",
      ].join("\n"),
      inputSchema: PreviewPageInputSchema,
    },
    async (input: z.infer<typeof PreviewPageInputSchema>) => {
      let html = input.html;
      if (input.path !== undefined) {
        const page = await readPageFile(input.path, options.resolveCallerCwd());
        if ("error" in page) return errorResult(page.error);
        html = page.html;
      }
      const result = await previewBrowser.capture({
        ...(html ? { html } : {}),
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
