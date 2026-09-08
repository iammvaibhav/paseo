import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  name: "paseo45-ui-vscode-diff",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Clicking a changed file in the desktop Changes tree opens VS Code Web's diff via the " +
    "paseo-bridge instead of the in-app working diff panel.",
};

function repoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo45-ui-vscode-diff-${ctx.stack.runId}`);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

export const steps = [
  {
    id: "code-server-healthy",
    label: "code-server is configured and healthy on this host",
    narrate: "code-server must be healthy for VS Code Web diff opening to be observable.",
    async run(ctx) {
      ctx.expect(
        Boolean(ctx.stack.codeServer?.healthy),
        `stack.codeServer must be healthy to verify VS Code Web diff opening; got ` +
          `${JSON.stringify(ctx.stack.codeServer)}. Re-run stack up without --no-code-server, ` +
          `or configure ~/.config/code-server/config.yaml on this host.`,
      );
      return `code-server healthy at ${ctx.stack.codeServer.url}`;
    },
  },
  {
    id: "build-fixture-and-workspace",
    label: "Build a one-file-changed fixture repo and create its workspace",
    narrate: "Fixture repo with a tracked, modified file backs a directory workspace.",
    async run(ctx) {
      const repoDir = repoDirFor(ctx);
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init", "-b", "main"]);
      git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
      git(repoDir, ["config", "user.name", "Paseo Verify"]);
      git(repoDir, ["config", "commit.gpgsign", "false"]);
      fs.writeFileSync(path.join(repoDir, "changed.ts"), "export const value = 1;\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "initial fixture commit"]);
      fs.writeFileSync(path.join(repoDir, "changed.ts"), "export const value = 2;\n");

      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repoDir },
        title: "paseo45-ui-vscode-diff",
      });
      ctx.expect(!created.error, `Workspace create failed: ${created.error}`);
      ctx.expect(Boolean(created.workspace?.id), "Workspace has an id");
      ctx.uiWorkspaceId = created.workspace.id;
      return `workspace ${ctx.uiWorkspaceId} at ${repoDir} with one modified tracked file`;
    },
  },
  {
    id: "load-app-with-desktop-shim",
    label: "Load web UI under an Electron desktop shim",
    narrate: "Web UI loaded with window.paseoDesktop present so getIsElectron() reports true.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");

      // The app gates every desktop-only affordance (including VS Code Web diff
      // opening) behind getIsElectron(), which just checks window.paseoDesktop.
      // Any bridge call the app probes resolves to undefined instead of throwing.
      await page.addInitScript(() => {
        window.paseoDesktop = new Proxy(
          { platform: "linux" },
          {
            get: (target, key) =>
              key in target
                ? target[key]
                : new Proxy(
                    () => Promise.resolve(undefined),
                    { get: () => () => Promise.resolve(undefined) },
                  ),
          },
        );
      });

      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForSelector(
        '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
        { state: "attached", timeout: 25_000 },
      );
      return `app loaded from ${ctx.host().httpUrl} under desktop shim`;
    },
  },
  {
    id: "open-workspace-changes-tree",
    label: "Navigate to the workspace and open its Changes tree",
    narrate: "Changes tree opened for the created workspace; before shot captured.",
    async run(ctx) {
      const page = ctx.page;
      const row = page.locator(`[data-testid$=":${ctx.uiWorkspaceId}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.click();

      const newTabPanel = page.locator('[data-testid="workspace-new-tab-panel"]');
      const changesTree = page.locator('[data-testid="changes-tree-panel"]');
      await Promise.race([
        newTabPanel.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
        changesTree.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
      ]);

      if (await newTabPanel.isVisible().catch(() => false)) {
        await page.locator('[data-testid="workspace-new-tab-changes"]').click();
      }

      await page.waitForSelector('[data-testid="changes-file-tree"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="diff-tree-file-0"]', { timeout: 10_000 });

      ctx.expect(
        (await page.locator('[data-testid="working-diff-panel"]').count()) === 0,
        "working-diff-panel must not be open before clicking the changed file",
      );

      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Before shot captured");
      return "Changes tree open with the modified file listed";
    },
  },
  {
    id: "click-file-opens-vscode-web-not-inline-diff",
    label: "Clicking the changed file opens VS Code Web instead of the inline diff panel",
    narrate: "File click routes to a VS Code Web browser tab, not the working diff panel.",
    async run(ctx) {
      const page = ctx.page;
      await page.locator('[data-testid="diff-tree-file-0"]').click();

      const deadline = Date.now() + 5000;
      let workingDiffVisible = false;
      let browserTabVisible = false;
      while (Date.now() < deadline) {
        workingDiffVisible = (await page.locator('[data-testid="working-diff-panel"]').count()) > 0;
        browserTabVisible =
          (await page.locator('[data-testid^="workspace-tab-browser_"]').count()) > 0;
        if (workingDiffVisible || browserTabVisible) break;
        await page.waitForTimeout(200);
      }

      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");

      ctx.expect(
        !workingDiffVisible,
        "working-diff-panel must not appear; clicking a changed file must open VS Code Web instead",
      );
      ctx.expect(
        browserTabVisible,
        "Expected a VS Code Web browser tab (workspace-tab-browser_*) to open after clicking the changed file",
      );
      return `workingDiffVisible=${workingDiffVisible} browserTabVisible=${browserTabVisible}`;
    },
  },
];
