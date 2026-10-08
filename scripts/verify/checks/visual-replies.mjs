import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  name: "visual-replies",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Agent replies render visually: a <details> block with paragraphs collapses into one toggle, mermaid and Flint charts draw on the theme, show_page HTML renders as an interactive inline page with a working chart, show_page on a localhost URL embeds the running app, the full-size viewer opens, and preview_page returns a real screenshot of the page from the daemon's headless browser.",
};

const UI_TIMEOUT_MS = 30_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const state = {
  appPort: null,
  appProcess: null,
  workspaceId: null,
  agentId: null,
  preview: null,
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The "app the agent built": a page with its own state, served from this machine's
// loopback the way a dev server would be.
const DEMO_APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Counter</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#0f172a;color:#e2e8f0}
.card{max-width:420px;padding:20px;border-radius:12px;background:#1e293b}
button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#38bdf8;color:#0f172a;cursor:pointer}
#count{font-size:40px;font-weight:700;margin:8px 0}
</style></head><body><div class="card">
<div>Agent-built app on <code>localhost</code></div><div id="count">0</div>
<button id="inc">Increment</button></div>
<script>let n=0;document.getElementById("inc").onclick=()=>{n++;document.getElementById("count").textContent=String(n)}</script>
</body></html>`;

const DASHBOARD_HTML = `<div class="p-row" style="justify-content:space-between;margin-bottom:12px">
  <div class="p-row" role="tablist">
    <button class="active" data-tab="overview">Overview</button>
    <button data-tab="hosts">Hosts</button>
  </div>
  <span class="p-badge ok">3 hosts online</span>
</div>
<section data-panel="overview">
  <div class="p-grid">
    <div class="p-card"><div class="p-muted">Running</div><div class="p-stat">7</div></div>
    <div class="p-card"><div class="p-muted">Needs you</div><div class="p-stat">2</div><span class="p-badge warn">permission, review</span></div>
    <div class="p-card"><div class="p-muted">Done today</div><div class="p-stat">14</div><span class="p-badge ok">+5 vs yesterday</span></div>
    <div class="p-card"><div class="p-muted">Failed</div><div class="p-stat">1</div><span class="p-badge bad">deploy-check</span></div>
  </div>
  <div id="trend" class="p-chart" style="margin-top:12px"></div>
</section>
<section data-panel="hosts" hidden>
  <input id="filter" placeholder="Filter hosts" style="width:100%;margin-bottom:8px">
  <table><thead><tr><th><button data-sort="name">Host</button></th><th><button data-sort="agents">Agents</button></th><th>State</th></tr></thead><tbody id="rows"></tbody></table>
</section>
<script>
const hosts = [
  { name: "mac", agents: 3, state: "ok" },
  { name: "personal-server", agents: 3, state: "ok" },
  { name: "blrofc3", agents: 1, state: "bad" },
];
let sortKey = "agents";
function renderRows() {
  const query = document.getElementById("filter").value.toLowerCase();
  const rows = hosts
    .filter((host) => host.name.includes(query))
    .sort((a, b) => (sortKey === "name" ? a.name.localeCompare(b.name) : b.agents - a.agents));
  document.getElementById("rows").innerHTML = rows
    .map((host) => '<tr><td>' + host.name + '</td><td>' + host.agents + '</td><td><span class="p-badge ' + host.state + '">' + (host.state === "ok" ? "online" : "1 failed") + '</span></td></tr>')
    .join("");
}
document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach((other) => other.classList.toggle("active", other === tab));
    document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== tab.dataset.tab; });
  };
});
document.querySelectorAll("[data-sort]").forEach((button) => { button.onclick = () => { sortKey = button.dataset.sort; renderRows(); }; });
document.getElementById("filter").oninput = renderRows;
renderRows();
paseo.chart("#trend", {
  data: { values: [
    { day: "2026-10-01", done: 6 }, { day: "2026-10-02", done: 9 }, { day: "2026-10-03", done: 7 },
    { day: "2026-10-04", done: 11 }, { day: "2026-10-05", done: 8 }, { day: "2026-10-06", done: 9 }, { day: "2026-10-07", done: 14 }
  ] },
  semantic_types: { day: "Date", done: "Count" },
  chart_spec: { chartType: "Line Chart", encodings: { x: { field: "day" }, y: { field: "done" } }, chartProperties: { showPoints: true } }
}).then(() => console.log("trend chart drawn"));
</script>`;

const FLINT_SPEC = {
  data: {
    values: [
      { host: "mac", running: 3, failed: 0 },
      { host: "personal-server", running: 3, failed: 0 },
      { host: "blrofc3", running: 1, failed: 1 },
    ],
  },
  semantic_types: { host: "Category", running: "Count", failed: "Count" },
  chart_spec: {
    chartType: "Grouped Bar Chart",
    encodings: { x: { field: "host" }, y: ["running", "failed"] },
  },
};

const SUMMARY_TEXT = [
  "✅ Fleet healthy. 7 running, 2 need you, 1 failed.",
  "",
  "- **Needs you:** `Brave Uma` (permission), `Tidy Brian` (review)",
  "- **Failed:** `deploy-check` timed out on `blrofc3`",
  "- **Next:** approve Brave Uma; rerun deploy-check after blrofc3 reconnects",
  "",
  "```mermaid",
  "flowchart LR",
  '  U["You"] --> C["Commander"]',
  '  C -->|dispatch| W1["Brave Uma | theme"]',
  '  C -->|dispatch| W2["Tidy Brian | review"]',
  '  W1 --> V["Verifier"]',
  "  W2 --> V",
  "```",
  "",
  "| Host | Running | Needs you | Failed |",
  "|---|---|---|---|",
  "| mac | 3 | 1 | 0 |",
  "| personal-server | 3 | 1 | 0 |",
  "| blrofc3 | 1 | 0 | 1 |",
  "",
  "```flint",
  JSON.stringify(FLINT_SPEC, null, 2),
  "```",
  "",
  "<details><summary>Evidence: deploy-check log</summary>",
  "",
  "- source: `~/.paseo/deploy-logs/latest.log`",
  "- exit: `124` after `600s`",
  "",
  "```text",
  "[deploy-check] waiting for blrofc3 /api/health",
  "[deploy-check] timeout after 600s",
  "```",
  "",
  "</details>",
].join("\n");

const FINAL_TEXT =
  "⚠️ `deploy-check` failed on a timeout, not on code. Rerun it after `blrofc3` reconnects.";

function buildTimeline({ appUrl, preview, dashboardCall }) {
  const previewInput = { html: DASHBOARD_HTML, width: 760, appearance: "dark" };
  const previewSummary = {
    ok: true,
    width: preview.width,
    contentHeight: preview.contentHeight,
    capturedHeight: preview.capturedHeight,
    consoleMessages: preview.consoleMessages,
  };
  return [
    { type: "assistant_message", text: SUMMARY_TEXT, messageId: "visual-replies-summary" },
    {
      type: "tool_call",
      callId: "visual-replies-preview",
      name: "preview_page",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: previewInput,
        // Providers replace MCP image blocks with a placeholder in the transcript.
        output: {
          content: [
            { type: "text", text: "[image]" },
            { type: "text", text: JSON.stringify(previewSummary) },
          ],
        },
      },
    },
    {
      type: "tool_call",
      callId: "visual-replies-dashboard",
      name: "show_page",
      status: "completed",
      error: null,
      detail: { type: "unknown", ...dashboardCall },
    },
    {
      type: "tool_call",
      callId: "visual-replies-app",
      name: "show_page",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { title: "Counter app (localhost)", url: appUrl, height: 260 },
        output: { ok: true },
      },
    },
    { type: "assistant_message", text: FINAL_TEXT, messageId: "visual-replies-final" },
  ];
}

export const steps = [
  {
    id: "demo-app",
    label: "Start an agent-built app on localhost",
    narrate: "A small counter app runs on this machine's loopback, like a dev server.",
    async run(ctx) {
      const dir = path.join(ctx.artifactsDir, "visual-replies-app");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "index.html"), DEMO_APP_HTML);
      state.appPort = await freePort();
      // Detached so a --keep stack keeps the app; the last step stops it unless asked not to.
      state.appProcess = spawn(
        "python3",
        ["-m", "http.server", String(state.appPort), "--bind", "127.0.0.1"],
        { cwd: dir, detached: true, stdio: "ignore" },
      );
      state.appProcess.unref();
      await fsp.writeFile(
        path.join(ctx.artifactsDir, "visual-replies-app.pid"),
        String(state.appProcess.pid),
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const ok = await fetch(`http://127.0.0.1:${state.appPort}/`).then(
          (res) => res.ok,
          () => false,
        );
        if (ok) break;
        ctx.expect(Date.now() < deadline, "demo app did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return `demo app on http://localhost:${state.appPort}/`;
    },
  },
  {
    id: "preview-page",
    label: "preview_page renders the dashboard in the daemon's headless browser",
    narrate: "The daemon's preview browser screenshots the page and reports its console.",
    async run(ctx) {
      const modulePath = path.join(
        repoRoot,
        "packages/server/dist/server/server/page-tools/preview-browser.js",
      );
      const { PagePreviewBrowser } = await import(modulePath);
      const logger = { info() {}, warn() {}, debug() {} };
      const browser = new PagePreviewBrowser(logger);
      let result = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          result = await browser.capture({ html: DASHBOARD_HTML, width: 760, appearance: "dark" });
          if (result.kind !== "installing") break;
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
      } finally {
        await browser.close();
      }
      ctx.expect(result?.kind === "captured", `preview failed: ${result?.message ?? "no result"}`);
      const shot = path.join(ctx.artifactsDir, "shots", "preview-page.png");
      await fsp.mkdir(path.dirname(shot), { recursive: true });
      await fsp.writeFile(shot, result.png);
      ctx.expect(result.contentHeight > 200, `contentHeight ${result.contentHeight} too small`);
      const errors = result.consoleMessages.filter((message) => message.level === "error");
      ctx.expect(errors.length === 0, `page console errors: ${JSON.stringify(errors)}`);
      ctx.expect(
        result.consoleMessages.some((message) => message.text === "trend chart drawn"),
        "paseo.chart did not report drawing the trend chart",
      );
      state.preview = result;
      return `preview ${result.width}x${result.capturedHeight}, contentHeight ${result.contentHeight}, screenshot ${shot}`;
    },
  },
  {
    id: "show-page-path",
    label: "show_page publishes the dashboard from a file into the daemon's page store",
    narrate: "The real show_page tool reads the page file and stores it on the stack's daemon.",
    async run(ctx) {
      const serverDist = path.join(repoRoot, "packages/server/dist/server/server/page-tools");
      const { registerPageTools } = await import(path.join(serverDist, "tools.js"));
      const { PageStore } = await import(path.join(serverDist, "page-store.js"));
      const pagesDir = path.join(ctx.artifactsDir, "visual-replies-pages");
      await fsp.mkdir(pagesDir, { recursive: true });
      await fsp.writeFile(path.join(pagesDir, "dashboard.html"), DASHBOARD_HTML);
      const handlers = new Map();
      registerPageTools({
        registerTool: (name, _config, handler) => handlers.set(name, handler),
        previewBrowser: { capture: async () => ({ kind: "failed", message: "unused" }) },
        // The stack daemon reads pages from its own home; the tool writes them there.
        pageStore: new PageStore(ctx.host().home),
        resolveCallerCwd: () => pagesDir,
      });
      const result = await handlers.get("show_page")({
        title: "Fleet dashboard",
        path: "dashboard.html",
      });
      ctx.expect(!result.isError, `show_page failed: ${JSON.stringify(result.content)}`);
      // What a provider records: the input and the result's content blocks, not the html.
      state.dashboardCall = {
        input: { title: "Fleet dashboard", path: "dashboard.html" },
        output: { content: result.content },
      };
      await fsp.rm(path.join(pagesDir, "dashboard.html"));
      return `${result.content[0].text.slice(0, 40)}…; source file deleted`;
    },
  },
  {
    id: "seed-agent",
    label: "Seed an agent whose reply uses every visual format",
    narrate: "An agent replies with bullets, a diagram, a table, a chart, evidence, and two pages.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: "Visual replies",
      });
      state.workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(state.workspaceId), "workspace must have an id");
      const agent = await client.createAgent({
        provider: "mock",
        cwd: ctx.fixtureRepo,
        workspaceId: state.workspaceId,
        title: "Visual replies demo",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "How is the fleet doing?",
        featureValues: {
          mockTimelineTurns: [
            buildTimeline({
              appUrl: `http://localhost:${state.appPort}/`,
              preview: state.preview,
              dashboardCall: state.dashboardCall,
            }),
          ],
        },
      });
      state.agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
      return `agent ${agent.id} in workspace ${state.workspaceId}`;
    },
  },
  {
    id: "open-agent",
    label: "Open the agent in the web UI",
    narrate: "The reply renders: bullets, diagram, table, chart, and a collapsed evidence block.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available");
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.emulateMedia({ colorScheme: "dark" });
      const host = ctx.host();
      const url = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(state.workspaceId)}?open=agent:${encodeURIComponent(state.agentId)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: UI_TIMEOUT_MS });
      await page
        .getByText("Fleet healthy. 7 running", { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await ctx.shot("before");
      return "reply visible";
    },
  },
  {
    id: "details-collapse",
    label: "<details> renders as one collapsed toggle that expands",
    narrate: "The evidence block is a toggle, not raw tags. Opening it shows the log.",
    async run(ctx) {
      const page = ctx.page;
      const body = await page.locator("body").innerText();
      ctx.expect(!body.includes("<details>"), "raw <details> tag is visible");
      ctx.expect(!body.includes("</details>"), "raw </details> tag is visible");
      ctx.expect(!body.includes("timeout after 600s"), "evidence is visible before expanding");
      const toggle = page.getByRole("button", { name: "Evidence: deploy-check log" });
      await toggle.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await toggle.click();
      await page
        .getByText("timeout after 600s")
        .first()
        .waitFor({ state: "visible", timeout: 5_000 });
      await toggle.scrollIntoViewIfNeeded();
      await ctx.shot("details-open");
      return "details collapsed by default and expands on click";
    },
  },
  {
    id: "charts-and-diagram",
    label: "Mermaid and the Flint chart draw on a transparent background",
    narrate: "The diagram and chart sit on the chat surface with the theme's colors.",
    async run(ctx) {
      const page = ctx.page;
      const canvas = page.locator('[aria-label="Chart"] canvas').first();
      await canvas.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      // ECharts paints its theme background onto the canvas; transparent means alpha 0 at a
      // corner where no series draws.
      const cornerAlpha = await canvas.evaluate((element) => {
        const context = element.getContext("2d");
        return context ? context.getImageData(1, 1, 1, 1).data[3] : -1;
      });
      ctx.expect(cornerAlpha === 0, `chart canvas corner alpha ${cornerAlpha}, expected 0`);
      // The chat list mounts only rows near the viewport; the diagram is at the top of the reply.
      const diagram = page.locator('[aria-label="Mermaid diagram"] svg').first();
      const scroller = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      for (let attempt = 0; attempt < 20 && (await diagram.count()) === 0; attempt++) {
        await scroller.evaluate((element) => element.scrollBy(0, -600));
        await page.waitForTimeout(250);
      }
      await diagram.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      await diagram.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await ctx.shot("diagram");
      await canvas.scrollIntoViewIfNeeded();
      await ctx.shot("chart");
      return "chart canvas transparent; diagram runtime mounted";
    },
  },
  {
    id: "html-page",
    label: "show_page HTML renders inline and is interactive",
    narrate:
      "The dashboard page renders in the reply, draws its chart, and its tabs and table work.",
    async run(ctx) {
      const page = ctx.page;
      const frameElement = page.locator(
        'iframe[data-testid="show-page-frame"][title="Fleet dashboard"]',
      );
      await frameElement.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      await frameElement.scrollIntoViewIfNeeded();
      const frame = page.frameLocator('iframe[title="Fleet dashboard"]');
      await frame.getByText("Done today").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await frame
        .locator("#trend canvas")
        .first()
        .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      // The frame grows to its content instead of staying at the initial height.
      await page.waitForFunction(
        () => {
          const element = document.querySelector('iframe[title="Fleet dashboard"]');
          return element ? element.getBoundingClientRect().height > 250 : false;
        },
        null,
        { timeout: UI_TIMEOUT_MS },
      );
      const transparent = await frame
        .locator("body")
        .evaluate((body) => getComputedStyle(body).backgroundColor);
      ctx.expect(
        transparent === "rgba(0, 0, 0, 0)" || transparent === "transparent",
        `page body background ${transparent}, expected transparent`,
      );
      await ctx.shot("html-page");
      await frame.getByRole("button", { name: "Hosts" }).click();
      await frame.locator("#filter").fill("blr");
      const rows = await frame.locator("#rows tr").count();
      ctx.expect(rows === 1, `filter left ${rows} rows, expected 1`);
      await ctx.shot("html-page-hosts-tab");
      return "dashboard rendered, chart drawn, frame sized to content, tabs and filter work";
    },
  },
  {
    id: "url-page",
    label: "show_page on a localhost URL embeds the running app",
    narrate: "The agent's localhost app runs inside the reply. Clicking its button updates it.",
    async run(ctx) {
      const page = ctx.page;
      const frameElement = page.locator('iframe[title="Counter app (localhost)"]');
      await frameElement.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      await frameElement.scrollIntoViewIfNeeded();
      const frame = page.frameLocator('iframe[title="Counter app (localhost)"]');
      await frame.getByRole("button", { name: "Increment" }).click();
      await frame.getByRole("button", { name: "Increment" }).click();
      await frame.locator("#count").filter({ hasText: "2" }).waitFor({ timeout: 5_000 });
      await ctx.shot("url-page");
      return "localhost app embedded and interactive";
    },
  },
  {
    id: "full-size",
    label: "The full-size viewer opens the page and closes",
    narrate: "The expand button opens the page full size; close returns to the chat.",
    async run(ctx) {
      const page = ctx.page;
      await page.getByTestId("show-page-full-size").first().click();
      const close = page.getByTestId("show-page-full-size-close");
      await close.waitFor({ state: "visible", timeout: 5_000 });
      await page.waitForTimeout(800);
      await ctx.shot("full-size");
      await close.click();
      await close.waitFor({ state: "detached", timeout: 5_000 });
      return "full-size viewer opened and closed";
    },
  },
  {
    id: "theme-switch",
    label: "The page follows a theme switch",
    narrate: "Switching to light mode repaints the page with the light theme's colors.",
    async run(ctx) {
      const page = ctx.page;
      const frame = page.frameLocator('iframe[title="Fleet dashboard"]');
      const readForeground = () =>
        frame
          .locator("html")
          .evaluate((root) => getComputedStyle(root).getPropertyValue("--paseo-fg").trim());
      const darkForeground = await readForeground();
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForTimeout(1_500);
      const lightForeground = await readForeground();
      ctx.expect(
        lightForeground !== darkForeground,
        `--paseo-fg stayed ${darkForeground} after the theme switch`,
      );
      await page.locator('iframe[title="Fleet dashboard"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
      await ctx.shot("light-theme");
      await page.getByText("failed on a timeout, not on code").first().scrollIntoViewIfNeeded();
      await ctx.shot("after");
      if (process.env.VISUAL_REPLIES_KEEP_APP !== "1" && state.appProcess?.pid) {
        process.kill(-state.appProcess.pid);
      }
      return `--paseo-fg ${darkForeground} -> ${lightForeground}`;
    },
  },
];
