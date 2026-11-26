export const meta = {
  name: "ui-sidebar-pinned-agents-every-view",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "A pinned agent shows in the sidebar's Pinned section in the Agents view and in the " +
    "Workspaces view, in both project and status grouping, and pressing it there opens the agent.",
};

let pinned = null;
let unpinned = null;
let workspaceId = null;

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
      await ctx.shot("before");
      return "agents view shows the pinned agent";
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
      await ctx.shot("workspaces-project");
      return "project grouping shows the pinned agent";
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
      await ctx.shot("workspaces-status");
      return "status grouping shows the pinned agent";
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
