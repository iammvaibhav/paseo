export const meta = {
  name: "paseo53-duplicate-down-arrows",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Agent chat renders exactly one scroll-to-bottom down arrow affordance positioned cleanly above composer clearance when scrolled away from the tail.",
};

export const steps = [
  {
    id: "seed-chat-agent",
    label: "Seed an agent with multiple chat messages",
    narrate: "Creating a test agent with a multi-message transcript in a test workspace.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: "PASEO-53 Workspace",
      });
      const workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace must have an id");

      const agent = await client.createAgent({
        provider: "mock",
        cwd: ctx.fixtureRepo,
        workspaceId,
        title: "PASEO-53 Down Arrows Test",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "emit 20 assistant messages before synthetic user message",
      });

      ctx.workspaceId = workspaceId;
      ctx.agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);

      return `agent ${agent.id} seeded in workspace ${workspaceId}`;
    },
  },
  {
    id: "assert-single-down-arrow",
    label: "Verify exactly one scroll-to-bottom down arrow is rendered",
    narrate:
      "Checking that scrolling away from the bottom renders only a single down arrow button.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available");

      const agentUrl = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(ctx.workspaceId)}?open=agent:${encodeURIComponent(ctx.agentId)}`;
      await page.goto(agentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      const chatScroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      await chatScroll.waitFor({ state: "visible", timeout: 20_000 });

      // Ensure assistant messages are loaded
      await page
        .locator('[data-testid="assistant-message"]')
        .first()
        .waitFor({ state: "visible", timeout: 20_000 });

      // Initially at bottom, no scroll-to-bottom affordance should be visible
      const initialButtons = page.locator('[data-testid="scroll-to-bottom-button"]');
      const initialCount = await initialButtons.count();
      ctx.expect(
        initialCount === 0,
        `Expected 0 scroll-to-bottom buttons at bottom, found ${initialCount}`,
      );

      // Scroll up away from bottom
      const box = await chatScroll.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -2000);
      }
      await chatScroll.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      });

      // Wait for button to be visible
      const buttons = page.locator('[data-testid="scroll-to-bottom-button"]');
      await buttons.first().waitFor({ state: "visible", timeout: 10_000 });

      // Capture before shot of the arrow region
      await ctx.shot("before");

      // Assert that EXACTLY 1 scroll-to-bottom button exists
      const buttonCount = await buttons.count();
      ctx.expect(
        buttonCount === 1,
        `Expected exactly 1 scroll-to-bottom down arrow button, found ${buttonCount}`,
      );

      // Verify clicking the single button scrolls back to bottom and hides the affordance
      await buttons.first().click();
      await page.waitForTimeout(600);

      const afterCount = await page.locator('[data-testid="scroll-to-bottom-button"]').count();
      ctx.expect(
        afterCount === 0,
        `Expected 0 buttons after scrolling to bottom, found ${afterCount}`,
      );

      // Capture after shot back at bottom
      await ctx.shot("after");

      return "Agent chat renders exactly 1 down arrow button when scrolled away from bottom";
    },
  },
];
