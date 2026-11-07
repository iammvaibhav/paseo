import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectNewWorkspaceProjectSelected,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Long enough to name a place ("on dev", "new project") so any prompt-driven
// placement would have fired; the old routing fired from 15 characters.
const PROMPT = "Fix the flaky login test in the billing service on dev as a new project";

// The composer text must never leave the browser before Create. Any
// session request carrying the draft (routing.suggest or a future
// classifier) is prompt inference; record every request type sent.
function recordSessionRequestTypes(page: Page): string[] {
  const types: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      try {
        const envelope = JSON.parse(frame.payload) as { message?: { type?: unknown } };
        if (typeof envelope.message?.type === "string") types.push(envelope.message.type);
      } catch {
        /* Binary terminal traffic is not a JSON request. */
      }
    }),
  );
  return types;
}

test.describe("New workspace composer: no prompt inference while typing", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "no-prompt-inference-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("typing sends no placement request and Create keeps the picked project", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const sent = recordSessionRequestTypes(page);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    await expectNewWorkspaceProjectSelected(page, workspace.projectDisplayName);

    const composer = page.getByRole("textbox", { name: "Message agent..." });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    const typingStartedAt = sent.length;
    await composer.pressSequentially(PROMPT, { delay: 15 });
    await expect(composer).toHaveValue(PROMPT);
    // Well past the old 0.2 s typing pause plus a jev round trip.
    await page.waitForTimeout(1_500);

    const sentWhileTyping = sent.slice(typingStartedAt);
    expect(sentWhileTyping.filter((type) => type.startsWith("routing."))).toEqual([]);
    // Nothing moved the project the user picked.
    await expectNewWorkspaceProjectSelected(page, workspace.projectDisplayName);
    await expect(page.getByTestId("agent-mode-picker-trigger")).toContainText("Build");

    await page.getByTestId("message-input-root").getByRole("button", { name: "Create" }).click();
    const agentTab = page.locator('[data-testid^="workspace-tab-agent_"]').filter({
      visible: true,
    });
    await expect(agentTab).toHaveCount(1, { timeout: 60_000 });
    await expect(
      page.getByTestId("workspace-header-subtitle").filter({ visible: true }).first(),
    ).toHaveText(workspace.projectDisplayName, { timeout: 30_000 });
    expect(sent.filter((type) => type.startsWith("routing.suggest"))).toEqual([]);
  });
});
