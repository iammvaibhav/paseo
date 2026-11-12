export const meta = {
  name: "ui-approach-picker-options",
  tier: "ui",
  hosts: 1,
  video: false,
  description:
    "The composer's Approach picker lists only Build, Orchestrate, Research, in that order; " +
    "search narrows within those three; picking Orchestrate updates the chip.",
};

const OPTION_PREFIX = "agent-mode-option-";
const EXPECTED_IDS = ["solo", "orchestrator", "research"];

/** Approach option ids in DOM order. */
async function renderedOptionIds(page) {
  const testIds = await page.$$eval(`[data-testid^="${OPTION_PREFIX}"]`, (nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  return testIds.map((id) => id.slice("agent-mode-option-".length));
}

export const steps = [
  {
    id: "seed-agent",
    label: "Create an idle agent on the Research approach",
    narrate: "An idle agent starts on the Research approach.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: "approach-picker-workspace",
      });
      const workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace created");
      const agent = await client.createAgent({
        provider: "mock",
        cwd: ctx.fixtureRepo,
        workspaceId,
        title: "Approach picker options",
        modeId: "load-test",
        model: "e2e-fast-stream",
        agentMode: "research",
      });
      ctx.workspaceId = workspaceId;
      ctx.agentId = agent.id;
      return `agent ${agent.id} in workspace ${workspaceId}`;
    },
  },
  {
    id: "picker-options",
    label: "Approach picker lists Build, Orchestrate, Research only",
    narrate: "The picker offers Build, Orchestrate, and Research.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page available");
      const url = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(ctx.workspaceId)}?open=agent:${encodeURIComponent(ctx.agentId)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const chip = page.locator('[data-testid="agent-controls-agent-mode"]:visible').first();
      await chip.waitFor({ state: "visible", timeout: 30_000 });
      ctx.expect((await chip.innerText()).includes("Research"), "chip shows Research");
      await chip.click();
      await page.waitForSelector(`[data-testid="${OPTION_PREFIX}solo"]`, { timeout: 10_000 });
      await ctx.shot("after");
      const ids = await renderedOptionIds(page);
      ctx.expect(
        JSON.stringify(ids) === JSON.stringify(EXPECTED_IDS),
        `options are ${EXPECTED_IDS.join(", ")} (got ${ids.join(", ")})`,
      );
      return `options: ${ids.join(", ")}`;
    },
  },
  {
    id: "picker-search",
    label: "Search filters within the three approaches",
    narrate: "Searching finds Research, and nothing for Debug.",
    async run(ctx) {
      const page = ctx.page;
      const search = page.getByPlaceholder("Search approaches...");
      await search.fill("re");
      await page.waitForFunction(
        (prefix) => document.querySelectorAll(`[data-testid^="${prefix}"]`).length === 1,
        OPTION_PREFIX,
        { timeout: 5_000 },
      );
      const reIds = await renderedOptionIds(page);
      ctx.expect(reIds.join() === "research", `'re' matches Research only (got ${reIds})`);
      await search.fill("debug");
      await page.waitForFunction(
        (prefix) => document.querySelectorAll(`[data-testid^="${prefix}"]`).length === 0,
        OPTION_PREFIX,
        { timeout: 5_000 },
      );
      await search.fill("");
      return "'re' → research; 'debug' → none";
    },
  },
  {
    id: "picker-switch",
    label: "Picking Orchestrate updates the agent and the chip",
    narrate: "Choosing Orchestrate switches the approach.",
    async run(ctx) {
      const page = ctx.page;
      await page.locator(`[data-testid="${OPTION_PREFIX}orchestrator"]`).click();
      const chip = page.locator('[data-testid="agent-controls-agent-mode"]:visible').first();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="agent-controls-agent-mode"]')].some((node) =>
            node.textContent?.includes("Orchestrate"),
          ),
        null,
        { timeout: 10_000 },
      );
      const fetched = await ctx.host().client.fetchAgent(ctx.agentId);
      const agentMode = fetched?.agent.agentMode;
      ctx.expect(agentMode === "orchestrator", `agent mode is orchestrator (got ${agentMode})`);
      return `chip: ${(await chip.innerText()).trim()}`;
    },
  },
];
