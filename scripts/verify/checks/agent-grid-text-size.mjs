export const meta = {
  name: "agent-grid-text-size",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Settings > Appearance exposes an Agent Grid text size that is independent of " +
    "the full-agent content size, and changing it resizes grid tile transcripts only.",
};

const MOCK_PROVIDER = "mock";
const FIVE_MIN_MODEL = "five-minute-stream";
const SEED_MESSAGE = "Stream continuously for the agent-grid-text-size verification check.";
const GRID_SIZE_TESTID = "settings-appearance-agent-grid-size";
const CONTENT_SIZE_TESTID = "settings-appearance-content-size";
const LARGE_GRID_SIZE = "18";
const SMALL_GRID_SIZE = "12";

let RUN_ID = null;

function tileSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-tile-${agentId}"]`;
}

async function pollFor(
  fetchValue,
  { timeoutMs = 15000, intervalMs = 300, description = "condition" } = {},
) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last && last.ok) {
      return last.value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${Date.now() - start}ms waiting for ${description}; last=${JSON.stringify(last?.value ?? last)}`,
  );
}

async function appearanceUrl(ctx) {
  return new URL("/settings/appearance", ctx.host().httpUrl).href;
}

async function openAppearance(ctx) {
  const page = ctx.page;
  await page.goto(await appearanceUrl(ctx), { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForSelector(
    '[data-testid="settings-detail-pane"], [data-testid="settings-sidebar"]',
    { timeout: 15_000 },
  );
}

async function openGrid(ctx) {
  const page = ctx.page;
  const mcButton = page.locator('[data-testid="sidebar-mission-control"]');
  await mcButton.waitFor({ state: "visible", timeout: 15_000 });
  await mcButton.click();
  await page.waitForSelector('[data-testid="mission-control-view-grid"]', { timeout: 10_000 });
  await page.locator('[data-testid="mission-control-view-grid"]').click();
  await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });
  await page.waitForSelector(tileSelector(RUN_ID), { timeout: 15_000 });
}

async function setFontSizeField(page, testId, value) {
  const input = page.locator(`[data-testid="${testId}"]`);
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.click({ clickCount: 3 });
  await input.fill(value);
  await input.blur();
}

async function readFontSizeField(page, testId) {
  const input = page.locator(`[data-testid="${testId}"]`);
  await input.waitFor({ state: "visible", timeout: 10_000 });
  return (await input.inputValue()).trim();
}

async function tileFontMetrics(page, agentId) {
  return page.locator(tileSelector(agentId)).evaluate((tile) => {
    const scale = tile.querySelector('[data-testid="mission-control-agent-grid-content-scale"]');
    const declared = scale?.getAttribute("data-agent-grid-font-size") ?? null;
    const zoomRaw = scale ? getComputedStyle(scale).zoom : "";
    const zoom = Number.parseFloat(zoomRaw);
    const nodes = [...tile.querySelectorAll("p, span, div")];
    let height = 0;
    let fontSize = 0;
    for (const node of nodes) {
      const style = getComputedStyle(node);
      const size = Number.parseFloat(style.fontSize);
      if (!Number.isFinite(size) || size < 10) continue;
      const box = node.getBoundingClientRect();
      if (box.height > 10 && box.height < 120 && box.height > height) {
        height = box.height;
        fontSize = size;
      }
    }
    return {
      declared,
      zoom: Number.isFinite(zoom) ? zoom : null,
      height,
      fontSize,
    };
  });
}

export const steps = [
  {
    id: "load-app",
    label: "Load web UI and connect to daemon",
    narrate: "Web UI loaded in Chromium and connected to loopback daemon.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");
      await page.goto(host.httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector(
        '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
        { timeout: 10_000 },
      );
      return `app loaded from ${host.httpUrl}`;
    },
  },
  {
    id: "seed-fixture",
    label: "Seed one long-running grid fixture over daemon RPC",
    narrate: "A long-running agent was created so Agent Grid has a transcript to measure.",
    async run(ctx) {
      const client = ctx.host().client;
      const run = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-grid-text-size ${ctx.stack.runId}`,
      });
      ctx.expect(Boolean(run?.id), "grid fixture agent created");
      RUN_ID = run.id;
      await client.sendMessage(RUN_ID, SEED_MESSAGE);
      return `fixture ${RUN_ID}`;
    },
  },
  {
    id: "appearance-has-separate-grid-size",
    label: "Appearance settings expose Agent Grid size next to content size",
    narrate: "Opened Settings → Appearance and found a dedicated Agent Grid text-size field.",
    async run(ctx) {
      const page = ctx.page;
      await openAppearance(ctx);
      await page.waitForSelector(`[data-testid="${GRID_SIZE_TESTID}"]`, { timeout: 10_000 });
      await page.waitForSelector(`[data-testid="${CONTENT_SIZE_TESTID}"]`, { timeout: 10_000 });
      const contentSize = await readFontSizeField(page, CONTENT_SIZE_TESTID);
      ctx.expect(/\d+/.test(contentSize), `content size should be numeric, got "${contentSize}"`);
      return `content size ${contentSize}px; Agent Grid size field present`;
    },
  },
  {
    id: "set-grid-size-keeps-content-size",
    label: "Changing Agent Grid size does not change content size",
    narrate: "Set Agent Grid to 18px; the full-agent content size stayed put.",
    async run(ctx) {
      const page = ctx.page;
      const contentBefore = await readFontSizeField(page, CONTENT_SIZE_TESTID);
      await setFontSizeField(page, GRID_SIZE_TESTID, LARGE_GRID_SIZE);
      await pollFor(
        async () => {
          const value = await readFontSizeField(page, GRID_SIZE_TESTID);
          return { ok: value === LARGE_GRID_SIZE, value };
        },
        { timeoutMs: 8_000, description: "Agent Grid size field commits 18" },
      );
      const contentAfter = await readFontSizeField(page, CONTENT_SIZE_TESTID);
      ctx.expect(
        contentAfter === contentBefore,
        `content size must stay ${contentBefore}, got ${contentAfter} after changing Agent Grid size`,
      );
      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");
      return `grid=${LARGE_GRID_SIZE} content=${contentAfter}`;
    },
  },
  {
    id: "grid-applies-large-size",
    label: "Agent Grid tiles render at the committed Agent Grid size",
    narrate: "Opened Agent Grid; tile transcripts used the 18px grid size.",
    async run(ctx) {
      const page = ctx.page;
      await openGrid(ctx);
      const metrics = await pollFor(
        async () => {
          const value = await tileFontMetrics(page, RUN_ID);
          return { ok: value.declared === LARGE_GRID_SIZE && value.height > 10, value };
        },
        { timeoutMs: 15_000, description: "tile declares Agent Grid font size 18" },
      );
      ctx.gridLargeHeight = metrics.height;
      return `declared=${metrics.declared} height=${metrics.height} zoom=${metrics.zoom}`;
    },
  },
  {
    id: "smaller-grid-size-shrinks-transcript",
    label: "Dropping Agent Grid size shrinks tile text without touching content size",
    narrate: "Set Agent Grid to 12px; tile text got smaller and content size was unchanged.",
    async run(ctx) {
      const page = ctx.page;
      await openAppearance(ctx);
      const contentBefore = await readFontSizeField(page, CONTENT_SIZE_TESTID);
      await setFontSizeField(page, GRID_SIZE_TESTID, SMALL_GRID_SIZE);
      await pollFor(
        async () => {
          const value = await readFontSizeField(page, GRID_SIZE_TESTID);
          return { ok: value === SMALL_GRID_SIZE, value };
        },
        { timeoutMs: 8_000, description: "Agent Grid size field commits 12" },
      );
      const contentAfter = await readFontSizeField(page, CONTENT_SIZE_TESTID);
      ctx.expect(
        contentAfter === contentBefore,
        `content size must stay ${contentBefore}, got ${contentAfter}`,
      );

      await openGrid(ctx);
      const metrics = await pollFor(
        async () => {
          const value = await tileFontMetrics(page, RUN_ID);
          return { ok: value.declared === SMALL_GRID_SIZE && value.height > 8, value };
        },
        { timeoutMs: 15_000, description: "tile declares Agent Grid font size 12" },
      );
      ctx.expect(
        metrics.height < ctx.gridLargeHeight,
        `12px grid text should be shorter than 18px (18=${ctx.gridLargeHeight} 12=${metrics.height})`,
      );
      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");
      return `declared=${metrics.declared} height ${ctx.gridLargeHeight} -> ${metrics.height}; content=${contentAfter}`;
    },
  },
];
