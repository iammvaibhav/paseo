export const meta = {
  name: "ui-sidebar-pinned-agents-every-view",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "A pinned agent shows in the sidebar's Pinned section in the Agents view and in the " +
    "Workspaces view, in both project and status grouping; the Pinned section and the list " +
    "header under it stay pixel-identical across the switch (default and mono themes); " +
    "pressing the agent there opens it.",
};

let pinned = null;
let unpinned = null;
let workspaceId = null;
/** The Agents view's stationary layout, the baseline every other view is compared with. */
let agentsLayout = null;
/** The agents view's first bucket heading, compared with the workspaces view's first project row. */
let agentsHeadingBox = null;

function rowSelector(agentId) {
  return `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${agentId}"]:not([data-testid^="sidebar-agent-view-row-time-"]):not([data-testid^="sidebar-agent-view-row-reminder-"])`;
}

async function pinnedListAgentIds(page, listSelector) {
  return page.evaluate(
    ({ selector, ids }) => {
      const list = document.querySelector(selector);
      if (!list) return null;
      return ids.filter((id) =>
        [...list.querySelectorAll('[data-testid^="sidebar-agent-view-row-"]')].some((node) =>
          node.getAttribute("data-testid").endsWith(id),
        ),
      );
    },
    { selector: listSelector, ids: [pinned.id, unpinned.id] },
  );
}

async function expectOnlyPinnedAgentIn(ctx, listSelector, where) {
  const page = ctx.page;
  await page.waitForSelector(`${listSelector} ${rowSelector(pinned.id)}`, { timeout: 30_000 });
  const ids = await pinnedListAgentIds(page, listSelector);
  ctx.expect(
    Array.isArray(ids) && ids.length === 1 && ids[0] === pinned.id,
    `${where}: expected only the pinned agent in ${listSelector}, got ${JSON.stringify(ids)}`,
  );
}

function round(box) {
  return box
    ? Object.fromEntries(
        Object.entries(box).map(([key, value]) => [key, Math.round(value * 10) / 10]),
      )
    : null;
}

/**
 * What must not move when the view switches: the Pinned section (box, title font, pixels), the
 * pinned agent's row, and the list header row with the view toggle right under the section.
 */
async function stationaryLayout(page, pinnedSectionSelector) {
  // Off the sidebar, so no row or header is drawn hovered.
  await page.mouse.move(900, 500);
  await page.waitForTimeout(400);
  const section = page.locator(`${pinnedSectionSelector}:visible`).first();
  const sectionBox = round(await section.boundingBox());
  const rowBox = round(await section.locator(rowSelector(pinned.id)).first().boundingBox());
  const toggleBox = round(
    await page.locator('[data-testid="sidebar-view-toggle"]:visible').first().boundingBox(),
  );
  const titleFont = await section.evaluate((node) => {
    const title = [...node.querySelectorAll("*")].find(
      (element) => element.childElementCount === 0 && element.textContent.trim() === "Pinned",
    );
    if (!title) return null;
    const style = getComputedStyle(title);
    return `${style.fontSize} ${style.fontWeight} ${style.lineHeight} ${style.color}`;
  });
  const pixels = await page.screenshot({ clip: sectionBox });
  return { sectionBox, rowBox, toggleBox, titleFont, pixels };
}

function expectSameLayout(ctx, actual, where) {
  const describe = ({ pixels: _pixels, ...rest }) => JSON.stringify(rest);
  ctx.expect(
    describe(actual) === describe(agentsLayout),
    `${where} moved: agents ${describe(agentsLayout)} vs ${describe(actual)}`,
  );
  ctx.expect(
    actual.pixels.equals(agentsLayout.pixels),
    `${where}: the Pinned section's pixels differ from the Agents view`,
  );
}

/**
 * The first group heading under the list header: a bucket heading ("Recent") in the agents view,
 * a project row in the workspaces view. The bucket heading mirrors the project row, so both start
 * at the same height and are as tall, and the rows under them start at the same place.
 */
async function firstGroupHeadingBox(page, selector) {
  return round(await page.locator(`${selector}:visible`).first().boundingBox());
}

export const steps = [
  {
    id: "seed",
    label: "Seed one pinned and one unpinned agent",
    narrate: "Two agents in one workspace; only the first is pinned.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: `[${ctx.stack.runId}] pinned agents`,
      });
      workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace must have an id");
      const create = (title) =>
        client.createAgent({
          provider: "mock",
          cwd: ctx.fixtureRepo,
          workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
          initialPrompt: "say hello",
        });
      pinned = await create(`[${ctx.stack.runId}] pinned agent`);
      unpinned = await create(`[${ctx.stack.runId}] unpinned agent`);
      for (const agent of [pinned, unpinned]) {
        await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
      }
      const result = await client.setAgentPinned(pinned.id, true);
      ctx.expect(Boolean(result.pinnedAt), "pin accepted");
      return `pinned ${pinned.id}, unpinned ${unpinned.id}`;
    },
  },
  {
    id: "agents-view",
    label: "Agents view lists the pinned agent under Pinned",
    narrate: "The Agents view shows the pinned agent in its Pinned section.",
    async run(ctx) {
      const page = ctx.page;
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator('[data-testid="sidebar-view-toggle-agents"]').click();
      await expectOnlyPinnedAgentIn(
        ctx,
        '[data-testid="sidebar-agent-view-pinned"]',
        "agents view",
      );
      agentsLayout = await stationaryLayout(page, '[data-testid="sidebar-agent-view-pinned"]');
      agentsHeadingBox = await firstGroupHeadingBox(
        page,
        '[data-testid^="sidebar-agent-view-section-"]:not([data-testid="sidebar-agent-view-section-pinned"])',
      );
      await ctx.shot("before");
      return `agents view shows the pinned agent; layout ${JSON.stringify({ ...agentsLayout, pixels: undefined })}; first heading ${JSON.stringify(agentsHeadingBox)}`;
    },
  },
  {
    id: "workspaces-project-mode",
    label: "Workspaces view (project grouping) lists the pinned agent under Pinned",
    narrate: "Switching to Workspaces keeps the pinned agent at the top, in the Pinned section.",
    async run(ctx) {
      const page = ctx.page;
      await page.locator('[data-testid="sidebar-view-toggle-workspaces"]').click();
      await page.waitForSelector('[data-testid="sidebar-project-workspace-list-scroll"]', {
        timeout: 30_000,
      });
      await expectOnlyPinnedAgentIn(
        ctx,
        '[data-testid="sidebar-pinned-section"]',
        "workspaces view, project grouping",
      );
      expectSameLayout(
        ctx,
        await stationaryLayout(page, '[data-testid="sidebar-pinned-section"]'),
        "workspaces view, project grouping",
      );
      const projectHeadingBox = await firstGroupHeadingBox(
        page,
        '[data-testid^="sidebar-project-row-"]',
      );
      ctx.expect(
        projectHeadingBox?.y === agentsHeadingBox?.y &&
          projectHeadingBox?.height === agentsHeadingBox?.height,
        `first group heading: agents ${JSON.stringify(agentsHeadingBox)} vs project ${JSON.stringify(projectHeadingBox)}`,
      );
      await ctx.shot("workspaces-project");
      return "project grouping shows the pinned agent, laid out exactly as in the agents view";
    },
  },
  {
    id: "workspaces-status-mode",
    label: "Workspaces view (status grouping) lists the pinned agent under Pinned",
    narrate: "Status grouping shows the same pinned agent.",
    async run(ctx) {
      const page = ctx.page;
      await page.evaluate(() => {
        const raw = localStorage.getItem("sidebar-view");
        const parsed = raw ? JSON.parse(raw) : { state: {}, version: 9 };
        parsed.state = { ...parsed.state, viewMode: "workspaces", groupMode: "status" };
        localStorage.setItem("sidebar-view", JSON.stringify(parsed));
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="sidebar-status-list-scroll"]', { timeout: 30_000 });
      await expectOnlyPinnedAgentIn(
        ctx,
        '[data-testid="sidebar-pinned-section"]',
        "workspaces view, status grouping",
      );
      expectSameLayout(
        ctx,
        await stationaryLayout(page, '[data-testid="sidebar-pinned-section"]'),
        "workspaces view, status grouping",
      );
      await ctx.shot("workspaces-status");
      return "status grouping shows the pinned agent, laid out exactly as in the agents view";
    },
  },
  {
    id: "mono-theme",
    label: "In the mono theme the switch leaves the Pinned section untouched too",
    narrate: "Same comparison in the mono theme: nothing above the list moves.",
    async run(ctx) {
      const page = ctx.page;
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ ...settings, theme: "mono" }));
        const raw = localStorage.getItem("sidebar-view");
        const parsed = raw ? JSON.parse(raw) : { state: {}, version: 9 };
        parsed.state = { ...parsed.state, viewMode: "agents", groupMode: "project" };
        localStorage.setItem("sidebar-view", JSON.stringify(parsed));
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectOnlyPinnedAgentIn(
        ctx,
        '[data-testid="sidebar-agent-view-pinned"]',
        "mono agents view",
      );
      agentsLayout = await stationaryLayout(page, '[data-testid="sidebar-agent-view-pinned"]');
      await page.locator('[data-testid="sidebar-view-toggle-workspaces"]').click();
      await expectOnlyPinnedAgentIn(
        ctx,
        '[data-testid="sidebar-pinned-section"]',
        "mono workspaces view",
      );
      expectSameLayout(
        ctx,
        await stationaryLayout(page, '[data-testid="sidebar-pinned-section"]'),
        "mono workspaces view",
      );
      await ctx.shot("mono-workspaces");
      return "mono theme: Pinned section identical across the switch";
    },
  },
  {
    id: "press-opens-agent",
    label: "Pressing the pinned agent in the Workspaces view opens it",
    narrate: "Clicking the pinned agent opens its workspace with the agent.",
    async run(ctx) {
      const page = ctx.page;
      await page
        .locator(`[data-testid="sidebar-pinned-section"] ${rowSelector(pinned.id)}`)
        .first()
        .click();
      await page.waitForURL((url) => url.toString().includes(encodeURIComponent(workspaceId)), {
        timeout: 15_000,
      });
      await ctx.shot("after");
      return `navigated to ${page.url()}`;
    },
  },
];
