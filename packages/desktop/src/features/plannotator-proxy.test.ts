import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannotatorProxyManager } from "./plannotator-proxy.js";

const servers: Server[] = [];
const managers: PlannotatorProxyManager[] = [];
const temporaryDirectories: string[] = [];
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No TCP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function createRecordingServer(receivedBodies: string[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
}

async function createManager(input: {
  html?: string;
  onSubmitted?: (browserId: string) => void;
  loadError?: Error;
}): Promise<PlannotatorProxyManager> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "paseo-plannotator-proxy-test-"));
  temporaryDirectories.push(cacheDirectory);
  const manager = new PlannotatorProxyManager({
    cacheDirectory,
    logger,
    loadUiHtml: async () => {
      if (input.loadError) {
        throw input.loadError;
      }
      return Buffer.from(input.html ?? "<html>local UI</html>");
    },
    onSubmitted: input.onSubmitted,
  });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  logger.info.mockClear();
  logger.warn.mockClear();
});

describe("PlannotatorProxyManager", () => {
  it("serves the UI locally with immediate-close and neutral-theme cookies", async () => {
    const remoteUrl = await listen(
      createServer((_request, response) => {
        response.end("remote UI");
      }),
    );
    const manager = await createManager({ html: "<html>cached UI</html>" });

    const opened = await manager.openSession({ browserId: "browser-1", remoteUrl });
    const response = await fetch(opened.url);

    expect(opened.accelerated).toBe(true);
    expect(await response.text()).toBe("<html>cached UI</html>");
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("plannotator-auto-close=0"),
        expect.stringContaining("plannotator-color-theme=neutral"),
        expect.stringContaining("plannotator-theme=system"),
        expect.stringContaining("plannotator-grid-enabled=false"),
      ]),
    );
  });

  it("proxies API requests and reports accepted submissions", async () => {
    const receivedBodies: string[] = [];
    const remoteUrl = await listen(createRecordingServer(receivedBodies));
    const onSubmitted = vi.fn();
    const manager = await createManager({ onSubmitted });
    const opened = await manager.openSession({ browserId: "browser-2", remoteUrl });

    const response = await fetch(new URL("/api/deny", opened.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "Revise this" }),
    });
    await response.text();

    expect(receivedBodies).toEqual([JSON.stringify({ feedback: "Revise this" })]);
    expect(onSubmitted).toHaveBeenCalledWith("browser-2");
  });

  it("falls back to the remote UI when the local cache is unavailable", async () => {
    const manager = await createManager({ loadError: new Error("missing binary") });

    await expect(
      manager.openSession({
        browserId: "browser-3",
        remoteUrl: "http://blrofc3:19432",
      }),
    ).resolves.toEqual({
      url: "http://blrofc3:19432/",
      accelerated: false,
    });
  });
});
