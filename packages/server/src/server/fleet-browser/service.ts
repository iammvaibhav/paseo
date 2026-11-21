import type { Logger } from "pino";
import type {
  FleetBrowserControlAction,
  FleetBrowserDelivery,
  FleetBrowserThumbnail,
  FleetBrowserWindow,
  FleetBrowserWindowKind,
} from "@getpaseo/protocol/fleet-browser/types";
import {
  AGENT_BROWSER_SESSION_PATTERN,
  bindAgentBrowserSession,
  closeAgentBrowserSession,
} from "./agent-browser.js";
import { formatReleaseNotice, formatResumeNotice, formatTakeoverNotice } from "./agent-notices.js";
import {
  CdpError,
  listPageTargets,
  waitForPageLoaded,
  withCdp,
  withPageSession,
  type CdpConnection,
  type CdpPageTarget,
} from "./cdp.js";
import type { FleetBrowserConfig, FleetBrowserHost } from "./config.js";
import { newWindowId, type FleetBrowserStore, type StoredWindow } from "./store.js";

/** What the service needs from the agent layer. */
export interface FleetBrowserAgents {
  /** The agent's current workspace, or null when the agent is unknown. */
  workspaceIdOf(agentId: string): Promise<string | null>;
  isRunning(agentId: string): boolean;
  /** Delivers daemon-prepared context: steers a running turn, else starts one. */
  deliver(agentId: string, text: string): Promise<FleetBrowserDelivery>;
}

export interface FleetBrowserChange {
  workspaceIds: string[];
  windowIds: string[];
}

export interface OpenWindowInput {
  host: string;
  kind: FleetBrowserWindowKind;
  label: string;
  url?: string;
  session?: string;
}

export interface FleetBrowserControlResult {
  window: FleetBrowserWindow | null;
  delivery: FleetBrowserDelivery;
}

export class FleetBrowserError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FleetBrowserError";
  }
}

const REFRESH_INTERVAL_MS = 15_000;
const LIST_MAX_STALENESS_MS = 3_000;
const THUMBNAIL_DEFAULT_WIDTH = 320;

export class FleetBrowserService {
  private readonly listeners = new Set<(change: FleetBrowserChange) => void>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly options: {
      config: FleetBrowserConfig;
      store: FleetBrowserStore;
      agents: FleetBrowserAgents;
      logger: Logger;
    },
  ) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.options.store.all().length > 0) void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  public onChange(listener: (change: FleetBrowserChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public isConfigured(): boolean {
    return this.options.config.isConfigured();
  }

  public hosts(): FleetBrowserHost[] {
    return [...this.options.config.hosts().values()];
  }

  // ---------------------------------------------------------------- agent side

  public async open(agentId: string, input: OpenWindowInput): Promise<FleetBrowserWindow> {
    const host = this.requireHost(input.host);
    const label = input.label.trim().slice(0, 80);
    if (!label)
      throw new FleetBrowserError("label is required: a few words on what the window is for");
    const id = newWindowId();
    const session = input.session?.trim() || `fb-${id.slice(3)}`;
    if (!AGENT_BROWSER_SESSION_PATTERN.test(session)) {
      throw new FleetBrowserError(
        "session must be letters, digits, dot, dash or underscore (at most 64 characters)",
      );
    }
    const url = input.url?.trim() || "about:blank";
    if (url !== "about:blank" && !/^https?:\/\//i.test(url)) {
      throw new FleetBrowserError("url must be http(s) or omitted");
    }

    const opened = await this.withHost(host, async (cdp) => {
      const contextId =
        input.kind === "fresh"
          ? (
              await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {
                disposeOnDetach: false,
              })
            ).browserContextId
          : null;
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url,
        newWindow: true,
        ...(contextId ? { browserContextId: contextId } : {}),
      });
      try {
        await waitForPageLoaded(cdp, targetId, url);
        await bindAgentBrowserSession({ session, targetId, cdpUrl: host.cdpUrl });
      } catch (error) {
        await (
          contextId
            ? cdp.send("Target.disposeBrowserContext", { browserContextId: contextId })
            : cdp.send("Target.closeTarget", { targetId })
        ).catch(() => undefined);
        throw new FleetBrowserError(
          `could not bind agent-browser session ${session}: ${errorMessage(error)}; the window was closed`,
        );
      }
      const info = await cdp
        .send<{ targetInfo?: { url?: string; title?: string } }>("Target.getTargetInfo", {
          targetId,
        })
        .catch(() => null);
      return {
        contextId,
        targetId,
        url: info?.targetInfo?.url ?? url,
        title: info?.targetInfo?.title ?? null,
      };
    });

    const now = new Date().toISOString();
    const window: StoredWindow = {
      id,
      agentId,
      host: host.name,
      kind: input.kind,
      label,
      session,
      targetId: opened.targetId,
      contextId: opened.contextId,
      openedAt: now,
      url: opened.url,
      title: opened.title,
      reachable: true,
      control: {
        owner: "agent",
        since: now,
        agentNotified: false,
        startUrl: null,
        startTitle: null,
      },
      handoff: null,
    };
    await this.options.store.put(window);
    this.options.logger.info(
      { agentId, windowId: id, host: host.name, kind: input.kind, targetId: opened.targetId },
      "fleet_browser.window_opened",
    );
    await this.emit([window]);
    return this.toWire(window, await this.options.agents.workspaceIdOf(agentId));
  }

  public async listForAgent(agentId: string): Promise<FleetBrowserWindow[]> {
    this.refreshSoonIfStale();
    const workspaceId = await this.options.agents.workspaceIdOf(agentId);
    return this.options.store
      .all()
      .filter((window) => window.agentId === agentId)
      .map((window) => this.toWire(window, workspaceId));
  }

  public async handoff(
    agentId: string,
    windowId: string,
    reason: string,
  ): Promise<FleetBrowserWindow> {
    return this.serial(windowId, async () => {
      const window = this.requireOwnedWindow(agentId, windowId);
      window.handoff = {
        reason: reason.trim().slice(0, 500),
        requestedAt: new Date().toISOString(),
      };
      await this.options.store.put(window);
      await this.raise(window).catch((error: unknown) =>
        this.options.logger.warn({ err: error, windowId }, "fleet_browser.raise_failed"),
      );
      await this.emit([window]);
      return this.toWire(window, await this.options.agents.workspaceIdOf(agentId));
    });
  }

  // ---------------------------------------------------------------- shared

  /**
   * Closes the window (or the fresh session) and forgets it. `agentId` limits it to the
   * owner, who may not close it while the user has control.
   */
  public async close(windowId: string, agentId?: string): Promise<boolean> {
    return this.serial(windowId, async () => {
      const window = agentId
        ? this.requireOwnedWindow(agentId, windowId)
        : this.options.store.get(windowId);
      if (!window) return false;
      if (agentId && window.control.owner === "user") {
        throw new FleetBrowserError(
          `the user has control of window ${windowId}; leave it open and wait for the Browser resume message`,
        );
      }
      await closeAgentBrowserSession(window.session);
      const host = this.options.config.host(window.host);
      if (host) {
        try {
          await withCdp(host.cdpUrl, (cdp) =>
            window.contextId
              ? cdp.send("Target.disposeBrowserContext", { browserContextId: window.contextId })
              : cdp.send("Target.closeTarget", { targetId: window.targetId }),
          );
        } catch (error) {
          if (error instanceof CdpError && error.unreachable) {
            throw new FleetBrowserError(
              `the ${window.host} browser is unreachable; try again shortly`,
            );
          }
          // The window or context is already gone.
        }
      }
      await this.options.store.delete(window.id);
      this.options.logger.info(
        { windowId, agentId: window.agentId },
        "fleet_browser.window_closed",
      );
      await this.emit([window]);
      return true;
    });
  }

  // ---------------------------------------------------------------- user side

  public async listForWorkspace(workspaceId: string): Promise<FleetBrowserWindow[]> {
    this.refreshSoonIfStale();
    const views: FleetBrowserWindow[] = [];
    for (const window of this.options.store.all()) {
      const owner = await this.options.agents.workspaceIdOf(window.agentId);
      if (owner === workspaceId) views.push(this.toWire(window, owner));
    }
    return views.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  public async show(windowId: string): Promise<boolean> {
    const window = this.requireWindow(windowId);
    await this.raise(window);
    return true;
  }

  public async thumbnail(
    windowId: string,
    maxWidth = THUMBNAIL_DEFAULT_WIDTH,
  ): Promise<FleetBrowserThumbnail | null> {
    const window = this.requireWindow(windowId);
    const host = this.requireHost(window.host);
    return withCdp(host.cdpUrl, (cdp) =>
      withPageSession(cdp, window.targetId, async (sessionId) => {
        const metrics = await cdp.send<{
          cssVisualViewport?: {
            pageX?: number;
            pageY?: number;
            clientWidth?: number;
            clientHeight?: number;
          };
        }>("Page.getLayoutMetrics", {}, sessionId);
        const viewport = metrics.cssVisualViewport;
        const width = viewport?.clientWidth ?? 0;
        const height = viewport?.clientHeight ?? 0;
        if (width <= 0 || height <= 0) return null;
        const scale = Math.min(1, maxWidth / width);
        const shot = await cdp.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "jpeg",
            quality: 60,
            clip: { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0, width, height, scale },
          },
          sessionId,
        );
        return {
          mimeType: "image/jpeg",
          data: shot.data,
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        };
      }),
    );
  }

  public async control(
    windowId: string,
    action: FleetBrowserControlAction,
    note: string | null,
  ): Promise<FleetBrowserControlResult> {
    return this.serial(windowId, async () => {
      const window = this.requireWindow(windowId);
      const delivery =
        action === "take"
          ? await this.takeControl(window)
          : await this.returnControl(window, action, note);
      return {
        window: this.toWire(window, await this.options.agents.workspaceIdOf(window.agentId)),
        delivery,
      };
    });
  }

  private async takeControl(window: StoredWindow): Promise<FleetBrowserDelivery> {
    if (window.control.owner === "user") return "none";
    const page = await this.readPage(window);
    window.control = {
      owner: "user",
      since: new Date().toISOString(),
      agentNotified: false,
      startUrl: page.url,
      startTitle: page.title,
    };
    await this.options.store.put(window);
    await this.raise(window).catch((error: unknown) =>
      this.options.logger.warn({ err: error, windowId: window.id }, "fleet_browser.raise_failed"),
    );
    let delivery: FleetBrowserDelivery = "none";
    if (this.options.agents.isRunning(window.agentId)) {
      delivery = await this.options.agents.deliver(window.agentId, formatTakeoverNotice(window));
      window.control.agentNotified = delivery !== "none";
      await this.options.store.put(window);
    }
    this.options.logger.info({ windowId: window.id, delivery }, "fleet_browser.control_taken");
    await this.emit([window]);
    return delivery;
  }

  private async returnControl(
    window: StoredWindow,
    action: "release" | "resume",
    note: string | null,
  ): Promise<FleetBrowserDelivery> {
    const wasUser = window.control.owner === "user";
    const page = await this.readPage(window);
    const pausedMs = wasUser ? Date.now() - Date.parse(window.control.since) : 0;
    const notice =
      action === "resume"
        ? formatResumeNotice({
            window,
            pausedMs,
            url: page.url,
            title: page.title,
            note: note?.trim() || null,
          })
        : formatReleaseNotice(window);
    const mustTell =
      action === "resume" ||
      (window.control.agentNotified && this.options.agents.isRunning(window.agentId));
    window.control = {
      owner: "agent",
      since: new Date().toISOString(),
      agentNotified: false,
      startUrl: null,
      startTitle: null,
    };
    window.handoff = null;
    await this.options.store.put(window);
    const delivery = mustTell ? await this.options.agents.deliver(window.agentId, notice) : "none";
    this.options.logger.info(
      { windowId: window.id, action, delivery },
      "fleet_browser.control_returned",
    );
    await this.emit([window]);
    return delivery;
  }

  // ---------------------------------------------------------------- reconcile

  /**
   * Lists answer from the registry at once and re-read the browsers in the background;
   * a change found there is pushed as fleet_browser.changed. A browser that is down
   * would otherwise hold every list for the CDP connect timeout.
   */
  private refreshSoonIfStale(): void {
    if (Date.now() - this.lastRefreshAt < LIST_MAX_STALENESS_MS) return;
    void this.refresh().catch((error: unknown) =>
      this.options.logger.warn({ err: error }, "fleet_browser.refresh_failed"),
    );
  }

  /** Re-reads every window's page from its browser; forgets windows that are gone. */
  public refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refreshOnce().finally(() => {
        this.refreshing = null;
        this.lastRefreshAt = Date.now();
      });
    }
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const byHost = new Map<string, StoredWindow[]>();
    for (const window of this.options.store.all()) {
      byHost.set(window.host, [...(byHost.get(window.host) ?? []), window]);
    }
    const changed: StoredWindow[] = [];
    const gone: StoredWindow[] = [];
    for (const [hostName, windows] of byHost) {
      const host = this.options.config.host(hostName);
      let targets: CdpPageTarget[] | null = null;
      if (host) {
        try {
          targets = await withCdp(host.cdpUrl, listPageTargets);
        } catch (error) {
          this.options.logger.debug(
            { err: error, host: hostName },
            "fleet_browser.refresh_unreachable",
          );
        }
      }
      for (const window of windows) {
        if (!targets) {
          if (window.reachable) {
            window.reachable = false;
            changed.push(window);
          }
          continue;
        }
        const target = targets.find((candidate) => candidate.targetId === window.targetId);
        if (!target) {
          gone.push(window);
          continue;
        }
        if (!window.reachable || window.url !== target.url || window.title !== target.title) {
          window.reachable = true;
          window.url = target.url;
          window.title = target.title;
          changed.push(window);
        }
      }
    }
    for (const window of gone) {
      await this.options.store.delete(window.id);
      await closeAgentBrowserSession(window.session);
      this.options.logger.info(
        { windowId: window.id, host: window.host },
        "fleet_browser.window_gone",
      );
    }
    if (changed.length > 0) await this.options.store.save();
    if (changed.length > 0 || gone.length > 0) await this.emit([...changed, ...gone]);
  }

  // ---------------------------------------------------------------- helpers

  private requireHost(name: string): FleetBrowserHost {
    const host = this.options.config.host(name);
    if (host) return host;
    const known = [...this.options.config.hosts().keys()];
    throw new FleetBrowserError(
      known.length > 0
        ? `unknown fleet browser "${name}"; this host knows ${known.join(", ")}`
        : "no fleet browsers are configured on this host (~/.paseo/fleet-browser.json)",
    );
  }

  private requireWindow(windowId: string): StoredWindow {
    const window = this.options.store.get(windowId);
    if (!window) throw new FleetBrowserError(`no open fleet browser window ${windowId}`);
    return window;
  }

  private requireOwnedWindow(agentId: string, windowId: string): StoredWindow {
    const window = this.requireWindow(windowId);
    if (window.agentId !== agentId) {
      throw new FleetBrowserError(`window ${windowId} belongs to another agent`);
    }
    return window;
  }

  private async withHost<T>(
    host: FleetBrowserHost,
    work: (cdp: CdpConnection) => Promise<T>,
  ): Promise<T> {
    try {
      return await withCdp(host.cdpUrl, work);
    } catch (error) {
      if (error instanceof FleetBrowserError) throw error;
      throw new FleetBrowserError(errorMessage(error));
    }
  }

  private async raise(window: StoredWindow): Promise<void> {
    const host = this.requireHost(window.host);
    await withCdp(host.cdpUrl, (cdp) =>
      cdp.send("Target.activateTarget", { targetId: window.targetId }),
    );
  }

  private async readPage(
    window: StoredWindow,
  ): Promise<{ url: string | null; title: string | null }> {
    const host = this.options.config.host(window.host);
    if (!host) return { url: window.url, title: window.title };
    try {
      const info = await withCdp(host.cdpUrl, (cdp) =>
        cdp.send<{ targetInfo?: { url?: string; title?: string } }>("Target.getTargetInfo", {
          targetId: window.targetId,
        }),
      );
      window.url = info.targetInfo?.url ?? window.url;
      window.title = info.targetInfo?.title ?? window.title;
    } catch (error) {
      this.options.logger.debug(
        { err: error, windowId: window.id },
        "fleet_browser.read_page_failed",
      );
    }
    return { url: window.url, title: window.title };
  }

  /** Serializes control changes per window, so a double click cannot interleave two. */
  private serial<T>(windowId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(windowId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(windowId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(windowId) === next) this.queues.delete(windowId);
      });
    return next;
  }

  private async emit(windows: StoredWindow[]): Promise<void> {
    if (this.listeners.size === 0) return;
    const workspaceIds = new Set<string>();
    for (const window of windows) {
      const workspaceId = await this.options.agents.workspaceIdOf(window.agentId);
      if (workspaceId) workspaceIds.add(workspaceId);
    }
    const change = {
      workspaceIds: [...workspaceIds],
      windowIds: windows.map((window) => window.id),
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.options.logger.warn({ err: error }, "fleet_browser.change_listener_failed");
      }
    }
  }

  private toWire(window: StoredWindow, workspaceId: string | null): FleetBrowserWindow {
    return {
      id: window.id,
      agentId: window.agentId,
      workspaceId,
      host: window.host,
      kind: window.kind,
      label: window.label,
      session: window.session,
      targetId: window.targetId,
      contextId: window.contextId,
      openedAt: window.openedAt,
      url: window.url,
      title: window.title,
      liveViewUrl: this.options.config.host(window.host)?.liveViewUrl ?? null,
      reachable: window.reachable,
      control: { owner: window.control.owner, since: window.control.since },
      handoff: window.handoff,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
