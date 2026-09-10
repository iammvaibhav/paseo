import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

const READY_TIMEOUT_MS = 15_000;
const MIN_UI_HTML_BYTES = 1_000_000;
const FINAL_API_PATHS = new Set(["/api/approve", "/api/deny", "/api/feedback"]);
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

interface ProxySession {
  browserId: string;
  remoteUrl: URL;
  server: Server;
  url: string;
}

export interface PlannotatorProxyManagerOptions {
  cacheDirectory: string;
  logger: Logger;
  loadUiHtml?: () => Promise<Buffer>;
  onSubmitted?: (browserId: string) => void;
}

export interface OpenPlannotatorProxyInput {
  browserId: string;
  remoteUrl: string;
}

export interface OpenPlannotatorProxyResult {
  url: string;
  accelerated: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolvePlannotatorBinary(): Promise<string | null> {
  const candidates = [
    process.env.PASEO_PLANNOTATOR_BINARY,
    join(homedir(), ".local", "bin", "plannotator"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "plannotator")),
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the standard install locations and PATH.
    }
  }
  return null;
}

async function waitForReadyFile(input: {
  readyFile: string;
  child: ChildProcess;
}): Promise<{ url: string }> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null) {
      throw new Error("Local Plannotator exited before its UI became ready");
    }
    try {
      const raw = await readFile(input.readyFile, "utf8");
      const parsed = JSON.parse(raw) as { url?: unknown };
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        return { url: parsed.url.trim() };
      }
    } catch {
      // Ready file is not present or complete yet.
    }
    await sleep(50);
  }
  throw new Error("Timed out preparing the local Plannotator UI");
}

async function stopExtractor(child: ChildProcess, url: string | null): Promise<void> {
  if (url) {
    try {
      await fetch(new URL("/api/exit", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(500),
      });
    } catch {
      // The process is disposable; signal fallback below owns cleanup.
    }
  }
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await sleep(100);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function extractUiHtml(binary: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plannotator-ui-"));
  const documentPath = join(directory, "cache-source.md");
  const readyFile = join(directory, "ready.json");
  await writeFile(documentPath, "# Paseo\n", "utf8");

  const env = { ...process.env };
  delete env.PLANNOTATOR_PORT;
  delete env.PLANNOTATOR_REMOTE;
  env.PLANNOTATOR_READY_FILE = readyFile;
  env.PLANNOTATOR_SKIP_BROWSER_OPEN = "1";
  env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
  env.BROWSER = "none";

  const child = spawn(binary, ["annotate", documentPath, "--json", "--gate"], {
    cwd: directory,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let readyUrl: string | null = null;
  try {
    const ready = await waitForReadyFile({ readyFile, child });
    readyUrl = ready.url;
    const response = await fetch(ready.url, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`Local Plannotator UI returned HTTP ${response.status}`);
    }
    const html = Buffer.from(await response.arrayBuffer());
    if (html.byteLength < MIN_UI_HTML_BYTES) {
      throw new Error(`Local Plannotator UI was unexpectedly small (${html.byteLength} bytes)`);
    }
    return html;
  } finally {
    await stopExtractor(child, readyUrl);
    await rm(directory, { recursive: true, force: true });
  }
}

async function readCachedUiHtml(input: {
  binary: string;
  cacheDirectory: string;
}): Promise<Buffer> {
  const binaryStat = await stat(input.binary);
  const cacheKey = `${basename(input.binary)}-${binaryStat.size}-${Math.floor(binaryStat.mtimeMs)}`;
  const cachePath = join(input.cacheDirectory, `${cacheKey}.html`);
  try {
    const cached = await readFile(cachePath);
    if (cached.byteLength >= MIN_UI_HTML_BYTES) {
      return cached;
    }
  } catch {
    // Populate the cache below.
  }

  const html = await extractUiHtml(input.binary);
  await mkdir(input.cacheDirectory, { recursive: true });
  await writeFile(cachePath, html);
  return html;
}

function parseRemoteUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Invalid Plannotator remote URL");
  }
  return parsed;
}

function writeUiResponse(response: import("node:http").ServerResponse, html: Buffer): void {
  const cookieSuffix = `Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(html.byteLength),
    "Cache-Control": "private, max-age=31536000, immutable",
    "Set-Cookie": [
      `plannotator-auto-close=0; ${cookieSuffix}`,
      `plannotator-color-theme=neutral; ${cookieSuffix}`,
      `plannotator-theme=system; ${cookieSuffix}`,
      `plannotator-grid-enabled=false; ${cookieSuffix}`,
    ],
  });
  response.end(html);
}

function copyProxyResponseHeaders(
  upstream: IncomingMessage,
  response: import("node:http").ServerResponse,
): void {
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value !== undefined && name.toLowerCase() !== "connection") {
      response.setHeader(name, value);
    }
  }
}

function proxyRequest(input: {
  request: IncomingMessage;
  response: import("node:http").ServerResponse;
  remoteUrl: URL;
  onSubmitted: () => void;
}): void {
  const target = new URL(input.request.url ?? "/", input.remoteUrl);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...input.request.headers, host: target.host };
  delete headers.connection;

  const upstream = requestImpl(
    target,
    {
      method: input.request.method,
      headers,
    },
    (upstreamResponse) => {
      input.response.statusCode = upstreamResponse.statusCode ?? 502;
      if (upstreamResponse.statusMessage) {
        input.response.statusMessage = upstreamResponse.statusMessage;
      }
      copyProxyResponseHeaders(upstreamResponse, input.response);
      upstreamResponse.pipe(input.response);
      if (
        FINAL_API_PATHS.has(target.pathname) &&
        (upstreamResponse.statusCode ?? 500) >= 200 &&
        (upstreamResponse.statusCode ?? 500) < 300
      ) {
        upstreamResponse.once("end", input.onSubmitted);
      }
    },
  );
  upstream.on("error", (error) => {
    if (!input.response.headersSent) {
      input.response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    input.response.end(`Plannotator proxy error: ${error.message}`);
  });
  input.request.pipe(upstream);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Plannotator proxy did not allocate a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export class PlannotatorProxyManager {
  private readonly options: PlannotatorProxyManagerOptions;
  private readonly sessions = new Map<string, ProxySession>();
  private uiHtmlPromise: Promise<Buffer> | null = null;

  constructor(options: PlannotatorProxyManagerOptions) {
    this.options = options;
  }

  warmCache(): Promise<void> {
    return this.getUiHtml().then(() => undefined);
  }

  async openSession(input: OpenPlannotatorProxyInput): Promise<OpenPlannotatorProxyResult> {
    const browserId = input.browserId.trim();
    if (!browserId) {
      throw new Error("Plannotator browser ID is required");
    }
    const remoteUrl = parseRemoteUrl(input.remoteUrl);
    await this.closeSession(browserId);

    let html: Buffer;
    try {
      html = await this.getUiHtml();
    } catch (error) {
      this.options.logger.warn("Local Plannotator UI cache unavailable; using remote UI", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { url: remoteUrl.toString(), accelerated: false };
    }

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && !requestUrl.pathname.startsWith("/api/")) {
        writeUiResponse(response, html);
        return;
      }
      proxyRequest({
        request,
        response,
        remoteUrl,
        onSubmitted: () => this.options.onSubmitted?.(browserId),
      });
    });
    const url = await listen(server);
    this.sessions.set(browserId, { browserId, remoteUrl, server, url });
    this.options.logger.info("Local Plannotator UI proxy started", {
      browserId,
      url,
      remoteUrl: remoteUrl.toString(),
    });
    return { url, accelerated: true };
  }

  async closeSession(browserId: string): Promise<void> {
    const session = this.sessions.get(browserId);
    if (!session) {
      return;
    }
    this.sessions.delete(browserId);
    await closeServer(session.server);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((browserId) => this.closeSession(browserId)));
  }

  private getUiHtml(): Promise<Buffer> {
    if (!this.uiHtmlPromise) {
      this.uiHtmlPromise = this.loadUiHtml().catch((error) => {
        this.uiHtmlPromise = null;
        throw error;
      });
    }
    return this.uiHtmlPromise;
  }

  private async loadUiHtml(): Promise<Buffer> {
    if (this.options.loadUiHtml) {
      return this.options.loadUiHtml();
    }
    const binary = await resolvePlannotatorBinary();
    if (!binary) {
      throw new Error("Local Plannotator binary not found");
    }
    return readCachedUiHtml({ binary, cacheDirectory: this.options.cacheDirectory });
  }
}
