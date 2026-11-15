import { execFile, execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

// The Browser tab end to end against a throwaway fleet browser: the same
// Chrome + Selkies image the fleet runs (flotilla's browser component),
// started on this host for the run and removed afterwards. It streams JPEG so
// the run's headless Chromium, which has no H.264 decoder, can show the live
// view; the fleet's own browsers stream H.264. Needs Docker and agent-browser.

export const meta = {
  name: "fleet-browser-tab",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Fleet browser windows: agent tools open/list/handoff/close real windows in a Selkies Chrome, the Explorer Browser tab appears only while windows exist and shows a view-only live stream and thumbnails, Take control and Hand back reach the agent with a summary of what changed, and the tab goes away once the windows are closed.",
};

const execFileAsync = promisify(execFile);
const UI_TIMEOUT_MS = 30_000;
// Pinned like flotilla's browser component.
const CHROMIUM_IMAGE =
  "lscr.io/linuxserver/chromium@sha256:2d32e1b2b28aa92973aa0f58c433c0b045db6e1224d7001eeaa9cde1a474ce13";
const CADDY_IMAGE = "caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";
const BROWSER_NAME = "local";

const state = {
  workspaceId: null,
  agentId: null,
  windows: [],
  failures: [],
  browser: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(predicate, { timeoutMs = 20_000, intervalMs = 300, description }) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function observe(ctx, condition, message) {
  if (condition) return true;
  state.failures.push(message);
  ctx.log(`✗ ${message}`);
  return false;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Starts the throwaway browser; it is removed when the runner exits, pass or fail. */
async function startLocalBrowser(ctx) {
  const dir = path.join(ctx.stack.runDir, "fleet-browser-local");
  const project = `paseo-verify-fb-${ctx.stack.runId}`.toLowerCase();
  const [viewPort, cdpPort] = [await freePort(), await freePort()];
  await fsp.mkdir(path.join(dir, "config"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, "Caddyfile"),
    "{\n\tadmin off\n\tauto_https off\n}\n\n:9223 {\n\treverse_proxy 127.0.0.1:9222\n}\n",
  );
  await fsp.writeFile(
    path.join(dir, "docker-compose.yml"),
    `services:
  chrome:
    image: ${CHROMIUM_IMAGE}
    hostname: verify-chrome
    security_opt:
      - seccomp:unconfined
    environment:
      PUID: "${process.getuid()}"
      PGID: "${process.getgid()}"
      TZ: Asia/Kolkata
      RESTART_APP: "true"
      SELKIES_ENCODER: jpeg
      # A fixed desktop, like the fleet's (flotilla's browser component).
      SELKIES_MANUAL_WIDTH: "1440"
      SELKIES_MANUAL_HEIGHT: "900"
      SELKIES_SCALING_DPI: "96"
      CHROME_CLI: >-
        --user-data-dir=/config/profile
        --remote-debugging-port=9222
        --lang=en-US
        --no-first-run
        --hide-crash-restore-bubble
        --disable-background-timer-throttling
        --disable-renderer-backgrounding
        --disable-backgrounding-occluded-windows
    volumes:
      - ./config:/config
    ports:
      - "127.0.0.1:${viewPort}:3000"
      - "127.0.0.1:${cdpPort}:9223"
    shm_size: "1gb"
    mem_limit: 3g
  cdp-proxy:
    image: ${CADDY_IMAGE}
    network_mode: "service:chrome"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    depends_on:
      - chrome
`,
  );
  const compose = ["compose", "-p", project, "-f", path.join(dir, "docker-compose.yml")];
  // By project name only: the stack teardown deletes the run directory, compose file
  // included, before the runner exits.
  process.once("exit", () => {
    try {
      execFileSync("docker", ["compose", "-p", project, "down", "--volumes", "--remove-orphans"], {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      // Best effort; `docker compose -p <project> down` removes a leftover by hand.
    }
  });
  await execFileAsync("docker", [...compose, "up", "-d"], { timeout: 300_000 });
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const liveViewUrl = `http://127.0.0.1:${viewPort}`;
  await pollUntil(
    async () => {
      const response = await fetch(`${cdpUrl}/json/version`, {
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok && (await response.json()).webSocketDebuggerUrl;
    },
    {
      timeoutMs: 180_000,
      intervalMs: 1_000,
      description: "Chrome DevTools in the throwaway browser",
    },
  );
  await pollUntil(
    async () => (await fetch(liveViewUrl, { signal: AbortSignal.timeout(3_000) })).ok,
    { timeoutMs: 60_000, intervalMs: 1_000, description: "the Selkies live view" },
  );
  return { cdpUrl, liveViewUrl };
}

async function pageTargets() {
  const response = await fetch(`${state.browser.cdpUrl}/json/list`);
  return (await response.json()).filter((target) => target.type === "page");
}

/** Calls a Paseo MCP tool as the agent, through the endpoint the daemon injects into agents. */
async function mcp(ctx, method, params) {
  const url = new URL("/mcp/agents", ctx.host().httpUrl);
  url.searchParams.set("callerAgentId", state.agentId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(ctx.password ? { authorization: `Bearer ${ctx.password}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  ctx.expect(response.ok, `MCP ${method} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  const dataLine = text.split("\n").findLast((line) => line.startsWith("data:"));
  const message = JSON.parse(dataLine ? dataLine.slice("data:".length) : text);
  ctx.expect(!message.error, `MCP ${method} error: ${JSON.stringify(message.error)}`);
  return message.result;
}

async function callAgentTool(ctx, name, args) {
  const result = await mcp(ctx, "tools/call", { name, arguments: args });
  ctx.expect(result?.isError !== true, `MCP ${name} tool error: ${JSON.stringify(result)}`);
  return result?.structuredContent ?? {};
}

async function fleetBrowser(ctx, type, params) {
  const payload = await ctx.host().client.fleetBrowserRequest(type, params);
  if (payload.error !== null) throw new Error(`${type} failed: ${payload.error}`);
  return payload;
}

async function listWindows(ctx) {
  return (
    await fleetBrowser(ctx, "fleet_browser.windows.list.request", {
      workspaceId: state.workspaceId,
    })
  ).windows;
}

async function timelineText(ctx) {
  const timeline = await ctx.host().client.fetchAgentTimeline(state.agentId, { limit: 200 });
  return JSON.stringify(timeline.entries ?? []);
}

/** Share of bright pixels in an element: the stream of a white web page is mostly bright. */
async function brightShare(page, locator) {
  const png = await locator.screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let bright = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] + data[index + 1] + data[index + 2] > 600) bright++;
    }
    return bright / (data.length / 4);
  }, png.toString("base64"));
}

function workspaceUrl(ctx) {
  const host = ctx.host();
  return `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(state.workspaceId)}?open=agent:${encodeURIComponent(state.agentId)}`;
}

const browserTab = (page) => page.getByTestId("workspace-tab-fleet_browser");

export const steps = [
  {
    id: "browser",
    label: "A throwaway fleet browser (Chrome + Selkies) is running for this run",
    narrate: "The same browser image the fleet runs, started just for this check.",
    async run(ctx) {
      state.browser = await startLocalBrowser(ctx);
      await fsp.writeFile(
        path.join(ctx.host().home, "fleet-browser.json"),
        JSON.stringify({
          hosts: {
            [BROWSER_NAME]: {
              cdpUrl: state.browser.cdpUrl,
              liveViewUrl: state.browser.liveViewUrl,
              purpose: "verification",
            },
          },
        }),
      );
      return `CDP ${state.browser.cdpUrl}, live view ${state.browser.liveViewUrl}`;
    },
  },
  {
    id: "seed",
    label: "A workspace with an agent that is offered the fleet_browser tools",
    narrate: "The daemon picks up fleet-browser.json and offers the agent four tools.",
    async run(ctx) {
      const client = ctx.host().client;
      const dir = await fsp.mkdtemp(path.join(ctx.host().home, "fleet-browser-ws-"));
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: dir },
        title: `Fleet browser [${ctx.stack.runId}]`,
      });
      state.workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(state.workspaceId), "workspace created");
      const agent = await client.createAgent({
        provider: "mock",
        model: "e2e-fast-stream",
        cwd: dir,
        workspaceId: state.workspaceId,
        title: `Browser agent [${ctx.stack.runId}]`,
        initialPrompt: "Fleet browser verification; finish quickly.",
      });
      state.agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 30_000);
      const features = client.getLastServerInfoMessage()?.features ?? {};
      ctx.expect(features.fleetBrowser === true, "server_info advertises fleetBrowser");
      const names = await pollUntil(
        async () => {
          const result = await mcp(ctx, "tools/list", {});
          const tools = (result?.tools ?? []).map((tool) => tool.name);
          return tools.includes("fleet_browser_open") ? tools : null;
        },
        { timeoutMs: 15_000, description: "fleet_browser_open in the agent's tools" },
      );
      const fleetTools = names.filter((name) => name.startsWith("fleet_browser_"));
      ctx.expect(fleetTools.length === 4, `four fleet_browser tools, got ${fleetTools.join(", ")}`);
      return `agent ${state.agentId}; tools ${fleetTools.join(", ")}`;
    },
  },
  {
    id: "no-tab-without-windows",
    label: "Without windows, the Explorer has no Browser tab",
    narrate: "Files and Changes only: the Browser tab waits for a window.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(workspaceUrl(ctx), { waitUntil: "domcontentloaded", timeout: UI_TIMEOUT_MS });
      const toggle = page.getByTestId("workspace-explorer-toggle").first();
      await toggle.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await toggle.click();
      await page.getByTestId("workspace-tab-files").first().waitFor({ timeout: UI_TIMEOUT_MS });
      await page.waitForTimeout(1_500);
      ctx.expect((await browserTab(page).count()) === 0, "no Browser tab before any window opens");
      await ctx.shot("before");
      return "Explorer open with Files and Changes only";
    },
  },
  {
    id: "agent-opens-window",
    label: "The agent opens a fresh window and drives it; the Browser tab streams it view-only",
    narrate:
      "fleet_browser_open creates the window and binds the session; the Browser tab appears with the live view.",
    async run(ctx) {
      const opened = await callAgentTool(ctx, "fleet_browser_open", {
        host: BROWSER_NAME,
        kind: "fresh",
        label: "Checkout test",
        url: "https://example.com",
      });
      ctx.expect(
        typeof opened.windowId === "string",
        `windowId returned: ${JSON.stringify(opened)}`,
      );
      state.windows.push(opened);
      const { stdout } = await execFileAsync("agent-browser", [
        "--session",
        opened.session,
        "get",
        "title",
      ]);
      ctx.expect(
        stdout.includes("Example Domain"),
        `agent-browser drives the window: ${stdout.trim()}`,
      );
      const page = ctx.page;
      await browserTab(page).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await browserTab(page).first().click();
      const detail = page.getByTestId("fleet-browser-detail");
      await detail.getByText("Checkout test").first().waitFor({ timeout: UI_TIMEOUT_MS });
      const status = await page.getByTestId("fleet-browser-status").first().textContent();
      observe(ctx, /Agent driving/.test(status ?? ""), `status badge reads ${status}`);
      const frame = page.locator('iframe[data-testid="fleet-browser-watch-frame"]');
      await frame.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      const src = await frame.getAttribute("src");
      observe(
        ctx,
        src === `${state.browser.liveViewUrl}/#shared`,
        `watch frame is view-only: ${src}`,
      );
      const liveView = page.getByTestId("fleet-browser-live-view");
      const share = await pollUntil(
        async () => {
          const value = await brightShare(page, liveView);
          return value > 0.4 ? value : null;
        },
        { timeoutMs: 45_000, intervalMs: 1_500, description: "the live stream to paint the page" },
      );
      await ctx.shot("watching");
      return `window ${opened.windowId}; stream ${(share * 100).toFixed(0)}% bright`;
    },
  },
  {
    id: "second-window",
    label: "A second window shows a strip of both windows with thumbnails",
    narrate: "Two windows: cards with thumbnails, and selecting one shows it.",
    async run(ctx) {
      const opened = await callAgentTool(ctx, "fleet_browser_open", {
        host: BROWSER_NAME,
        kind: "fresh",
        label: "Docs lookup",
        url: "https://example.org",
      });
      state.windows.push(opened);
      const page = ctx.page;
      for (const window of state.windows) {
        await page.getByTestId(`fleet-browser-card-${window.windowId}`).waitFor({
          timeout: UI_TIMEOUT_MS,
        });
      }
      const thumbnails = await pollUntil(
        async () => {
          const count = await page.locator('[data-testid^="fleet-browser-card-"] img').count();
          return count >= 2 ? count : null;
        },
        { timeoutMs: 20_000, description: "both thumbnails" },
      );
      await page.getByTestId(`fleet-browser-card-${opened.windowId}`).click();
      await page.getByTestId("fleet-browser-detail").getByText("Docs lookup").first().waitFor({
        timeout: UI_TIMEOUT_MS,
      });
      const raised = await pollUntil(
        async () => {
          const targets = await pageTargets();
          return targets[0]?.id === opened.targetId ? targets[0].url : null;
        },
        { timeoutMs: 10_000, description: "the selected window raised" },
      ).catch(() => null);
      await page.waitForTimeout(3_000);
      await ctx.shot("two-windows");
      return `${thumbnails} thumbnails; raised ${raised ?? "(target order not reported)"}`;
    },
  },
  {
    id: "take-control",
    label: "Take control opens the full live view with input; the idle agent is not interrupted",
    narrate: "Taking control switches to the controller view; the window is now the user's.",
    async run(ctx) {
      const page = ctx.page;
      await page.getByTestId(`fleet-browser-card-${state.windows[0].windowId}`).click();
      await page.getByTestId("fleet-browser-take-control").click();
      await page.getByTestId("fleet-browser-overlay").waitFor({
        state: "visible",
        timeout: UI_TIMEOUT_MS,
      });
      const frame = page.locator('iframe[data-testid="fleet-browser-control-frame"]');
      await frame.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      const src = await frame.getAttribute("src");
      observe(ctx, src === `${state.browser.liveViewUrl}/`, `control frame takes input: ${src}`);
      const window = await pollUntil(
        async () =>
          (await listWindows(ctx)).find(
            (item) => item.id === state.windows[0].windowId && item.control.owner === "user",
          ),
        { description: "control owner user" },
      );
      const text = await timelineText(ctx);
      observe(ctx, !text.includes("Browser takeover"), "an idle agent got no takeover notice");
      await page.waitForTimeout(6_000);
      await ctx.shot("control");
      return `owner ${window.control.owner}`;
    },
  },
  {
    id: "hand-back",
    label: "Hand back with a note resumes the agent with what changed",
    narrate:
      "The agent gets a Browser resume message with the page before and after, and the note.",
    async run(ctx) {
      // The user moves the page while in control.
      await execFileAsync("agent-browser", [
        "--session",
        state.windows[0].session,
        "open",
        "https://www.iana.org/help/example-domains",
      ]);
      const page = ctx.page;
      const note = page.getByTestId("fleet-browser-overlay-note");
      await note.click();
      await note.fill("Moved to the IANA page");
      await page.getByTestId("fleet-browser-overlay-hand-back").click();
      await page
        .getByTestId("fleet-browser-overlay")
        .waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      const text = await pollUntil(
        async () => {
          const timeline = await timelineText(ctx);
          return timeline.includes("Browser resume") ? timeline : null;
        },
        { timeoutMs: 30_000, description: "Browser resume in the agent timeline" },
      );
      observe(ctx, text.includes("Before: https://example.com/"), "resume names the page before");
      observe(ctx, text.includes("iana.org"), "resume names the page now");
      observe(ctx, text.includes("Moved to the IANA page"), "resume carries the note");
      const window = (await listWindows(ctx)).find((item) => item.id === state.windows[0].windowId);
      ctx.expect(window?.control.owner === "agent", "control is back with the agent");
      await page.waitForTimeout(1_000);
      await ctx.shot("handed-back");
      return "resume delivered with before/after and the note";
    },
  },
  {
    id: "handoff",
    label: "A hand-off request shows in the Browser tab",
    narrate: "The agent asks for help; the tab shows the reason and Take control.",
    async run(ctx) {
      await callAgentTool(ctx, "fleet_browser_handoff", {
        windowId: state.windows[1].windowId,
        reason: "Solve the captcha on the docs site",
      });
      const page = ctx.page;
      await page.getByTestId(`fleet-browser-card-${state.windows[1].windowId}`).click();
      const alert = page.getByTestId("fleet-browser-handoff");
      await alert.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      observe(
        ctx,
        (await alert.textContent())?.includes("Solve the captcha on the docs site") === true,
        "hand-off alert shows the reason",
      );
      await page.waitForTimeout(2_000);
      await ctx.shot("handoff");
      return "hand-off visible";
    },
  },
  {
    id: "phone",
    label: "At phone width the Browser tab renders in the Explorer overlay",
    narrate: "On a phone-sized screen, the same tab and live view show in the Explorer overlay.",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(1_500);
      const panel = page.getByTestId("fleet-browser-panel").first();
      if (!(await panel.isVisible().catch(() => false))) {
        await page.getByTestId("workspace-explorer-toggle").first().click();
      }
      await panel.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForTimeout(4_000);
      await ctx.shot("phone");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(1_500);
      return "phone layout rendered";
    },
  },
  {
    id: "close",
    label: "Closing every window removes the Browser tab once the user moves off it",
    narrate: "The agent closes its windows; the tab empties, and goes away when Files is picked.",
    async run(ctx) {
      for (const window of state.windows) {
        await callAgentTool(ctx, "fleet_browser_close", { windowId: window.windowId });
      }
      const page = ctx.page;
      await page.getByTestId("fleet-browser-empty").waitFor({
        state: "visible",
        timeout: UI_TIMEOUT_MS,
      });
      await page.getByTestId("workspace-tab-files").first().click();
      await pollUntil(async () => (await browserTab(page).count()) === 0, {
        timeoutMs: 10_000,
        description: "Browser tab removed",
      });
      const remaining = new Set((await pageTargets()).map((target) => target.id));
      for (const window of state.windows) {
        observe(ctx, !remaining.has(window.targetId), `window ${window.windowId} closed in Chrome`);
      }
      await ctx.shot("after");
      ctx.expect(state.failures.length === 0, `failures: ${state.failures.join("; ")}`);
      return "windows closed, tab gone";
    },
  },
];
