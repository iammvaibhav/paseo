export const meta = {
  name: "agent-view-grid",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Mission Control Agent Grid renders running/ready-for-review fixtures in recency order, " +
    "resizes via the count/direction controls, windows off-screen tiles, and accepts composer " +
    "input inside a tile.",
};

const MOCK_PROVIDER = "mock";
const FIVE_MIN_MODEL = "five-minute-stream";
const TEN_SEC_MODEL = "ten-second-stream";
const SEED_MESSAGE = "Stream continuously for the agent-view-grid verification check.";
const RESUME_MESSAGE = "Resume streaming so the ready tile transitions back to running.";
const TYPED_MESSAGE = "agent-view-grid composer smoke text";

// Module state threaded across steps (each step runs sequentially on one module instance).
let RUN_A_ID = null;
let RUN_B_ID = null;
let READY_ID = null;

function tileTestId(agentId) {
  return `mission-control-agent-grid-tile-${agentId}`;
}
function tileSelector(agentId) {
  return `[data-testid="${tileTestId(agentId)}"]`;
}
function tileSectionSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-tile-section-${agentId}"]`;
}
function tileElapsedSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-elapsed-${agentId}"]`;
}
function tileComposerInputSelector(agentId) {
  return `${tileSelector(agentId)} textarea[data-composer-input], ${tileSelector(agentId)} textarea`;
}
function tileComposerSubmitSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-composer-submit-${agentId}"]`;
}

/**
 * Poll `fetchValue` until it reports `{ ok: true, value }` or the timeout elapses.
 * On timeout, the error carries the last observed value for diagnosis.
 */
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

/** Read the fleet roster and pick out just the fixture agents this check owns. */
async function listFixtureAgents(client, ids) {
  const res = await client.missionControlToolsExecute({
    name: "fleet_list_agents",
    args: { limit: 200 },
  });
  const agents = res.structuredContent?.agents ?? res.agents ?? [];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return ids.map((id) => byId.get(id) ?? null);
}

/**
 * Agent ids in on-screen grid order, from either full or placeholder tile roots (never
 * the section-chip child element). Placeholder ids are normalized back to the bare
 * agent id so reorders can be asserted independent of which tiles are windowed in.
 * `allowedIds`, when given, filters the result to just those ids (in DOM order) so
 * assertions are immune to other agents sharing the stack (--all / --stack reuse).
 */
async function gridAgentOrder(page, allowedIds) {
  const testIds = await page.$$eval('[data-testid^="mission-control-agent-grid-tile-"]', (els) =>
    els.map((el) => el.getAttribute("data-testid")).filter((id) => id && !id.includes("-section-")),
  );
  const ids = testIds.map((id) =>
    id.replace(/^mission-control-agent-grid-tile-(placeholder-)?/, ""),
  );
  return allowedIds ? ids.filter((id) => allowedIds.has(id)) : ids;
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
    id: "seed-fixtures",
    label: "Seed RUN_A, RUN_B and READY fixture agents over daemon RPC",
    narrate: "Two long-running agents and one fast-finishing agent were created over RPC.",
    async run(ctx) {
      const client = ctx.host().client;
      const runId = ctx.stack.runId;

      const runA = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-view-grid run-a ${runId}`,
      });
      ctx.expect(Boolean(runA?.id), "RUN_A agent created");
      RUN_A_ID = runA.id;
      await client.sendMessage(RUN_A_ID, SEED_MESSAGE);

      // RUN_B must start strictly later than RUN_A so the grid's most-recent-first
      // ordering renders it first.
      await new Promise((resolve) => setTimeout(resolve, 1600));

      const runB = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: FIVE_MIN_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-view-grid run-b ${runId}`,
      });
      ctx.expect(Boolean(runB?.id), "RUN_B agent created");
      RUN_B_ID = runB.id;
      await client.sendMessage(RUN_B_ID, SEED_MESSAGE);

      const ready = await client.createAgent({
        provider: MOCK_PROVIDER,
        model: TEN_SEC_MODEL,
        cwd: ctx.fixtureRepo,
        title: `agent-view-grid ready ${runId}`,
      });
      ctx.expect(Boolean(ready?.id), "READY agent created");
      READY_ID = ready.id;
      await client.sendMessage(READY_ID, SEED_MESSAGE);

      const buckets = await pollFor(
        async () => {
          const [a, b, r] = await listFixtureAgents(client, [RUN_A_ID, RUN_B_ID, READY_ID]);
          const snapshot = {
            runA: a?.bucket ?? null,
            runB: b?.bucket ?? null,
            ready: r?.bucket ?? null,
          };
          const ok =
            snapshot.runA === "running" &&
            snapshot.runB === "running" &&
            snapshot.ready === "ready";
          return { ok, value: snapshot };
        },
        {
          timeoutMs: 25_000,
          description: "RUN_A/RUN_B bucket=running and READY bucket=ready over fleet_list_agents",
        },
      );

      return `fixtures ready RUN_A=${RUN_A_ID} RUN_B=${RUN_B_ID} READY=${READY_ID} buckets=${JSON.stringify(buckets)}`;
    },
  },
  {
    id: "open-mission-control",
    label: "Navigate to Mission Control surface",
    narrate: "Mission Control surface opened in web UI.",
    async run(ctx) {
      const page = ctx.page;
      const mcButton = page.locator('[data-testid="sidebar-mission-control"]');
      await mcButton.waitFor({ state: "visible", timeout: 15_000 });
      await mcButton.click();
      return "Mission Control surface active";
    },
  },
  {
    id: "open-grid",
    label: "Switch to the Agent Grid view",
    narrate: "Switched Mission Control from Commander to the Agent Grid view.",
    async run(ctx) {
      const page = ctx.page;
      await page.waitForSelector('[data-testid="mission-control-view-grid"]', { timeout: 10_000 });
      await page.locator('[data-testid="mission-control-view-grid"]').click();
      await page.waitForSelector('[data-testid="mission-control-agent-grid"]', { timeout: 15_000 });

      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");
      return "Agent Grid view opened";
    },
  },
  {
    id: "assert-initial-order",
    label: "Assert tile order, section chips and elapsed timer",
    narrate: "Grid ordered the most recently started run first, with correct section chips.",
    async run(ctx) {
      const page = ctx.page;
      const expectedOrder = [RUN_B_ID, RUN_A_ID, READY_ID];
      const fixtureIds = new Set(expectedOrder);

      const order = await pollFor(
        async () => {
          const ids = await gridAgentOrder(page, fixtureIds);
          return { ok: JSON.stringify(ids) === JSON.stringify(expectedOrder), value: ids };
        },
        { timeoutMs: 20_000, description: `fixture tile order ${JSON.stringify(expectedOrder)}` },
      );

      const runBChip = (await page.locator(tileSectionSelector(RUN_B_ID)).innerText()).trim();
      const runAChip = (await page.locator(tileSectionSelector(RUN_A_ID)).innerText()).trim();
      const readyChip = (await page.locator(tileSectionSelector(READY_ID)).innerText()).trim();
      ctx.expect(runBChip === "Running", `RUN_B chip expected "Running", got "${runBChip}"`);
      ctx.expect(runAChip === "Running", `RUN_A chip expected "Running", got "${runAChip}"`);
      ctx.expect(
        readyChip === "Ready for review",
        `READY chip expected "Ready for review", got "${readyChip}"`,
      );

      const elapsedText = (await page.locator(tileElapsedSelector(RUN_B_ID)).innerText()).trim();
      ctx.expect(
        /^\d+s$|^\d+m/.test(elapsedText),
        `RUN_B elapsed text "${elapsedText}" does not match /^\\d+s$|^\\d+m/`,
      );

      return `order=${JSON.stringify(order)} elapsed=${elapsedText}`;
    },
  },
  {
    id: "resize-grid",
    label: "Set 1-per-screen and horizontal direction; overscan keeps 2 tiles full",
    narrate:
      "Switched to one tile per screen in horizontal direction; the ready tile stayed windowed out as a placeholder.",
    async run(ctx) {
      const page = ctx.page;

      await page.locator('[data-testid="mission-control-agent-grid-count"]').click();
      await page.waitForSelector('[data-testid="mission-control-agent-grid-count-1"]', {
        timeout: 5_000,
      });
      await page.locator('[data-testid="mission-control-agent-grid-count-1"]').click();
      await page.locator('[data-testid="mission-control-agent-grid-direction-horizontal"]').click();

      // visibleCount=1 in horizontal direction is a 1x1 shape; one tile of overscan on
      // each side still mounts RUN_A as a full tile alongside the visible RUN_B tile.
      const fullIds = await pollFor(
        async () => {
          const present = [];
          for (const id of [RUN_B_ID, RUN_A_ID, READY_ID]) {
            const count = await page.locator(tileComposerInputSelector(id)).count();
            if (count > 0) present.push(id);
          }
          const ok =
            present.length === 2 && present.includes(RUN_B_ID) && present.includes(RUN_A_ID);
          return { ok, value: present };
        },
        { timeoutMs: 10_000, description: "exactly RUN_B and RUN_A rendered as full tiles" },
      );

      const readyFull = (await page.locator(tileComposerInputSelector(READY_ID)).count()) > 0;
      ctx.expect(!readyFull, "READY tile must not be a full tile before scrolling into view");
      const readyPlaceholderCount = await page
        .locator(`[data-testid="mission-control-agent-grid-tile-placeholder-${READY_ID}"]`)
        .count();
      ctx.expect(
        readyPlaceholderCount > 0,
        "READY tile must render as a placeholder while windowed out",
      );

      return `full tiles after resize=${JSON.stringify(fullIds)}`;
    },
  },
  {
    id: "scroll-to-ready",
    label: "Scroll the grid to bring the READY tile into view",
    narrate:
      "Scrolled the grid horizontally until the ready-for-review tile mounted its full pane.",
    async run(ctx) {
      const page = ctx.page;
      const scrollLocator = page.locator('[data-testid="mission-control-agent-grid-scroll"]');
      await scrollLocator.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });

      const box = await scrollLocator.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(4000, 0);
      }

      await pollFor(
        async () => {
          const count = await page.locator(tileComposerInputSelector(READY_ID)).count();
          return { ok: count > 0, value: count };
        },
        { timeoutMs: 10_000, description: "READY tile composer visible after scroll" },
      );

      return "READY tile is a full tile after scrolling";
    },
  },
  {
    id: "compose-in-tile",
    label: "Type into RUN_A's tile composer and submit",
    narrate:
      "Typed a message into a grid tile's composer and confirmed it rendered in that tile's stream.",
    async run(ctx) {
      const page = ctx.page;
      await page.waitForSelector(tileComposerInputSelector(RUN_A_ID), { timeout: 10_000 });
      await page.locator(tileComposerInputSelector(RUN_A_ID)).fill(TYPED_MESSAGE);
      await page.locator(tileComposerSubmitSelector(RUN_A_ID)).click();

      await page.waitForFunction(
        ({ sel, text }) => {
          const el = document.querySelector(sel);
          return Boolean(el && el.textContent && el.textContent.includes(text));
        },
        { sel: tileSelector(RUN_A_ID), text: TYPED_MESSAGE },
        { timeout: 15_000 },
      );

      return `typed message rendered inside RUN_A tile ${RUN_A_ID}`;
    },
  },
  {
    id: "ready-transitions-to-running",
    label: "READY agent restarts a turn and its tile moves to index 0 as Running",
    narrate:
      "Sent a new message to the finished agent; its tile jumped to the front, now marked Running.",
    async run(ctx) {
      const client = ctx.host().client;
      await client.sendMessage(READY_ID, RESUME_MESSAGE);

      const page = ctx.page;
      const fixtureIds = new Set([RUN_A_ID, RUN_B_ID, READY_ID]);
      let chipText = null;
      await pollFor(
        async () => {
          const ids = await gridAgentOrder(page, fixtureIds);
          if (ids[0] !== READY_ID) return { ok: false, value: { ids, chipText: null } };
          chipText = (await page.locator(tileSectionSelector(READY_ID)).innerText()).trim();
          return { ok: chipText === "Running", value: { ids, chipText } };
        },
        {
          timeoutMs: 15_000,
          description: "READY tile first among fixtures with chip Running",
        },
      );

      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");

      return "READY tile moved to index 0 with chip Running";
    },
  },
];
