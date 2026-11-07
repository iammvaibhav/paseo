import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import type { Logger } from "pino";
import type { Browser } from "playwright-core";
import { buildPageDocument, buildPageKitTheme } from "@getpaseo/protocol/page/kit";
import { PAGE_PREVIEW_THEMES } from "@getpaseo/protocol/page/theme";

export interface PagePreviewRequest {
  html?: string;
  url?: string;
  width: number;
  appearance: "dark" | "light";
}

export interface PagePreviewConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}

export type PagePreviewResult =
  | {
      kind: "captured";
      width: number;
      contentHeight: number;
      capturedHeight: number;
      png: Buffer;
      consoleMessages: PagePreviewConsoleMessage[];
    }
  | { kind: "installing"; message: string }
  | { kind: "failed"; message: string };

/** A screenshot taller than this is cut; the agent sees `contentHeight` for the real size. */
const MAX_CAPTURE_HEIGHT = 2400;
const MAX_CONSOLE_MESSAGES = 50;
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 4_000;
/** Close the browser after this long without a preview, so an idle daemon holds no Chromium. */
const IDLE_CLOSE_MS = 120_000;

const MEASURE_CONTENT_HEIGHT = `(() => {
  const body = document.body;
  if (!body) return 0;
  let height = body.getBoundingClientRect().height;
  for (const child of body.children) {
    height = Math.max(height, child.getBoundingClientRect().bottom + window.scrollY);
  }
  return Math.ceil(height);
})()`;

/**
 * The daemon's own headless Chromium, used only to show an agent what its page looks like.
 * Readers never see this browser: their client renders the page with its own engine.
 * The browser is Playwright's managed headless shell, installed on first use.
 */
export class PagePreviewBrowser {
  private browser: Promise<Browser> | null = null;
  private install: Promise<void> | null = null;
  private installError: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly logger: Logger) {}

  async capture(request: PagePreviewRequest): Promise<PagePreviewResult> {
    if (this.install) {
      return {
        kind: "installing",
        message:
          "Paseo is installing its preview browser (about 100 MB, first use only). Call preview_page again in a minute.",
      };
    }
    let browser: Browser;
    try {
      browser = await this.acquire();
    } catch (error) {
      return this.handleLaunchFailure(error);
    }
    this.touch();
    const theme = PAGE_PREVIEW_THEMES[request.appearance];
    const context = await browser.newContext({
      viewport: { width: request.width, height: 800 },
      colorScheme: request.appearance,
      deviceScaleFactor: 1,
    });
    const consoleMessages: PagePreviewConsoleMessage[] = [];
    const record = (message: PagePreviewConsoleMessage) => {
      if (consoleMessages.length < MAX_CONSOLE_MESSAGES) consoleMessages.push(message);
    };
    try {
      const page = await context.newPage();
      page.on("console", (message) => {
        const type = message.type();
        const level =
          type === "error" || type === "warning" || type === "info" ? type : ("log" as const);
        record({ level, text: message.text() });
      });
      page.on("pageerror", (error) => {
        record({ level: "error", text: error.stack ?? error.message });
      });
      if (request.url) {
        await page.goto(request.url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      } else {
        const document = buildPageDocument({
          html: request.html ?? "",
          theme: buildPageKitTheme(theme),
          bridge: "iframe",
        });
        await page.setContent(document, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
        // The reader's frame shows the page over the chat surface; paint that surface here.
        await page.evaluate(
          `document.documentElement.style.background = ${JSON.stringify(theme.backdrop)}`,
        );
      }
      await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      const contentHeight = Number(await page.evaluate(MEASURE_CONTENT_HEIGHT)) || 0;
      const capturedHeight = Math.max(1, Math.min(contentHeight || 800, MAX_CAPTURE_HEIGHT));
      await page.setViewportSize({ width: request.width, height: capturedHeight });
      const png = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: request.width, height: capturedHeight },
      });
      return {
        kind: "captured",
        width: request.width,
        contentHeight,
        capturedHeight,
        png,
        consoleMessages,
      };
    } catch (error) {
      return { kind: "failed", message: describeError(error) };
    } finally {
      await context.close().catch(() => {});
      this.touch();
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer ?? undefined);
    this.idleTimer = null;
    const pending = this.browser;
    this.browser = null;
    if (pending) {
      await pending.then((browser) => browser.close()).catch(() => {});
    }
  }

  private acquire(): Promise<Browser> {
    this.browser ??= import("playwright-core").then(({ chromium }) =>
      chromium.launch({ headless: true }).then((browser) => {
        browser.on("disconnected", () => {
          this.browser = null;
        });
        return browser;
      }),
    );
    this.browser.catch(() => {
      this.browser = null;
    });
    return this.browser;
  }

  private touch(): void {
    clearTimeout(this.idleTimer ?? undefined);
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private handleLaunchFailure(error: unknown): PagePreviewResult {
    const message = describeError(error);
    if (!/Executable doesn't exist|browserType\.launch: .*install/i.test(message)) {
      return { kind: "failed", message: `Preview browser failed to start: ${message}` };
    }
    if (this.installError) {
      return {
        kind: "failed",
        message: `Preview browser install failed: ${this.installError}`,
      };
    }
    this.startInstall();
    return {
      kind: "installing",
      message:
        "Paseo is installing its preview browser (about 100 MB, first use only). Call preview_page again in a minute.",
    };
  }

  private startInstall(): void {
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
    this.logger.info({ cli }, "Page preview: installing Chromium headless shell");
    const child = spawn(process.execPath, [cli, "install", "--only-shell", "chromium"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const run = async () => {
      try {
        const [code] = await once(child, "exit");
        if (code !== 0) {
          this.installError = stderr.trim() || `installer exited with code ${String(code)}`;
          this.logger.warn({ code, stderr }, "Page preview: Chromium install failed");
          return;
        }
        this.logger.info("Page preview: Chromium installed");
      } catch (error) {
        this.installError = describeError(error);
      } finally {
        this.install = null;
      }
    };
    this.install = run();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
