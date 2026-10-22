export const meta = {
  name: "paseo52-hub-tool-call-rendering",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Hub tool calls render in agent feed with their payload summary and structured details without empty placeholder bars.",
};

export const steps = [
  {
    id: "seed-hub-agent",
    label: "Seed an agent with a Hub tool call",
    narrate: "Agent created and prompted to emit a Hub wait tool call.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: "PASEO-52 Workspace",
      });
      const workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace must have an id");

      const agent = await client.createAgent({
        provider: "mock",
        cwd: ctx.fixtureRepo,
        workspaceId,
        title: "Hub tool call agent",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "emit a hub tool call",
      });

      ctx.workspaceId = workspaceId;
      ctx.agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 15_000);

      return `agent ${agent.id} seeded in workspace ${workspaceId}`;
    },
  },
  {
    id: "assert-hub-feed-rendering",
    label: "Verify Hub tool call badge and details in the agent feed",
    narrate:
      "Checking feed renders Hub tool call with summary and without empty placeholder boxes.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available");

      const agentUrl = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(ctx.workspaceId)}?open=agent:${encodeURIComponent(ctx.agentId)}`;
      await page.goto(agentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Wait for the tool call badge to appear in the feed
      const badge = page.locator('[data-testid="tool-call-badge"]').filter({ hasText: "Hub" });
      await badge.waitFor({ state: "visible", timeout: 20_000 });

      // Capture before shot of the tool call in the feed
      await ctx.shot("before");

      // 1. Assert no empty placeholder bars (empty code surfaces) exist in the feed
      const emptyCodeBlocks = await page
        .locator("[data-code-surface]")
        .evaluateAll(
          (els) => els.filter((el) => !el.textContent || el.textContent.trim().length === 0).length,
        );
      ctx.expect(
        emptyCodeBlocks === 0,
        `Expected 0 empty code block placeholder bars, found ${emptyCodeBlocks}`,
      );

      // 2. Assert that Hub badge renders its payload/summary (wait · bg_14)
      const badgeText = await badge.innerText();
      ctx.expect(
        badgeText.includes("wait") && badgeText.includes("bg_14"),
        `Expected Hub badge to display summary with 'wait' and 'bg_14', got '${badgeText}'`,
      );

      // 3. Click the badge to expand its details
      await badge.click();
      await page.waitForTimeout(500);

      // 4. Assert structured card details are rendered (not raw JSON or empty state)
      const pageText = await page.locator("body").innerText();
      ctx.expect(
        pageText.includes("pnpm run build:daemon-web-ui"),
        "Expected expanded Hub details to display job command 'pnpm run build:daemon-web-ui'",
      );

      // Capture after shot with details expanded
      await ctx.shot("after");

      return "Hub tool call rendered with summary and structured details without empty placeholder bars";
    },
  },
];
