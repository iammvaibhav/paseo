import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { expectWorkspaceAbsentFromSidebar } from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

// The workspace header ⋯ menu archives the workspace it sits on, the same way the sidebar does,
// and leaves the dead workspace route for the project's new-workspace screen.
test.describe("Archive workspace from the workspace header menu", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("header-archive-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  async function openWorktree(page: Page, viewport: { width: number; height: number }) {
    await openProjectViaDaemon(client, tempRepo.path);
    const worktree = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `header-archive-${Date.now()}`,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    const route = buildHostWorkspaceRoute(getServerId(), worktree.workspaceId);
    await page.setViewportSize(viewport);
    await page.goto(route);
    return { ...worktree, route };
  }

  // Wide menus end with the destructive archive row; compact menus use the route-keyed row.
  async function archiveFromHeaderMenu(page: Page, archiveTestId: string) {
    const trigger = page.getByTestId("workspace-header-menu-trigger").filter({ visible: true });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.click();
    const archiveItem = page.getByTestId(archiveTestId).filter({ visible: true });
    await expect(archiveItem).toBeVisible();
    // Enabled once the worktree's dirty/unpushed state has loaded for the risk confirmation.
    await expect(archiveItem).toBeEnabled({ timeout: 30_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await archiveItem.click();
  }

  async function expectArchivedAndRedirected(
    page: Page,
    worktree: { workspaceId: string; workspaceDirectory: string; route: string },
  ) {
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .not.toBe(worktree.route);
    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);
  }

  test("wide header menu archives the open worktree and leaves its route", async ({ page }) => {
    const worktree = await openWorktree(page, { width: 1280, height: 900 });
    await archiveFromHeaderMenu(page, "workspace-header-archive");
    await expectArchivedAndRedirected(page, worktree);
  });

  test("compact header menu archives the open worktree and leaves its route", async ({ page }) => {
    const worktree = await openWorktree(page, { width: 390, height: 844 });
    await archiveFromHeaderMenu(page, "workspace-header-archive-workspace");
    await expectArchivedAndRedirected(page, worktree);
  });
});
