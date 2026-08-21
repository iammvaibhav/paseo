import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The mock provider's `emit an eval tool call` scenario mirrors a real Oh My Pi
// eval result: three cells, a `display()` value, an inline image and a notice.
test("renders an eval tool call as code cells with their output", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "eval-tool-call-",
    title: "Eval tool call",
    model: "ten-second-stream",
  });

  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await agent.client.sendAgentMessage(agent.agentId, "emit an eval tool call");

    const badge = page.getByTestId("tool-call-badge").filter({ hasText: "Eval" }).first();
    await expect(badge).toBeVisible();
    // The collapsed row names the cell instead of leaving a bare "Eval".
    await expect(badge).toContainText("load config");

    await badge.click();
    // Code, per-cell output, the display() value and the notice all render.
    await expect(badge).toContainText("json.loads");
    await expect(badge).toContainText("2 dependencies");
    await expect(badge).toContainText("@getpaseo/protocol");
    await expect(badge).toContainText("Ruby backend is disabled");
    // Failed cell keeps its traceback and exit code.
    await expect(badge).toContainText("RuntimeError: kernel is busy");
    await expect(badge).toContainText("exit 1");
    // Per-cell language and duration.
    await expect(badge).toContainText("python");
    await expect(badge).toContainText("128ms");
    await expect(badge).toContainText("1.8s");
    // The image only exists in the detail payload, never in the text output.
    const image = badge.locator('img[src^="data:image/png;base64,"]');
    await expect(image).toHaveCount(1);
    // expo-image is not unistyles-aware, so it collapses to 0px unless the
    // parent View gives it a box. Decode width proves the payload survived too.
    const imageBox = await image.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      naturalWidth: (el as HTMLImageElement).naturalWidth,
    }));
    expect(imageBox.height).toBeGreaterThan(100);
    expect(imageBox.naturalWidth).toBe(480);
    // The raw envelope must not leak through the generic JSON fallback.
    await expect(badge).not.toContainText("jsonOutputs");

    await testInfo.attach("eval-tool-call", {
      body: await badge.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await agent.cleanup();
  }
});
