export const meta = {
  name: "ui-turn-footer-no-second-opinion",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "A finished turn's footer has no Second opinion button, and its fork menu, jump-to-prompt button and timing label still work.",
};

const SECOND_OPINION_TRIGGER = '[data-testid="second-opinion-menu-trigger"]';
const FORK_TRIGGER = '[data-testid="assistant-fork-menu-trigger"]';
const FORK_CONTENT = '[data-testid="assistant-fork-menu-content"]';
const JUMP_BUTTON = '[data-testid="jump-to-user-message-button"]';
const TIMING_LABEL = '[data-testid="turn-footer-timing-label"]';

export const steps = [
  {
    id: "seed-finished-turn",
    label: "Seed an agent with one finished turn",
    narrate: "Creating an agent and waiting for its first turn to finish.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: `[${ctx.stack.runId}] turn footer`,
      });
      const workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace must have an id");

      const agent = await client.createAgent({
        provider: "mock",
        cwd: ctx.fixtureRepo,
        workspaceId,
        title: `[${ctx.stack.runId}] turn footer agent`,
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "say hello",
      });
      ctx.workspaceId = workspaceId;
      ctx.agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
      return `agent ${agent.id} idle in workspace ${workspaceId}`;
    },
  },
  {
    id: "assert-footer",
    label: "Finished turn footer has no Second opinion button",
    narrate: "The finished turn shows copy, fork and jump actions, and no Second opinion button.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available");

      const agentUrl = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(ctx.workspaceId)}?open=agent:${encodeURIComponent(ctx.agentId)}`;
      await page.goto(agentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // The fork trigger only renders in a completed turn footer, so its presence proves the
      // footer we are inspecting is the finished-turn one.
      await page.locator(`${FORK_TRIGGER}:visible`).first().waitFor({ timeout: 20_000 });
      await page.locator(`${TIMING_LABEL}:visible`).first().waitFor({ timeout: 10_000 });
      await ctx.shot("before");

      const secondOpinionCount = await page.locator(SECOND_OPINION_TRIGGER).count();
      ctx.expect(
        secondOpinionCount === 0,
        `expected no Second opinion trigger, found ${secondOpinionCount}`,
      );
      const labelled = await page.locator('[aria-label="Second opinion"]').count();
      ctx.expect(labelled === 0, `expected no "Second opinion" control, found ${labelled}`);
      return "finished turn footer renders without the Second opinion button";
    },
  },
  {
    id: "other-actions-work",
    label: "Fork menu and jump-to-prompt still work",
    narrate: "The fork menu opens, and the jump to prompt button is still there and clickable.",
    async run(ctx) {
      const page = ctx.page;
      await page.locator(`${FORK_TRIGGER}:visible`).first().click();
      await page.locator(`${FORK_CONTENT}:visible`).first().waitFor({ timeout: 10_000 });
      await ctx.shot("fork-menu-open");
      await page.keyboard.press("Escape");
      await page.locator(`${FORK_CONTENT}:visible`).first().waitFor({
        state: "hidden",
        timeout: 10_000,
      });

      const jump = page.locator(`${JUMP_BUTTON}:visible`).first();
      await jump.waitFor({ timeout: 10_000 });
      await jump.click();
      await ctx.shot("after");
      return "fork menu opened and closed; jump-to-prompt button clicked";
    },
  },
];
