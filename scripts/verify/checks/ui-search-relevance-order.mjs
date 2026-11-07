export const meta = {
  name: "ui-search-relevance-order",
  tier: "ui",
  hosts: 1,
  video: false,
  description:
    "Sidebar search for 'traffic flow' lists one ranked Results section: an older agent whose " +
    "title holds the exact query renders above a newer agent that matched only by its description.",
};

const CHECK_LABEL_KEY = "paseo.verify-check";
const CHECK_LABEL_VALUE = "ui-search-relevance-order";
const QUERY = "traffic flow";
const UUID_SUFFIX = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ROW_PART_PREFIX =
  /^sidebar-agent-view-row-(time|reminder|menu|open|copy|stop|mark|clear|archive)-/;

let target = null;
let decoy = null;

function commanderProviderModel(ctx) {
  const raw = String(ctx.stack.commanderModel);
  return { provider: raw.split("/")[0], model: raw.replace(/^[^/]+\//, "") };
}

/** No initial prompt: the agent never runs, so the board files it as idle (Dormant). */
async function createIdleAgent(ctx, workspaceId, title) {
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

/** Agent ids of the agent view's rows in DOM order. */
async function renderedOrder(page) {
  const testIds = await page.$$eval('[data-testid^="sidebar-agent-view-row-"]', (nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  return testIds
    .filter((id) => id && !ROW_PART_PREFIX.test(id))
    .map((id) => UUID_SUFFIX.exec(id)?.[1])
    .filter(Boolean);
}

export const steps = [
  {
    id: "create-agents",
    label: "Create an exact-title target, then a newer description-only decoy",
    narrate:
      "The target's title says traffic flow; a newer decoy mentions traffic only in its description.",
    async run(ctx) {
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: ctx.host().home },
        title: "search-relevance-workspace",
      });
      const workspaceId = created.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace created");
      target = await createIdleAgent(
        ctx,
        workspaceId,
        "MacBook traffic flow: Zscaler vs Tailscale",
      );
      // Strictly newer, so recency alone would list the decoy first.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      decoy = await createIdleAgent(ctx, workspaceId, "Wake host using existing scripts");
      await client.updateAgent(decoy.id, {
        shortDescription: "host traffic isn't flowing after wake",
      });
      return `target ${target.id}, decoy ${decoy.id}`;
    },
  },
  {
    id: "host-ranking",
    label: "agent.search.request ranks the exact-title target first",
    narrate: "The host ranks the title match first.",
    async run(ctx) {
      const payload = await ctx.host().client.searchAgents({ query: QUERY });
      const ids = payload.matches.map((match) => match.agentId);
      const t = ids.indexOf(target.id);
      const d = ids.indexOf(decoy.id);
      ctx.expect(t !== -1 && d !== -1, `both matched (target ${t}, decoy ${d})`);
      ctx.expect(t < d, `host ranks target before decoy (target ${t}, decoy ${d})`);
      return `host order: target #${t + 1}, decoy #${d + 1}`;
    },
  },
  {
    id: "ui-order",
    label: "Agents view lists the exact-title target above the decoy under Results",
    narrate: "The sidebar lists the title match first, in one Results section.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page available");
      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector('[data-testid="sidebar-search-toggle"]', { timeout: 15_000 });
      await page.locator('[data-testid="sidebar-view-toggle-agents"]').click();
      await page.locator('[data-testid="sidebar-search-toggle"]').click();
      await page.locator('[data-testid="sidebar-search-input"]').fill(QUERY);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="sidebar-search-status"]') === null,
        null,
        { timeout: 10_000 },
      );
      await page.waitForSelector(`[data-testid$="-${target.id}"]`, { timeout: 10_000 });
      await page.waitForSelector(`[data-testid$="-${decoy.id}"]`, { timeout: 10_000 });
      await ctx.shot("after");
      ctx.expect(
        (await page.locator('[data-testid="sidebar-agent-view-section-results"]').count()) === 1,
        "matches listed in one Results section",
      );
      const order = await renderedOrder(page);
      const t = order.indexOf(target.id);
      const d = order.indexOf(decoy.id);
      ctx.expect(t !== -1 && d !== -1, `both rendered (target ${t}, decoy ${d})`);
      ctx.expect(t < d, `UI renders target before decoy (target #${t + 1}, decoy #${d + 1})`);
      return `rendered target #${t + 1}, decoy #${d + 1}`;
    },
  },
];
