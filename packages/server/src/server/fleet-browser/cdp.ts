import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

// A browser-level Chrome DevTools Protocol connection, enough for the target
// commands the fleet browser needs. The fleet Chromes take no token: NetBird is
// their only access control. No Origin header is sent, so Chrome's
// --remote-allow-origins check does not apply.

const CONNECT_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 15_000;

export class CdpError extends Error {
  public constructor(
    message: string,
    /** True when the browser could not be reached at all (as opposed to a refused command). */
    public readonly unreachable = false,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

interface Pending {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () => this.failAll(new CdpError("CDP connection closed", true)));
    socket.on("error", (error) => this.failAll(new CdpError(`CDP error: ${error.message}`, true)));
  }

  public static async open(cdpUrl: string): Promise<CdpConnection> {
    const wsUrl = await fetchBrowserWebSocketUrl(cdpUrl);
    const socket = new WebSocket(wsUrl, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(new CdpError(`cannot open CDP at ${cdpUrl}: ${error.message}`, true));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    await promise;
    return new CdpConnection(socket);
  }

  public send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    this.pending.set(id, { method, timer, resolve: (value) => resolve(value as T), reject });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return promise;
  }

  public close(): void {
    this.failAll(new CdpError("CDP connection closed"));
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private onMessage(text: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CdpError(`${pending.method}: ${message.error.message ?? "failed"}`));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private failAll(error: Error): void {
    if (!this.closedError) this.closedError = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

async function fetchBrowserWebSocketUrl(cdpUrl: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CdpError(
      `cannot reach the browser at ${cdpUrl} (${error instanceof Error ? error.message : String(error)}); is this host on NetBird?`,
      true,
    );
  }
  if (!response.ok) {
    throw new CdpError(
      `the browser at ${cdpUrl} answered ${response.status}; it may be restarting`,
      true,
    );
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string") {
    throw new CdpError(`the browser at ${cdpUrl} did not report a DevTools URL`, true);
  }
  return body.webSocketDebuggerUrl;
}

export async function withCdp<T>(
  cdpUrl: string,
  work: (cdp: CdpConnection) => Promise<T>,
): Promise<T> {
  const cdp = await CdpConnection.open(cdpUrl);
  try {
    return await work(cdp);
  } finally {
    cdp.close();
  }
}

export interface CdpPageTarget {
  targetId: string;
  url: string;
  title: string;
  browserContextId: string | null;
}

export async function listPageTargets(cdp: CdpConnection): Promise<CdpPageTarget[]> {
  const result = await cdp.send<{ targetInfos?: Array<Record<string, unknown>> }>(
    "Target.getTargets",
  );
  return (result.targetInfos ?? [])
    .filter((info) => info.type === "page" && typeof info.targetId === "string")
    .map((info) => ({
      targetId: String(info.targetId),
      url: typeof info.url === "string" ? info.url : "",
      title: typeof info.title === "string" ? info.title : "",
      browserContextId: typeof info.browserContextId === "string" ? info.browserContextId : null,
    }));
}

/** Runs `work` with a flat session attached to one page target. */
export async function withPageSession<T>(
  cdp: CdpConnection,
  targetId: string,
  work: (sessionId: string) => Promise<T>,
): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    return await work(sessionId);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

/**
 * Waits until the window left the initial about:blank and finished loading.
 * agent-browser attaching to a window that is still being created can bind to
 * a different tab, so open returns only after this. On timeout it returns anyway.
 */
export async function waitForPageLoaded(
  cdp: CdpConnection,
  targetId: string,
  url: string,
  timeoutMs = 20_000,
): Promise<void> {
  await withPageSession(cdp, targetId, async (sessionId) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await cdp
        .send<{ result?: { value?: unknown } }>(
          "Runtime.evaluate",
          {
            expression: "JSON.stringify([location.href, document.readyState])",
            returnByValue: true,
          },
          sessionId,
        )
        .catch(() => null);
      const value = result?.result?.value;
      if (typeof value === "string") {
        const [href, state] = JSON.parse(value) as [string, string];
        if (state === "complete" && (href !== "about:blank" || url === "about:blank")) return;
      }
      await sleep(200);
    }
  });
}
