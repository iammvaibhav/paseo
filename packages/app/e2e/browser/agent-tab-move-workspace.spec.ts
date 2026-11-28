import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

const WIDE_VIEWPORT = { width: 1280, height: 900 };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function centerOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const locator = page.getByTestId(testId).filter({ visible: true }).first();
  await expect(locator).toBeVisible({ timeout: 30_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No bounding box for ${testId}`);
  return box;
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function workspaceIdOfAgent(
  client: SeedDaemonClient,
  agentId: string,
): Promise<string | undefined> {
  const agents = await client.fetchAgents();
  return agents.entries.find((entry) => entry.agent.id === agentId)?.agent.workspaceId;
}

test.describe("agent tab move to another workspace", () => {
  test.describe.configure({ timeout: 240_000 });

  test("drags an agent tab onto a sidebar workspace row and moves the agent", async ({
    page,
  }, testInfo) => {
    const serverId = getServerId();
    const source = await seedWorkspace({ repoPrefix: "tab-move-source-" });
    const target = await seedWorkspace({ repoPrefix: "tab-move-target-" });
    const agent = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Movable agent",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });

    try {
      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoAppShell(page);
      await waitForWorkspaceInSidebar(page, { serverId, workspaceId: source.workspaceId });
      await waitForWorkspaceInSidebar(page, { serverId, workspaceId: target.workspaceId });
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: source.workspaceId });

      const tabBox = await boxOf(page, `workspace-tab-agent_${agent.id}`);
      const rowBox = await boxOf(page, `sidebar-workspace-row-${serverId}:${target.workspaceId}`);
      const tabCenter = centerOf(tabBox);
      const rowCenter = centerOf(rowBox);

      await page.mouse.move(tabCenter.x, tabCenter.y);
      await page.mouse.down();
      // dnd-kit's pointer sensor has an activation distance; the first short
      // move starts the drag, the second carries it onto the sidebar row.
      await page.mouse.move(tabCenter.x + 16, tabCenter.y + 6, { steps: 5 });
      await page.mouse.move(rowCenter.x, rowCenter.y, { steps: 20 });

      const dropIndicator = page
        .getByTestId(`sidebar-workspace-drop-indicator-${serverId}:${target.workspaceId}`)
        .filter({ visible: true })
        .first();
      await expect(dropIndicator).toBeVisible({ timeout: 10_000 });
      await capture(page, testInfo, "agent-tab-drag-over-workspace-row");

      await page.mouse.up();

      await expect
        .poll(() => workspaceIdOfAgent(source.client, agent.id), { timeout: 30_000 })
        .toBe(target.workspaceId);

      await expect(
        page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }),
      ).toHaveCount(0);
      await capture(page, testInfo, "agent-tab-after-move");
    } finally {
      await target.cleanup().catch(() => undefined);
      await source.cleanup().catch(() => undefined);
    }
  });
});
