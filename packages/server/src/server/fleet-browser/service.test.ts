import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { FleetBrowserDelivery } from "@getpaseo/protocol/fleet-browser/types";
import { FleetBrowserConfig } from "./config.js";
import { FleetBrowserService, FleetBrowserError } from "./service.js";
import { FleetBrowserStore, type StoredWindow } from "./store.js";

/** A browser that answers the few target commands the service sends. */
class FakeBrowser {
  public readonly targets = new Map<string, { url: string; title: string }>();
  public readonly activated: string[] = [];
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;

  public async start(): Promise<string> {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params: { targetId?: string };
        };
        socket.send(
          JSON.stringify({ id: message.id, ...this.answer(message.method, message.params) }),
        );
      });
    });
    this.server = createServer((request, response) => {
      const { port } = this.server!.address() as AddressInfo;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }),
      );
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.wss!.handleUpgrade(request, socket, head, (ws) =>
        this.wss!.emit("connection", ws, request),
      );
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.listen(0, "127.0.0.1", resolve);
    await promise;
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public async stop(): Promise<void> {
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server?.close(() => resolve());
    await promise;
  }

  private answer(method: string, params: { targetId?: string }): Record<string, unknown> {
    const target = params.targetId ? this.targets.get(params.targetId) : undefined;
    switch (method) {
      case "Target.getTargets":
        return {
          result: {
            targetInfos: [...this.targets].map(([targetId, page]) => ({
              targetId,
              type: "page",
              url: page.url,
              title: page.title,
            })),
          },
        };
      case "Target.getTargetInfo":
        return target
          ? { result: { targetInfo: { targetId: params.targetId, ...target } } }
          : { error: { message: "No target with given id found" } };
      case "Target.activateTarget":
        this.activated.push(params.targetId ?? "");
        return { result: {} };
      case "Target.closeTarget":
        this.targets.delete(params.targetId ?? "");
        return { result: { success: true } };
      default:
        return { error: { message: `unsupported ${method}` } };
    }
  }
}

interface Delivered {
  agentId: string;
  text: string;
}

describe("FleetBrowserService", () => {
  let home: string;
  let browser: FakeBrowser;
  let delivered: Delivered[];
  let running: boolean;
  let service: FleetBrowserService;
  let store: FleetBrowserStore;

  function window(overrides: Partial<StoredWindow> = {}): StoredWindow {
    return {
      id: "bw_1",
      agentId: "agent-a",
      host: "prod",
      kind: "shared",
      label: "Instagram login",
      session: "fb-1",
      targetId: "T1",
      contextId: null,
      openedAt: "2026-11-15T10:00:00.000Z",
      url: "https://example.com/login",
      title: "Login",
      reachable: true,
      control: {
        owner: "agent",
        since: "2026-11-15T10:00:00.000Z",
        agentNotified: false,
        startUrl: null,
        startTitle: null,
      },
      handoff: null,
      ...overrides,
    };
  }

  async function createService(cdpUrl: string): Promise<void> {
    await writeFile(
      path.join(home, "fleet-browser.json"),
      JSON.stringify({ hosts: { prod: { cdpUrl, liveViewUrl: "https://prod.chrome.example" } } }),
    );
    const logger = pino({ level: "silent" });
    const config = new FleetBrowserConfig(home, logger);
    await config.load();
    store = await FleetBrowserStore.open(home, logger);
    service = new FleetBrowserService({
      config,
      store,
      logger,
      agents: {
        workspaceIdOf: async (agentId) => (agentId === "agent-a" ? "ws-1" : "ws-2"),
        isRunning: () => running,
        deliver: async (agentId, text): Promise<FleetBrowserDelivery> => {
          delivered.push({ agentId, text });
          return running ? "steered" : "turn_started";
        },
      },
    });
  }

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "fleet-browser-test-"));
    browser = new FakeBrowser();
    browser.targets.set("T1", { url: "https://example.com/login", title: "Login" });
    delivered = [];
    running = false;
    await createService(await browser.start());
  });

  afterEach(async () => {
    service.stop();
    await browser.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("does not interrupt an idle agent on take-over, and resume tells it what changed", async () => {
    await store.put(window());
    const take = await service.control("bw_1", "take", null);
    expect(take.delivery).toBe("none");
    expect(take.window?.control.owner).toBe("user");
    expect(browser.activated).toEqual(["T1"]);

    browser.targets.set("T1", { url: "https://example.com/feed", title: "Feed" });
    const resume = await service.control("bw_1", "resume", "logged in, 2FA done");
    expect(resume.delivery).toBe("turn_started");
    expect(resume.window?.control.owner).toBe("agent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain("Before: https://example.com/login");
    expect(delivered[0].text).toContain("Now: https://example.com/feed");
    expect(delivered[0].text).toContain("Note from the user: logged in, 2FA done");
  });

  it("tells a running agent to pause, and tells it again when control comes back quietly", async () => {
    running = true;
    await store.put(
      window({ handoff: { reason: "captcha", requestedAt: "2026-11-15T10:01:00.000Z" } }),
    );
    const take = await service.control("bw_1", "take", null);
    expect(take.delivery).toBe("steered");
    expect(delivered[0].text).toContain("Browser takeover");

    const release = await service.control("bw_1", "release", null);
    expect(release.delivery).toBe("steered");
    expect(release.window?.handoff).toBeNull();
    expect(delivered[1].text).toContain("Browser control returned");
  });

  it("keeps windows while their browser is down and forgets windows that were closed", async () => {
    await store.put(window());
    await store.put(window({ id: "bw_2", targetId: "T2", session: "fb-2" }));
    await service.refresh();
    expect((await service.listForWorkspace("ws-1")).map((item) => item.id)).toEqual(["bw_1"]);

    await browser.stop();
    await service.refresh();
    const [down] = await service.listForWorkspace("ws-1");
    expect(down.reachable).toBe(false);
  });

  it("lets an agent close only its own windows, and not while the user has control", async () => {
    await store.put(window());
    await expect(service.close("bw_1", "agent-b")).rejects.toBeInstanceOf(FleetBrowserError);
    await service.control("bw_1", "take", null);
    await expect(service.close("bw_1", "agent-a")).rejects.toThrow(/user has control/);
    await service.control("bw_1", "release", null);
    expect(await service.close("bw_1", "agent-a")).toBe(true);
    expect(browser.targets.has("T1")).toBe(false);
    expect(await service.listForWorkspace("ws-1")).toEqual([]);
  });
});
