export const meta = {
  name: "ui-mission-control-proof",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Drives web UI to Mission Control, takes before/after shots, and asserts UI updates upon workspace creation.",
};

const WORKSPACE_TITLE = "proof-ui-workspace";
const WORKSPACE_ROW_SELECTOR = '[data-testid^="sidebar-workspace-row-"]';

let rowsBefore = 0;
let createdWorkspaceId = null;

export const steps = [
  {
    id: "load-app",
    label: "Load web UI and connect to daemon",
    narrate: "Web UI loaded in Chromium and connected to loopback daemon.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");

      await page.goto(host.httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      // Wait for app root or sidebar element to be present
      await page.waitForSelector(
        '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
        {
          timeout: 10_000,
        },
      );

      return `app loaded from ${host.httpUrl}`;
    },
  },
  {
    id: "navigate-mission-control",
    label: "Navigate to Mission Control surface",
    narrate: "Mission Control surface opened in web UI.",
    async run(ctx) {
      const page = ctx.page;
      const mcButton = page.locator('[data-testid="sidebar-mission-control"]');
      if (await mcButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await mcButton.click();
      }

      // A fresh stack legitimately has zero workspace rows, so counting immediately is correct;
      // waiting for the selector here would burn the full timeout on every clean run.
      rowsBefore = await page.locator(WORKSPACE_ROW_SELECTOR).count();
      const titleVisibleBefore = (await page.content()).includes(WORKSPACE_TITLE);
      ctx.expect(
        !titleVisibleBefore,
        `"${WORKSPACE_TITLE}" must not be in the DOM before it is created`,
      );

      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");
      return `Mission Control surface active, ${rowsBefore} workspace row(s) before change`;
    },
  },
  {
    id: "trigger-observable-change",
    label: "Create workspace over daemon RPC",
    narrate: "Workspace created over RPC; observing UI reflection.",
    async run(ctx) {
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        path: ctx.host().home,
        name: WORKSPACE_TITLE,
      });
      createdWorkspaceId = created.workspace?.id;
      ctx.expect(Boolean(createdWorkspaceId), "Workspace created via RPC");

      // The sidebar row id is `sidebar-workspace-row-<serverId>:<workspaceId>`, so match on the
      // workspace id suffix and let the daemon own the server id.
      const page = ctx.page;
      await page.waitForSelector(`[data-testid$=":${createdWorkspaceId}"]`, {
        state: "attached",
        timeout: 10_000,
      });

      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");
      return `workspace ${createdWorkspaceId} created and rendered in sidebar`;
    },
  },
  {
    id: "assert-ui-state",
    label: "Assert UI state reflects change",
    narrate: "Observed state verified against UI tree.",
    async run(ctx) {
      const page = ctx.page;

      const row = page.locator(`[data-testid$=":${createdWorkspaceId}"]`);
      ctx.expect((await row.count()) === 1, `exactly one sidebar row for ${createdWorkspaceId}`);

      const testId = await row.first().getAttribute("data-testid");
      ctx.expect(
        typeof testId === "string" && testId.startsWith("sidebar-workspace-row-"),
        `row testid must be a sidebar workspace row, got "${testId}"`,
      );

      // Never assert on the total row count: the mock runs a live Commander whose system
      // workspace can appear at any moment. Own the one row this check created and nothing else.
      const rowsAfter = await page.locator(WORKSPACE_ROW_SELECTOR).count();
      ctx.expect(
        rowsAfter >= rowsBefore + 1,
        `expected at least ${rowsBefore + 1} workspace rows, got ${rowsAfter}`,
      );
      const bodyText = await page.evaluate(() => document.body.innerText);
      ctx.expect(
        bodyText.includes(WORKSPACE_TITLE),
        `"${WORKSPACE_TITLE}" must be rendered as visible text`,
      );

      return `row ${testId} present, visible title rendered, rows ${rowsBefore} -> ${rowsAfter}`;
    },
  },
];
