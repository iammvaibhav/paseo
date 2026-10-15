export const meta = {
  name: "ui-sidebar-search",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Asserts the sidebar search finds a closed (dormant) agent by name and id prefix in the " +
    "Agents view, finds archived agents only with Include archived, and shows no engine label.",
};

const WORKSPACE_TITLE = "sidebar-search-workspace";
const CLOSED_TITLE = "Closed search target";
const ARCHIVED_TITLE = "Archived search target";
const CHECK_LABEL_KEY = "paseo.verify-check";
const CHECK_LABEL_VALUE = "ui-sidebar-search";

let workspaceId = null;
let closed = null;
let archived = null;

function commanderProviderModel(ctx) {
  const raw = String(ctx.stack.commanderModel);
  return { provider: raw.split("/")[0], model: raw.replace(/^[^/]+\//, "") };
}

/** No initial prompt: the agent never runs, so the board files it as idle (Dormant). */
async function createIdleAgent(ctx, title) {
  const { provider, model } = commanderProviderModel(ctx);
  return ctx.host().client.createAgent({
    cwd: ctx.host().home,
    workspaceId,
    title,
    provider,
    model,
    modeId: "full",
    labels: { [CHECK_LABEL_KEY]: CHECK_LABEL_VALUE },
  });
}

async function fetchEntry(client, agentId) {
  const res = await client.fetchAgents({
    filter: { labels: { [CHECK_LABEL_KEY]: CHECK_LABEL_VALUE }, includeArchived: true },
  });
  return res.entries.find((entry) => entry.agent.id === agentId) ?? null;
}

function rowSelector(agentId) {
  return `[data-testid^="sidebar-agent-view-row-"][data-testid$="-${agentId}"]:not([data-testid^="sidebar-agent-view-row-time-"])`;
}

async function search(page, query) {
  const input = page.locator('[data-testid="sidebar-search-input"]');
  await input.fill(query);
  // The bar reads Searching… until every host answered.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="sidebar-search-status"]') === null,
    null,
    { timeout: 10_000 },
  );
}

async function visible(page, selector) {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

export const steps = [
  {
    id: "load-app",
    label: "Load web UI and switch the sidebar to the Agents view",
    narrate: "Web UI loaded and the sidebar switched to the agent list.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector('[data-testid="sidebar-search-toggle"]', { timeout: 15_000 });
      const toggle = page.locator('[data-testid="sidebar-view-toggle-agents"]');
      if (await toggle.isVisible({ timeout: 2_000 }).catch(() => false)) await toggle.click();
      return "agents view open";
    },
  },
  {
    id: "create-agents",
    label: "Create an idle (dormant) agent and an archived agent",
    narrate: "Two agents created over RPC; the second one archived.",
    async run(ctx) {
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: ctx.host().home },
        title: WORKSPACE_TITLE,
      });
      workspaceId = created.workspace?.id;
      ctx.expect(Boolean(workspaceId), "Workspace created via RPC");

      closed = await createIdleAgent(ctx, CLOSED_TITLE);
      archived = await createIdleAgent(ctx, ARCHIVED_TITLE);
      await client.archiveAgent(archived.id);

      const closedEntry = await fetchEntry(client, closed.id);
      const archivedEntry = await fetchEntry(client, archived.id);
      ctx.expect(
        closedEntry?.agent.bucket === "idle",
        `closed agent bucket idle, got ${closedEntry?.agent.bucket}`,
      );
      ctx.expect(Boolean(archivedEntry?.agent.archivedAt), "archived agent carries archivedAt");
      ctx.expect(Boolean(closed.name && archived.name), "both agents have generated names");
      return `closed ${closed.name} (${closed.id}), archived ${archived.name} (${archived.id})`;
    },
  },
  {
    id: "dormant-hidden-while-browsing",
    label: "The idle agent is not listed while browsing",
    narrate: "Without a search the dormant agent stays out of the Agents view.",
    async run(ctx) {
      await ctx.page.waitForTimeout(1_500);
      ctx.expect(
        !(await visible(ctx.page, rowSelector(closed.id))),
        "dormant row hidden while browsing",
      );
      await ctx.shot("before");
      return "dormant row hidden";
    },
  },
  {
    id: "search-by-name",
    label: "Search the closed agent by name, then by id prefix",
    narrate: "Typing the agent's name, then its id prefix, lists it under Done.",
    async run(ctx) {
      const page = ctx.page;
      await page.locator('[data-testid="sidebar-search-toggle"]').click();
      await search(page, closed.name);
      await page.waitForSelector(rowSelector(closed.id), { timeout: 10_000 });
      ctx.expect(
        await visible(page, '[data-testid="sidebar-agent-view-section-done"]'),
        "closed match listed under the Done section",
      );
      const panelText = await page.locator('[data-testid="sidebar-search-panel"]').innerText();
      ctx.expect(!/jev/i.test(panelText), `search panel shows no engine label, got "${panelText}"`);

      await search(page, closed.id.slice(0, 8));
      await page.waitForSelector(rowSelector(closed.id), { timeout: 10_000 });
      await ctx.shot("after");
      return `found by name "${closed.name}" and id prefix ${closed.id.slice(0, 8)}`;
    },
  },
  {
    id: "archived-opt-in",
    label: "Archived agent matches only with Include archived",
    narrate: "The archived agent stays hidden until Include archived, then lists under the bar.",
    async run(ctx) {
      const page = ctx.page;
      await search(page, archived.name);
      await page.waitForSelector('[data-testid="sidebar-search-empty-state"]', { timeout: 10_000 });

      await page.locator('[data-testid="sidebar-search-include-archived"]').click();
      await page.waitForSelector(`[data-testid="sidebar-search-archived-${archived.id}"]`, {
        timeout: 10_000,
      });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="sidebar-search-status"]') === null,
        null,
        { timeout: 10_000 },
      );
      ctx.expect(
        !(await visible(page, '[data-testid="sidebar-search-empty-state"]')),
        "no 'No agents match' while an archived match is listed",
      );
      await ctx.shot("archived");
      return `archived ${archived.name} listed only with Include archived`;
    },
  },
  {
    id: "cleanup",
    label: "Archive the created agents (best effort)",
    narrate: "Cleaned up the agents created for this check.",
    async run(ctx) {
      try {
        if (closed) await ctx.host().client.archiveAgent(closed.id);
      } catch {
        // Best-effort cleanup only.
      }
      return "cleanup done";
    },
  },
];
