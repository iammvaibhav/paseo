import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  name: "show-page-viewer",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "show_page in the real viewer: a page that renders Mermaid from a CDN at load works even when it arrives under a hidden (display:none) chat; the full-size viewer hides the app behind it on the glass theme, clears the macOS traffic lights, keeps title, close button and page apart (desktop, web, phone width), and closes on Escape with focus inside the page, while a page that handles Escape itself keeps the viewer open and Escape in an inline page stays with the page.",
};

const UI_TIMEOUT_MS = 30_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const MERMAID_TITLE = "Runtime Mermaid";
const LATE_TITLE = "Late Mermaid";
const ESCAPE_TITLE = "Escape probe";
// DESKTOP_TRAFFIC_LIGHT_WIDTH in packages/app/src/constants/layout.ts.
const TRAFFIC_LIGHT_WIDTH = 78;
// Edge energy (p99 of neighbouring-pixel luminance steps) at or above which text behind the
// backdrop is still legible. The glass cover's 6% leak measures 3 over the chat's text;
// blurred or opaque, about 1.
const READABLE_EDGE_P99 = 2;

// The pattern agents use: Mermaid's ESM build from jsDelivr, diagram sources in a JS object,
// unicode labels, every diagram rendered once at load, two of three in hidden tabs.
function mermaidPage(marker) {
  return `<!-- ${marker} -->
<style>
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; }
  .panel { display: none; }
  .panel.active { display: block; }
</style>
<p class="p-muted">Mobile links in three steps · rendered by Mermaid at load</p>
<div class="tabs">
  <button class="tab" data-tab="flow" aria-pressed="true">1 · Flow</button>
  <button class="tab" data-tab="sequence" aria-pressed="false">2 · Sequence</button>
  <button class="tab" data-tab="fixed" aria-pressed="false">3 · Fixed</button>
</div>
<section class="panel active" data-panel="flow"><div class="p-card" data-mermaid="flow"></div></section>
<section class="panel" data-panel="sequence"><div class="p-card" data-mermaid="sequence"></div></section>
<section class="panel" data-panel="fixed"><div class="p-card" data-mermaid="fixed"></div></section>
<script type="module">
  const diagrams = {
    flow: \`flowchart TB
  L["SMS link ?mt=expiry·scope·signature"] --> F["Frontend: token moved<br/>before analytics start"]
  F --> T{{"valid token: signature, expiry, scope"}}
  T -->|"unscoped or tampered"| D["Invalid token"]
  T -->|"valid"| O["object returned & logged"]\`,
    sequence: \`sequenceDiagram
  autonumber
  participant P as Portal backend
  participant G as Guard's phone
  Note over P: signed URL<br/>mt = expiry + HMAC(expiry)
  P->>G: link …/HASH/2?mt=6ae3…
  G->>P: POST /api/graphql with X-Mobile-Token
  P-->>G: data, no other check\`,
    fixed: \`sequenceDiagram
  actor A as Attacker
  participant API as Portal GraphQL
  A->>API: contact(id: 2) with a token for contact 1
  API-->>A: Unauthorized · the token names contact 1\`,
  };
  const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs");
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "strict",
    fontFamily: getComputedStyle(document.body).fontFamily,
  });
  let rendered = 0;
  for (const element of document.querySelectorAll("[data-mermaid]")) {
    const name = element.dataset.mermaid;
    try {
      const { svg } = await mermaid.render("m-" + name, diagrams[name]);
      element.innerHTML = svg;
      rendered += 1;
    } catch (error) {
      element.textContent = "Diagram failed to render: " + error.message;
    }
  }
  document.body.dataset.mermaid = rendered + "/" + Object.keys(diagrams).length;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tab")) other.setAttribute("aria-pressed", String(other === tab));
      for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab);
    });
  }
</script>`;
}

// One field the page leaves alone, one whose Escape the page consumes (preventDefault).
const ESCAPE_PAGE = `<div class="p-card">
  <p>Escape probe</p>
  <div class="p-row">
    <label>Search <input id="probe" placeholder="Esc here"></label>
    <label>Clears itself <input id="consume" placeholder="Esc is handled"></label>
  </div>
  <p class="p-muted">Seen by the page: <b id="seen">0</b> · handled by the page: <b id="handled">0</b></p>
</div>
<script>
  let seen = 0;
  let handled = 0;
  document.getElementById("probe").addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.getElementById("seen").textContent = String(++seen);
  });
  document.getElementById("consume").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    document.getElementById("handled").textContent = String(++handled);
  });
</script>`;

// Readable text behind the full-size viewer: the backdrop check measures through it.
const LONG_REPLY = Array.from(
  { length: 40 },
  (_, index) =>
    `- Line ${index + 1}: host blrofc3 reconnected, deploy-check passed, archive workspace queued.`,
).join("\n");

const state = {
  calls: {},
  failures: [],
  workspaceId: null,
  agentId: null,
  lateWorkspaceId: null,
  lateAgentId: null,
};

/** Records a failed expectation and keeps going, so one red run shows every bug. */
function observe(ctx, condition, message) {
  if (condition) return true;
  state.failures.push(message);
  ctx.log(`✗ ${message}`);
  return false;
}

async function publishPage(ctx, dir, fileName, title, html) {
  const serverDist = path.join(repoRoot, "packages/server/dist/server/server/page-tools");
  const { registerPageTools } = await import(path.join(serverDist, "tools.js"));
  const { PageStore } = await import(path.join(serverDist, "page-store.js"));
  await fsp.writeFile(path.join(dir, fileName), html);
  const handlers = new Map();
  registerPageTools({
    registerTool: (name, _config, handler) => handlers.set(name, handler),
    previewBrowser: { capture: async () => ({ kind: "failed", message: "unused" }) },
    pageStore: new PageStore(ctx.host().home),
    resolveCallerCwd: () => dir,
  });
  const result = await handlers.get("show_page")({ title, path: fileName });
  ctx.expect(!result.isError, `show_page failed: ${JSON.stringify(result.content)}`);
  return { input: { title, path: fileName }, output: { content: result.content } };
}

function showPageCall(callId, call) {
  return {
    type: "tool_call",
    callId,
    name: "show_page",
    status: "completed",
    error: null,
    detail: { type: "unknown", ...call },
  };
}

async function seedAgent(ctx, { dir, title, prompt, turns }) {
  const client = ctx.host().client;
  const workspace = await client.createWorkspace({
    source: { kind: "directory", path: dir },
    title,
  });
  const workspaceId = workspace.workspace?.id;
  ctx.expect(Boolean(workspaceId), `workspace ${title} must have an id`);
  const agent = await client.createAgent({
    provider: "mock",
    cwd: dir,
    workspaceId,
    title,
    modeId: "load-test",
    model: "e2e-fast-stream",
    initialPrompt: prompt,
    featureValues: { mockTimelineTurns: turns },
  });
  await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
  return { workspaceId, agentId: agent.id };
}

function workspaceUrl(ctx, workspaceId, agentId) {
  const host = ctx.host();
  return `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(workspaceId)}?open=agent:${encodeURIComponent(agentId)}`;
}

async function clickWorkspaceRow(page, workspaceId) {
  const row = page.locator(
    `[data-testid^="sidebar-workspace-row-"][data-testid$=":${workspaceId}"]`,
  );
  await row.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await row.click();
}

const inlineFrame = (title) => `iframe[data-testid="show-page-frame"][title="${title}"]`;
// The full-size frame carries the same title; it is the one that is not inline.
const fullSizeFrame = (title) => `iframe[title="${title}"]:not([data-testid="show-page-frame"])`;

/** The Mermaid outcome inside a frame: "rendered/total", failed containers, leftover error SVGs. */
async function waitForMermaid(page, selector) {
  const body = page.frameLocator(selector).locator("body[data-mermaid]");
  await body.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
  return body.evaluate((element) => ({
    state: element.dataset.mermaid,
    failed: [...element.querySelectorAll("[data-mermaid]")]
      .filter((container) => !container.querySelector("svg"))
      .map((container) => `${container.dataset.mermaid}: ${container.textContent.slice(0, 100)}`),
    errorSvgs: [...element.children].filter((node) => /Syntax error in text/.test(node.textContent))
      .length,
  }));
}

function showPageCard(page, title) {
  return page.locator('[data-testid="show-page-card"]').filter({ hasText: title }).first();
}

/** Scrolls a page card into view and waits until its inline page has loaded. */
async function showCard(page, title) {
  const card = showPageCard(page, title);
  // After a reload the chat list remounts rows while it settles; retry a detached row.
  for (let attempt = 0; ; attempt++) {
    try {
      await card.scrollIntoViewIfNeeded();
      await page
        .frameLocator(inlineFrame(title))
        .locator("body > *")
        .first()
        .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      // The chat settles its scroll position after rows grow; act once it stops moving.
      await page.waitForTimeout(500);
      await card.scrollIntoViewIfNeeded();
      return card;
    } catch (error) {
      if (attempt >= 3 || !/not attached/.test(String(error))) throw error;
      await page.waitForTimeout(500);
    }
  }
}

async function openFullSize(page, title) {
  const card = await showCard(page, title);
  await card.getByTestId("show-page-full-size").click();
  const close = page.getByTestId("show-page-full-size-close");
  await close.waitFor({ state: "visible", timeout: 5_000 });
  // Let the fade-in finish before measuring pixels.
  await page.waitForTimeout(800);
  return close;
}

async function closeFullSize(page) {
  const close = page.getByTestId("show-page-full-size-close");
  if ((await close.count()) === 0) return;
  await close.click();
  await close.waitFor({ state: "detached", timeout: 5_000 });
}

async function isFullSizeOpen(page, waitMs) {
  await page.waitForTimeout(waitMs);
  return (await page.getByTestId("show-page-full-size-close").count()) > 0;
}

/** Edge energy of a screen region: high when text behind the viewer is still legible. */
async function regionEdgeP99(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
    const luminance = (index) =>
      0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    const steps = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width - 1; x++) {
        const index = (y * width + x) * 4;
        steps.push(Math.abs(luminance(index) - luminance(index + 4)));
      }
    }
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length * 0.99)];
  }, png.toString("base64"));
}

/** Header geometry of the open full-size viewer. */
async function readViewerGeometry(page, title) {
  const close = page.getByTestId("show-page-full-size-close");
  const header = close.locator("xpath=..");
  const titleText = header.getByText(title, { exact: true });
  const frame = page.locator(fullSizeFrame(title));
  const [closeBox, headerBox, titleBox, frameBox] = await Promise.all([
    close.boundingBox(),
    header.boundingBox(),
    titleText.boundingBox(),
    frame.boundingBox(),
  ]);
  return { close: closeBox, header: headerBox, title: titleBox, frame: frameBox };
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function checkGeometry(ctx, geometry, viewport, { trafficLights }) {
  const { close, header, title, frame } = geometry;
  if (!observe(ctx, close && header && title && frame, "viewer header parts not found")) return;
  if (trafficLights) {
    observe(
      ctx,
      title.x >= TRAFFIC_LIGHT_WIDTH,
      `title starts at x=${Math.round(title.x)}, under the traffic lights (< ${TRAFFIC_LIGHT_WIDTH})`,
    );
  }
  observe(ctx, !overlaps(title, close), "title overlaps the close button");
  observe(
    ctx,
    frame.y >= header.y + header.height - 1,
    `page top ${Math.round(frame.y)} overlaps the header (bottom ${Math.round(header.y + header.height)})`,
  );
  observe(
    ctx,
    close.x >= 0 && close.x + close.width <= viewport.width && close.y >= 0,
    `close button outside the window: ${JSON.stringify(close)}`,
  );
}

export const steps = [
  {
    id: "publish",
    label: "Publish the Mermaid and Escape pages through the real show_page tool",
    narrate: "Two pages: one renders Mermaid from jsDelivr at load, one probes Escape.",
    async run(ctx) {
      const dir = path.join(ctx.artifactsDir, "show-page-viewer");
      await fsp.mkdir(dir, { recursive: true });
      state.calls.mermaid = await publishPage(
        ctx,
        dir,
        "mermaid.html",
        MERMAID_TITLE,
        mermaidPage("inline"),
      );
      // Different markup, so the store gives it its own id and the client fetches it fresh.
      state.calls.late = await publishPage(ctx, dir, "late.html", LATE_TITLE, mermaidPage("late"));
      state.calls.escape = await publishPage(ctx, dir, "escape.html", ESCAPE_TITLE, ESCAPE_PAGE);
      return Object.values(state.calls)
        .map((call) => call.output.content[0].text.slice(12, 39))
        .join(", ");
    },
  },
  {
    id: "seed",
    label: "Seed an agent that shows both pages, and one that shows a page later",
    narrate: "One agent replies with the pages; the other replies with a page on its second turn.",
    async run(ctx) {
      const seeded = await seedAgent(ctx, {
        dir: ctx.fixtureRepo,
        title: "Show page viewer",
        prompt: "Explain the token flow visually",
        turns: [
          [
            { type: "assistant_message", text: "Here is the flow.", messageId: "spv-intro" },
            showPageCall("spv-mermaid", state.calls.mermaid),
            showPageCall("spv-escape", state.calls.escape),
            { type: "assistant_message", text: LONG_REPLY, messageId: "spv-final" },
          ],
        ],
      });
      state.workspaceId = seeded.workspaceId;
      state.agentId = seeded.agentId;
      const lateDir = path.join(ctx.artifactsDir, "show-page-viewer-late");
      await fsp.mkdir(lateDir, { recursive: true });
      const late = await seedAgent(ctx, {
        dir: lateDir,
        title: "Late page",
        prompt: "Start",
        turns: [
          [{ type: "assistant_message", text: "Working on it.", messageId: "spv-late-1" }],
          [
            showPageCall("spv-late-mermaid", state.calls.late),
            { type: "assistant_message", text: "Late done.", messageId: "spv-late-2" },
          ],
        ],
      });
      state.lateWorkspaceId = late.workspaceId;
      state.lateAgentId = late.agentId;
      return `agent ${state.agentId}; late agent ${state.lateAgentId}`;
    },
  },
  {
    id: "inline-mermaid",
    label: "Desktop shell: the Mermaid page renders inline",
    narrate:
      "The web UI runs as the macOS desktop app on the glass theme. The page renders every diagram.",
    async run(ctx) {
      const page = ctx.page;
      await page.addInitScript(() => {
        if (sessionStorage.getItem("spv-web") === "1") return;
        const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ ...settings, theme: "mono" }));
        // Stands in for the macOS vibrancy material behind the transparent glass window.
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.backgroundColor = "#1e1e1e";
        });
        window.paseoDesktop = {
          platform: "darwin",
          windowChromeMode: "native-mac",
          invoke: async () => ({}),
          getPendingOpenProject: async () => null,
          browser: {
            profilePartition: "persist:paseo-verify",
            registerAttachedBrowser: async () => {},
            unregisterWorkspaceBrowser: async () => {},
            setWorkspaceActiveBrowser: async () => {},
            focus: async () => true,
            executeAutomationCommand: async () => ({}),
            setShortcutPolicy: async () => {},
            clearProfile: async () => {},
            captureElement: async () => null,
            copyElement: async () => false,
            openDevTools: async () => {},
          },
          browserEditor: {
            setInsecureOrigins: async () => ({ restartRequired: false }),
            getInsecureOrigins: async () => [],
          },
          events: { on: () => () => {} },
          window: {
            openNew: async () => {},
            getCurrentWindow: () => ({
              minimize: async () => {},
              close: async () => {},
              toggleMaximize: async () => {},
              isMaximized: async () => false,
              setFullscreen: async () => {},
              isFullscreen: async () => false,
              updateChrome: async () => {},
              onResized: () => () => {},
              setBadgeCount: async () => {},
            }),
          },
          dialog: {},
          notification: {},
          opener: { openUrl: async () => {} },
          editor: { listTargets: async () => [], openTarget: async () => {} },
          webUtils: { getPathForFile: () => "" },
          menu: { showContextMenu: async () => {}, setCapturingShortcut: async () => {} },
          agentNavigation: { ready: async () => null },
        };
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(workspaceUrl(ctx, state.workspaceId, state.agentId), {
        waitUntil: "domcontentloaded",
        timeout: UI_TIMEOUT_MS,
      });
      await showPageCard(page, MERMAID_TITLE).scrollIntoViewIfNeeded();
      const result = await waitForMermaid(page, inlineFrame(MERMAID_TITLE));
      await ctx.shot("before");
      ctx.expect(result.state === "3/3", `inline render ${JSON.stringify(result)}`);
      return `rendered ${result.state}`;
    },
  },
  {
    id: "hidden-load",
    label: "A Mermaid page that arrives under a hidden (display:none) chat renders once shown",
    narrate:
      "The chat is hidden when the agent replies with the page. Shown again, every diagram renders.",
    async run(ctx) {
      const page = ctx.page;
      await clickWorkspaceRow(page, state.lateWorkspaceId);
      await page.getByText("Working on it.", { exact: true }).first().waitFor({
        timeout: UI_TIMEOUT_MS,
      });
      // Hide the live chat the way a hidden panel or route does, then let the page arrive.
      const scroller = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      const hidden = await scroller.elementHandle();
      await hidden.evaluate((element) => {
        element.style.display = "none";
      });
      const client = ctx.host().client;
      await client.sendAgentMessage(state.lateAgentId, "Show the page");
      await client.waitForAgentUpsert(state.lateAgentId, (s) => s.status === "idle", 20_000);
      await page.locator(inlineFrame(LATE_TITLE)).waitFor({
        state: "attached",
        timeout: UI_TIMEOUT_MS,
      });
      // Long enough for the CDN import and the render to finish while hidden.
      await page.waitForTimeout(8_000);
      await hidden.evaluate((element) => {
        element.style.display = "";
      });
      await showPageCard(page, LATE_TITLE).scrollIntoViewIfNeeded();
      const result = await waitForMermaid(page, inlineFrame(LATE_TITLE));
      await page.waitForTimeout(500);
      await ctx.shot("hidden-load");
      observe(
        ctx,
        result.state === "3/3" && result.errorSvgs === 0,
        `page loaded under a hidden chat rendered ${result.state} with ${result.errorSvgs} "Syntax error in text" SVGs: ${result.failed.join(" | ")}`,
      );
      return JSON.stringify(result);
    },
  },
  {
    id: "inline-escape",
    label: "Escape inside an inline page stays with the page",
    narrate: "Escape in the inline page reaches the page's own handler and nothing else reacts.",
    async run(ctx) {
      const page = ctx.page;
      await clickWorkspaceRow(page, state.workspaceId);
      await showCard(page, ESCAPE_TITLE);
      const frame = page.frameLocator(inlineFrame(ESCAPE_TITLE));
      const loadedAt = () => frame.locator("body").evaluate(() => performance.timeOrigin);
      const firstLoad = await loadedAt();
      await page.waitForTimeout(1_000);
      observe(ctx, (await loadedAt()) === firstLoad, "the inline page loaded more than once");
      await frame.locator("#probe").click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      const seen = await frame.locator("#seen").textContent();
      const focused = await frame
        .locator("body")
        .evaluate(() => document.activeElement?.id ?? null);
      observe(ctx, seen === "1", `inline page saw ${seen} Escape presses, expected 1`);
      observe(ctx, focused === "probe", `focus left the inline page field (now ${focused})`);
      observe(
        ctx,
        (await page.getByTestId("show-page-full-size-close").count()) === 0,
        "inline Escape opened the full-size viewer",
      );
      return `seen ${seen}, focus ${focused}`;
    },
  },
  {
    id: "full-size-desktop",
    label:
      "Full-size viewer on the macOS desktop shell: unreadable backdrop, clear of the traffic lights",
    narrate: "The viewer blurs the app behind it, and its title starts after the traffic lights.",
    async run(ctx) {
      const page = ctx.page;
      await openFullSize(page, ESCAPE_TITLE);
      await ctx.shot("full-size");
      const viewport = page.viewportSize();
      // Below the probe page's content: only the backdrop sits over the chat's text there.
      const edge = await regionEdgeP99(page, {
        x: Math.round(viewport.width * 0.4),
        y: Math.round(viewport.height * 0.5),
        width: Math.round(viewport.width * 0.5),
        height: Math.round(viewport.height * 0.4),
      });
      observe(
        ctx,
        edge < READABLE_EDGE_P99,
        `app text behind the viewer is readable (edge p99 ${edge.toFixed(2)} >= ${READABLE_EDGE_P99})`,
      );
      const geometry = await readViewerGeometry(page, ESCAPE_TITLE);
      checkGeometry(ctx, geometry, viewport, { trafficLights: true });
      return `edge p99 ${edge.toFixed(2)}; title x=${Math.round(geometry.title?.x ?? -1)}; header h=${Math.round(geometry.header?.height ?? -1)}`;
    },
  },
  {
    id: "full-size-escape",
    label: "Escape closes the viewer, also with focus inside the page",
    narrate:
      "Escape the page handles keeps the viewer open. Escape anywhere else in the page closes it.",
    async run(ctx) {
      const page = ctx.page;
      const frame = page.frameLocator(fullSizeFrame(ESCAPE_TITLE));
      await frame.locator("#consume").click();
      await page.keyboard.press("Escape");
      const handled = await frame.locator("#handled").textContent();
      observe(ctx, handled === "1", `page handled ${handled} Escape presses, expected 1`);
      observe(
        ctx,
        await isFullSizeOpen(page, 600),
        "viewer closed on an Escape the page handled itself",
      );
      await frame.locator("#probe").click();
      await page.keyboard.press("Escape");
      const closedFromPage = !(await isFullSizeOpen(page, 1_500));
      observe(ctx, closedFromPage, "Escape with focus inside the page left the viewer open");
      await ctx.shot("after-escape");
      await closeFullSize(page);

      await openFullSize(page, ESCAPE_TITLE);
      await page.keyboard.press("Escape");
      const closedFromHost = !(await isFullSizeOpen(page, 1_500));
      observe(ctx, closedFromHost, "Escape right after opening left the viewer open");
      await closeFullSize(page);
      return `page-focus close: ${closedFromPage}; host-focus close: ${closedFromHost}`;
    },
  },
  {
    id: "full-size-mermaid",
    label: "The Mermaid page renders in the full-size viewer",
    narrate: "Opened full size, the Mermaid page renders its diagrams again.",
    async run(ctx) {
      const page = ctx.page;
      await openFullSize(page, MERMAID_TITLE);
      const result = await waitForMermaid(page, fullSizeFrame(MERMAID_TITLE));
      await ctx.shot("full-size-mermaid");
      observe(ctx, result.state === "3/3", `full-size render ${JSON.stringify(result)}`);
      await closeFullSize(page);
      return `rendered ${result.state}`;
    },
  },
  {
    id: "full-size-web-and-phone",
    label: "Full-size viewer in a plain browser and at phone width",
    narrate: "In the browser and at phone width the header stays clear and the backdrop opaque.",
    async run(ctx) {
      const page = ctx.page;
      await page.evaluate(() => {
        sessionStorage.setItem("spv-web", "1");
        const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ ...settings, theme: "dark" }));
      });
      await page.goto(workspaceUrl(ctx, state.workspaceId, state.agentId), {
        waitUntil: "domcontentloaded",
        timeout: UI_TIMEOUT_MS,
      });
      await showPageCard(page, ESCAPE_TITLE).waitFor({ timeout: UI_TIMEOUT_MS });
      await openFullSize(page, ESCAPE_TITLE);
      const viewport = page.viewportSize();
      const edge = await regionEdgeP99(page, {
        x: Math.round(viewport.width * 0.4),
        y: Math.round(viewport.height * 0.5),
        width: Math.round(viewport.width * 0.5),
        height: Math.round(viewport.height * 0.4),
      });
      observe(ctx, edge < READABLE_EDGE_P99, `web: app text readable behind viewer (${edge})`);
      checkGeometry(ctx, await readViewerGeometry(page, ESCAPE_TITLE), viewport, {
        trafficLights: false,
      });
      await ctx.shot("full-size-web");
      await closeFullSize(page);
      // The compact layout remounts the chat, so open the viewer again at phone width.
      await page.setViewportSize({ width: 390, height: 844 });
      await showPageCard(page, ESCAPE_TITLE).waitFor({ timeout: UI_TIMEOUT_MS });
      await openFullSize(page, ESCAPE_TITLE);
      const phone = await readViewerGeometry(page, ESCAPE_TITLE);
      checkGeometry(ctx, phone, page.viewportSize(), { trafficLights: false });
      await ctx.shot("full-size-phone");
      await closeFullSize(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      return `web edge p99 ${edge.toFixed(2)}; phone header h=${Math.round(phone.header?.height ?? -1)}`;
    },
  },
  {
    id: "verdict",
    label: "Every expectation held",
    narrate: "The viewer passes every expectation.",
    async run(ctx) {
      await ctx.shot("after");
      ctx.expect(state.failures.length === 0, state.failures.join("; "));
      return "no failures";
    },
  },
];
