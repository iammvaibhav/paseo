export const meta = {
  name: "agent-view-grid",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Mission Control Agent Grid renders running/ready-for-review fixtures in recency order, " +
    "resizes via the count/direction controls, windows off-screen tiles, hides composers until " +
    "a tile is clicked, and then accepts composer input inside that tile.",
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
function tilePlaceholderSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-tile-placeholder-${agentId}"]`;
}
function tileActivateSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-activate-${agentId}"]`;
}
function tileElapsedSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-elapsed-${agentId}"]`;
}

/**
 * The element under the pointer at the transcript (not the identity strip).
 * An activate overlay sitting on the stream reports `overlayIntercepts: true`
 * and is what currently steals wheel/trackpad scroll.
 */
async function tileStreamHit(page, agentId) {
  return page.locator(tileSelector(agentId)).evaluate((tile, activateSel) => {
    const rect = tile.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height * 0.65;
    const topEl = document.elementFromPoint(x, y);
    const activate = tile.querySelector(activateSel);
    const overlayIntercepts = Boolean(
      activate && topEl && (activate === topEl || activate.contains(topEl)),
    );
    const nodes = [...tile.querySelectorAll("*")];
    let extra = 0;
    let top = 0;
    for (const node of nodes) {
      const style = getComputedStyle(node);
      if (!["auto", "scroll", "overlay"].includes(style.overflowY)) continue;
      const nodeExtra = node.scrollHeight - node.clientHeight;
      if (nodeExtra > extra) {
        extra = nodeExtra;
        top = node.scrollTop;
      }
    }
    return {
      overlayIntercepts,
      extra,
      top,
      topTestId: topEl?.getAttribute?.("data-testid") ?? null,
    };
  }, `[data-testid="mission-control-agent-grid-activate-${agentId}"]`);
}
function tileComposerInputSelector(agentId) {
  return `${tileSelector(agentId)} textarea[data-composer-input], ${tileSelector(agentId)} textarea`;
}
function tileComposerSubmitSelector(agentId) {
  return `[data-testid="mission-control-agent-grid-composer-submit-${agentId}"]`;
}

async function tileComposerCount(page, agentId) {
  return page.locator(tileComposerInputSelector(agentId)).count();
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
    label: "Assert tile order, section chips, header elapsed, and no default composers",
    narrate:
      "Grid ordered the most recently started run first, with Running chips showing elapsed time and no composers.",
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

      for (const id of [RUN_B_ID, RUN_A_ID]) {
        const elapsed = page.locator(tileElapsedSelector(id));
        await elapsed.waitFor({ state: "visible", timeout: 10_000 });
        const text = (await elapsed.innerText()).trim();
        ctx.expect(/\d/.test(text), `RUN tile ${id} header elapsed should show a duration, got "${text}"`);
      }
      ctx.expect(
        (await page.locator(tileElapsedSelector(READY_ID)).count()) === 0,
        "READY tile must not show a running elapsed timer",
      );

      const streamElapsed = await page
        .locator('[data-testid="mission-control-agent-grid"] [data-testid="turn-working-elapsed"]')
        .count();
      ctx.expect(streamElapsed === 0, `expected no in-stream elapsed timers, got ${streamElapsed}`);

      for (const id of expectedOrder) {
        const composers = await tileComposerCount(page, id);
        ctx.expect(composers === 0, `fixture ${id} must not show a composer until clicked`);
      }

      return `order=${JSON.stringify(order)} composers=hidden elapsed=header`;
    },
  },
  {
    id: "scroll-unfocused-transcript",
    label: "Scroll an unfocused tile transcript without revealing a composer",
    narrate: "Wheeled the unfocused running tile; the transcript moved and no composer appeared.",
    async run(ctx) {
      const page = ctx.page;
      const hit = await pollFor(
        async () => {
          const value = await tileStreamHit(page, RUN_B_ID);
          return { ok: value.extra > 24, value };
        },
        { timeoutMs: 20_000, description: "RUN_B transcript is tall enough to scroll" },
      );
      ctx.expect(
        !hit.overlayIntercepts,
        `unfocused tile stream must be directly scrollable; activate overlay intercepted the pointer (${JSON.stringify(hit)})`,
      );

      const box = await page.locator(tileSelector(RUN_B_ID)).boundingBox();
      ctx.expect(Boolean(box), "RUN_B tile has a bounding box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.65);
      await page.mouse.wheel(0, 1200);
      const after = await tileStreamHit(page, RUN_B_ID);
      ctx.expect(
        after.top > hit.top,
        `unfocused RUN_B transcript should scroll without a click (before=${hit.top} after=${after.top} extra=${hit.extra})`,
      );
      ctx.expect(
        (await tileComposerCount(page, RUN_B_ID)) === 0,
        "wheeling an unfocused tile must not reveal its composer",
      );
      return `scrolled RUN_B transcript ${hit.top} -> ${after.top}`;
    },
  },
  {
    id: "toggle-composer",
    label: "Click a tile to show its composer, click again to hide it",
    narrate: "Clicked the running tile to reveal the composer, then clicked it again to hide it.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(
        (await tileComposerCount(page, RUN_A_ID)) === 0,
        "RUN_A composer starts hidden",
      );
      await page.locator(tileActivateSelector(RUN_A_ID)).click();
      await page.waitForSelector(tileComposerInputSelector(RUN_A_ID), { timeout: 10_000 });
      ctx.expect(
        (await tileComposerCount(page, RUN_B_ID)) === 0,
        "only the clicked tile may show a composer",
      );
      await page.locator(tileActivateSelector(RUN_A_ID)).click();
      await pollFor(
        async () => {
          const count = await tileComposerCount(page, RUN_A_ID);
          return { ok: count === 0, value: count };
        },
        { timeoutMs: 8_000, description: "RUN_A composer hidden after second click" },
      );
      return "RUN_A composer toggled on then off";
    },
  },

  {
    id: "compose-in-tile",
    label: "Click RUN_A to reveal composer, type, and submit",
    narrate:
      "Clicked a grid tile to reveal its composer, typed a message, and confirmed it rendered in that tile's stream.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(
        (await tileComposerCount(page, RUN_B_ID)) === 0,
        "RUN_B must not show a composer before another tile is clicked",
      );
      await page.locator(tileActivateSelector(RUN_A_ID)).click();
      await page.waitForSelector(tileComposerInputSelector(RUN_A_ID), { timeout: 10_000 });
      ctx.expect(
        (await tileComposerCount(page, RUN_B_ID)) === 0,
        "only the clicked tile may show a composer",
      );
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
    id: "resize-grid",
    label: "Set 1-per-screen and horizontal direction; overscan keeps 2 tiles full",
    narrate:
      "Switched to one tile per screen in horizontal direction; the ready tile stayed windowed out as a placeholder.",
    async run(ctx) {
      const page = ctx.page;

      await page.locator('[data-testid="mission-control-agent-grid-count"]').click();
      const countOne = page.locator('[data-testid="mission-control-agent-grid-count-1"]');
      await countOne.waitFor({ state: "visible", timeout: 5_000 });
      // The menu can render off the viewport when the grid is already full of
      // tiles; force the option rather than fighting the portal position.
      await countOne.click({ force: true });
      await page.locator('[data-testid="mission-control-agent-grid-direction-horizontal"]').click();

      // visibleCount=1 in horizontal direction is a 1x1 shape; one tile of overscan on
      // each side still mounts RUN_A as a full tile alongside the visible RUN_B tile.
      const fullIds = await pollFor(
        async () => {
          const present = [];
          for (const id of [RUN_B_ID, RUN_A_ID, READY_ID]) {
            const count = await page.locator(tileSelector(id)).count();
            if (count > 0) present.push(id);
          }
          const ok =
            present.length === 2 && present.includes(RUN_B_ID) && present.includes(RUN_A_ID);
          return { ok, value: present };
        },
        { timeoutMs: 10_000, description: "exactly RUN_B and RUN_A rendered as full tiles" },
      );

      const readyFull = (await page.locator(tileSelector(READY_ID)).count()) > 0;
      ctx.expect(!readyFull, "READY tile must not be a full tile before scrolling into view");
      const readyPlaceholderCount = await page.locator(tilePlaceholderSelector(READY_ID)).count();
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
      // Other checks/runs may have left extra tiles on a kept stack. Walk the
      // strip one viewport at a time until THIS run's READY tile mounts.
      await pollFor(
        async () => {
          const count = await page.locator(tileSelector(READY_ID)).count();
          if (count > 0) return { ok: true, value: count };
          await scrollLocator.evaluate((el) => {
            const step = Math.max(el.clientWidth, 1);
            const max = Math.max(el.scrollWidth - el.clientWidth, 0);
            el.scrollLeft = Math.min(el.scrollLeft + step, max);
          });
          return { ok: false, value: 0 };
        },
        { timeoutMs: 20_000, intervalMs: 200, description: "READY tile mounted after scroll" },
      );

      ctx.expect(
        (await tileComposerCount(page, READY_ID)) === 0,
        "READY tile must still hide its composer after scrolling into view",
      );

      return "READY tile is a full tile after scrolling";
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
