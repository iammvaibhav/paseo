export const meta = {
  name: "ui-approach-picker-options",
  tier: "ui",
  hosts: 1,
  video: false,
  description:
    "The composer's Approach picker lists only Build, Orchestrate, Research, in that order; " +
    "search narrows within those three; picking Orchestrate updates the chip. A new-agent " +
    "draft shows the picker too, and the agent it creates starts on the picked approach.",
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
  {
    id: "draft-picker",
    label: "New-agent draft composer shows the Approach picker on Build",
    narrate: "A new agent draft shows the Approach chip, starting on Build.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      // The draft needs a model to send; remember the mock one like a returning user.
      await page.evaluate(() =>
        localStorage.setItem(
          "@paseo:create-agent-preferences",
          JSON.stringify({
            provider: "mock",
            providerPreferences: { mock: { model: "e2e-fast-stream" } },
          }),
        ),
      );
      const url = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(ctx.workspaceId)}?open=${encodeURIComponent("draft:verify-approach-draft")}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const chip = page.locator('[data-testid="agent-controls-agent-mode"]:visible').first();
      await chip.waitFor({ state: "visible", timeout: 30_000 });
      ctx.expect((await chip.innerText()).includes("Build"), "draft chip starts on Build");
      await chip.click();
      await page.waitForSelector(`[data-testid="${OPTION_PREFIX}research"]`, { timeout: 10_000 });
      const ids = await renderedOptionIds(page);
      ctx.expect(
        JSON.stringify(ids) === JSON.stringify(EXPECTED_IDS),
        `draft options are ${EXPECTED_IDS.join(", ")} (got ${ids.join(", ")})`,
      );
      await page.locator(`[data-testid="${OPTION_PREFIX}research"]`).click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="agent-controls-agent-mode"]')].some((node) =>
            node.textContent?.includes("Research"),
          ),
        null,
        { timeout: 10_000 },
      );
      await ctx.shot("draft");
      return "draft chip: Build → Research";
    },
  },
  {
    id: "draft-create",
    label: "Sending the draft creates an agent on the picked approach",
    narrate: "The agent created from the draft starts on Research.",
    async run(ctx) {
      const page = ctx.page;
      const client = ctx.host().client;
      const input = page.locator("textarea:visible").first();
      await input.fill("approach draft check");
      await input.press("Enter");
      const deadline = Date.now() + 20_000;
      let created = null;
      while (!created && Date.now() < deadline) {
        const payload = await client.fetchAgents({ scope: "active" });
        const agents = payload.entries.map((entry) => entry.agent);
        created = agents.find(
          (agent) => agent.id !== ctx.agentId && agent.workspaceId === ctx.workspaceId,
        );
        if (!created) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      ctx.expect(Boolean(created), "draft created an agent in the workspace");
      ctx.expect(
        created.agentMode === "research",
        `created agent's approach is research (got ${created.agentMode})`,
      );
      return `agent ${created.id} agentMode=${created.agentMode}`;
    },
  },
];
