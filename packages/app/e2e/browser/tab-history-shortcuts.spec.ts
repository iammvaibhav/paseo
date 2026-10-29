import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { clickNewTerminal, getActiveTabTestId, gotoWorkspace } from "../support/helpers/launcher";
import { installLocalDesktopHost } from "../support/helpers/local-desktop-host";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";

// Cmd+[ / Cmd+] are the macOS bindings; on web the shortcut OS comes from the user agent.
test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});

async function waitForActiveTab(
  page: Page,
  matches: (testId: string) => boolean = () => true,
): Promise<string> {
  await expect
    .poll(
      async () => {
        const active = await getActiveTabTestId(page);
        return active !== null && matches(active);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const active = await getActiveTabTestId(page);
  if (!active) {
    throw new Error("Active tab disappeared");
  }
  return active;
}

async function expectAt(page: Page, workspaceId: string, tabTestId: string): Promise<void> {
  await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), workspaceId));
  await expect.poll(() => getActiveTabTestId(page)).toBe(tabTestId);
}

/**
 * Visits workspace A's two terminals, then workspace B's tab, all inside one app
 * session (a page load would reset the history).
 */
async function visitTabsAcrossWorkspaces(
  page: Page,
  first: SeededWorkspace,
  second: SeededWorkspace,
) {
  await gotoWorkspace(page, first.workspaceId);
  // The first terminal replaces the empty New tab, so make two real tabs.
  await clickNewTerminal(page);
  const firstTerminal = await waitForActiveTab(page, (id) => id.includes("terminal"));
  await clickNewTerminal(page);
  const secondTerminal = await waitForActiveTab(
    page,
    (id) => id.includes("terminal") && id !== firstTerminal,
  );

  await selectWorkspaceInSidebar(page, second.workspaceId);
  await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), second.workspaceId));
  const secondWorkspaceTab = await waitForActiveTab(page);
  return { firstTerminal, secondTerminal, secondWorkspaceTab };
}

async function seedTwoWorkspaces(): Promise<[SeededWorkspace, SeededWorkspace]> {
  return Promise.all([
    seedWorkspace({ repoPrefix: "tab-history-a-", title: "History A" }),
    seedWorkspace({ repoPrefix: "tab-history-b-", title: "History B" }),
  ]);
}

test("Cmd+[ and Cmd+] walk back and forward through tabs across workspaces", async ({ page }) => {
  test.setTimeout(120_000);
  const [first, second] = await seedTwoWorkspaces();

  try {
    const tabs = await visitTabsAcrossWorkspaces(page, first, second);

    // Back crosses into the other workspace and lands on the exact tab, then keeps going
    // with focus inside the terminal.
    await page.keyboard.press("Meta+BracketLeft");
    await expectAt(page, first.workspaceId, tabs.secondTerminal);
    await page.keyboard.press("Meta+BracketLeft");
    await expectAt(page, first.workspaceId, tabs.firstTerminal);

    await page.keyboard.press("Meta+BracketRight");
    await expectAt(page, first.workspaceId, tabs.secondTerminal);
    await page.keyboard.press("Meta+BracketRight");
    await expectAt(page, second.workspaceId, tabs.secondWorkspaceTab);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("desktop Ctrl+Tab toggles recent tabs and Cmd+Shift+[ / ] stay in the workspace", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [first, second] = await seedTwoWorkspaces();
  // Ctrl+Tab and Cmd+Shift+[ / ] are desktop-only bindings.
  await installLocalDesktopHost(page, first.repoPath, { platform: "darwin" });

  try {
    const tabs = await visitTabsAcrossWorkspaces(page, first, second);

    await page.keyboard.press("Control+Tab");
    await expectAt(page, first.workspaceId, tabs.secondTerminal);
    await page.keyboard.press("Control+Tab");
    await expectAt(page, second.workspaceId, tabs.secondWorkspaceTab);
    await page.keyboard.press("Control+Shift+Tab");
    await expectAt(page, first.workspaceId, tabs.firstTerminal);

    await page.keyboard.press("Meta+Shift+BracketRight");
    await expectAt(page, first.workspaceId, tabs.secondTerminal);
    await page.keyboard.press("Meta+Shift+BracketLeft");
    await expectAt(page, first.workspaceId, tabs.firstTerminal);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
