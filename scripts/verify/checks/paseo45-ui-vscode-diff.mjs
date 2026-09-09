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
    "paseo-bridge instead of the in-app working diff panel. Also validates base-branch picker UI.",
};

function repoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo45-ui-vscode-diff-${ctx.stack.runId}`);
}

function baseRepoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo45-ui-base-${ctx.stack.runId}`);
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
      ctx.log(`code-server healthy at ${ctx.stack.codeServer.url}`);
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
      if (!fs.existsSync(path.join(repoDir, ".git"))) {
        git(repoDir, ["init", "-b", "main"]);
        git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
        git(repoDir, ["config", "user.name", "Paseo Verify"]);
        git(repoDir, ["config", "commit.gpgsign", "false"]);
        fs.writeFileSync(path.join(repoDir, "changed.ts"), "export const value = 1;\n");
        git(repoDir, ["add", "-A"]);
        git(repoDir, ["commit", "-m", "initial fixture commit"]);
      }
      fs.writeFileSync(path.join(repoDir, "changed.ts"), "export const value = 2;\n");
      const client = ctx.host().client;
      const existingList = await client.listWorkspaces({}).catch(() => null);
      const foundExisting = (existingList?.workspaces || existingList?.entries || []).find(
        (w) => w?.workspaceDirectory === repoDir || w?.title === "paseo45-ui-vscode-diff",
      );
      if (foundExisting?.id) {
        ctx.uiWorkspaceId = foundExisting.id;
      } else {
        const created = await client.createWorkspace({
          source: { kind: "directory", path: repoDir },
          title: "paseo45-ui-vscode-diff",
        });
        ctx.expect(!created.error, `Workspace create failed: ${created.error}`);
        ctx.expect(Boolean(created.workspace?.id), "Workspace has an id");
        ctx.uiWorkspaceId = created.workspace.id;
      }
      ctx.uiRepoDir = repoDir;
      return `workspace ${ctx.uiWorkspaceId} at ${repoDir} with one modified tracked file`;
    },
  },
  {
    id: "build-base-picker-fixture-and-workspace",
    label: "Build a two-branch fixture repo and create a branch-off worktree",
    narrate: "Fixture repo with main and feature-base branches; workspace cut from feature-base.",
    async run(ctx) {
      const repoDir = baseRepoDirFor(ctx);
      fs.mkdirSync(repoDir, { recursive: true });
      if (!fs.existsSync(path.join(repoDir, ".git"))) {
        git(repoDir, ["init", "-b", "main"]);
        git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
        git(repoDir, ["config", "user.name", "Paseo Verify"]);
        git(repoDir, ["config", "commit.gpgsign", "false"]);
        fs.writeFileSync(path.join(repoDir, "a.txt"), "commit A\n");
        git(repoDir, ["add", "-A"]);
        git(repoDir, ["commit", "-m", "commit A"]);
        git(repoDir, ["checkout", "-b", "feature-base"]);
        fs.writeFileSync(path.join(repoDir, "b.txt"), "commit B\n");
        git(repoDir, ["add", "-A"]);
        git(repoDir, ["commit", "-m", "commit B"]);
      }
      git(repoDir, ["checkout", "main"]);
      const client = ctx.host().client;
      const branchName = `paseo45-ui-${ctx.stack.runId}`;
      const existingList = await client.listWorkspaces({}).catch(() => null);
      const foundExisting = (existingList?.workspaces || existingList?.entries || []).find(
        (w) => w?.title === "paseo45-ui-base-picker",
      );
      if (foundExisting?.workspaceDirectory && foundExisting?.id) {
        ctx.basePickerRepo = repoDir;
        ctx.basePickerWorktreeDir = foundExisting.workspaceDirectory;
        ctx.basePickerWorkspaceId = foundExisting.id;
      } else {
        const created = await client.createWorkspace({
          source: {
            kind: "worktree",
            cwd: repoDir,
            action: "branch-off",
            baseBranch: "feature-base",
            branchName,
            worktreeSlug: branchName,
          },
          title: "paseo45-ui-base-picker",
        });
        ctx.expect(!created.error, `Base picker worktree create failed: ${created.error}`);
        ctx.expect(
          Boolean(created.workspace?.workspaceDirectory),
          "Base picker worktree has a workspaceDirectory",
        );
        ctx.basePickerRepo = repoDir;
        ctx.basePickerWorktreeDir = created.workspace.workspaceDirectory;
        ctx.basePickerWorkspaceId = created.workspace.id;

        fs.writeFileSync(path.join(ctx.basePickerWorktreeDir, "c.txt"), "commit C\n");
        git(ctx.basePickerWorktreeDir, ["add", "-A"]);
        git(ctx.basePickerWorktreeDir, ["commit", "-m", "commit C"]);
      }

      return `base-picker workspace ${ctx.basePickerWorkspaceId} at ${ctx.basePickerWorktreeDir} cut from feature-base, with commit C added`;
    },
  },
  {
    id: "load-app-with-desktop-shim",
    label: "Load web UI under an Electron desktop shim that survives resident-webviews",
    narrate:
      "Web UI loaded with window.paseoDesktop matching DesktopHostBridge so ensurePersistentBrowserWebview does not throw.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");

      const pageErrors = [];
      const failedRequests = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          ctx.log(`[browser-console:error] ${msg.text()}`);
        }
      });
      page.on("pageerror", (error) => {
        pageErrors.push(String(error?.stack || error));
        ctx.log(`[browser-pageerror] ${pageErrors.at(-1)}`);
      });
      page.on("requestfailed", (request) => {
        const detail = `${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`;
        failedRequests.push(detail);
        ctx.log(`[browser-requestfailed] ${detail}`);
      });
      ctx.browserPageErrors = pageErrors;
      ctx.browserFailedRequests = failedRequests;

      await page.addInitScript(() => {
        const browserStub = {
          profilePartition: "persist:paseo-verify",
          registerAttachedBrowser: async () => {},
          unregisterWorkspaceBrowser: async () => {},
          setWorkspaceActiveBrowser: async () => {},
          focus: async () => true,
          executeAutomationCommand: async () => ({}),
          setShortcutPolicy: async () => {},
          clearProfile: async () => {},
          captureElement: async () => null,
          copyElement: async () => false,
          openDevTools: async () => {},
          preparePlannotator: async () => ({ url: "", accelerated: false }),
          releasePlannotator: async () => {},
        };
        const browserEditorStub = {
          setInsecureOrigins: async () => ({ restartRequired: false }),
          getInsecureOrigins: async () => [],
        };
        window.paseoDesktop = {
          platform: "linux",
          windowChromeMode: "native",
          invoke: async () => ({}),
          getPendingOpenProject: async () => null,
          browser: browserStub,
          browserEditor: browserEditorStub,
          // DesktopHostBridge.events.on returns an unsubscribe synchronously. An
          // async stub returns a Promise, which callers pass to React cleanup.
          events: { on: () => () => {} },
          window: {},
          dialog: {},
          notification: {},
          opener: { openUrl: async () => {} },
          editor: {},
          webUtils: { getPathForFile: () => "" },
          menu: {},
          agentNavigation: { ready: async () => null },
        };
      });

      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page
        .waitForSelector(
          '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
          { state: "attached", timeout: 30_000 },
        )
        .catch((error) => {
          const diagnostics = [
            `UI bootstrap failed: ${error.message}`,
            `pageErrors=${pageErrors.length}`,
            `failedRequests=${failedRequests.length}`,
          ];
          if (pageErrors.length) diagnostics.push(`lastPageError=${pageErrors.at(-1)}`);
          if (failedRequests.length) diagnostics.push(`lastFailedRequest=${failedRequests.at(-1)}`);
          throw new Error(diagnostics.join("; "));
        });
      return `app loaded from ${ctx.host().httpUrl} under desktop shim`;
    },
  },
  {
    id: "open-workspace-changes-tree",
    label: "Navigate to the workspace and open its Changes tree",
    narrate: "Changes tree opened for the created workspace; before shot captured.",
    async run(ctx) {
      const page = ctx.page;

      // Click the workspace row in the sidebar
      const row = page.locator(`[data-testid$=":${ctx.uiWorkspaceId}"]`);
      await row.waitFor({ state: "visible", timeout: 15_000 });
      await row.click();

      // Wait for the workspace screen to settle
      await page.waitForTimeout(3000);
      await ctx.shot("after-nav");

      // Try to find workspace-changes or new-tab panel
      // The default new workspace seeds an empty agent-draft tab, not the
      // new-tab launcher or Changes panel. Use the Changes keyboard shortcut
      // (Ctrl+Shift+G / Cmd+Shift+G, see keyboard-shortcuts.ts
      // "workspace-tab-target-changes") to jump straight to the Changes tab
      // regardless of what the default tab is.
      await page.keyboard.press("Control+Shift+G");
      await page.waitForTimeout(1000);

      const changesPanel = page.locator('[data-testid="changes-tree-panel"]');
      if (!(await changesPanel.isVisible().catch(() => false))) {
        // Fall back to the new-tab launcher path in case the shortcut is rebound.
        const newTabBtn = page.locator('[data-testid="workspace-new-tab-changes"]');
        if (await newTabBtn.isVisible().catch(() => false)) {
          ctx.log("Changes shortcut did not land; using new-tab launcher Changes button");
          await newTabBtn.click();
        }
      }

      // Wait for the changes file tree to appear
      await ctx.shot("trying-changes");
      await page.waitForSelector('[data-testid="changes-file-tree"]', { timeout: 30_000 });
      const fileItem = page
        .locator('[data-testid="diff-tree-file-0"], [data-testid^="diff-tree-file-"]')
        .first();
      await fileItem.waitFor({ state: "visible", timeout: 10_000 });

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

      let bridgeLogFound = false;
      let matchingBridgeLog = null;
      page.on("console", (msg) => {
        const text = msg.text();
        const expectedPath = path.join(ctx.uiRepoDir, "changed.ts");
        if (
          text.startsWith("[paseo-bridge] diff ") &&
          text.includes(`path=${expectedPath}`) &&
          text.includes("base=-")
        ) {
          bridgeLogFound = true;
          matchingBridgeLog = text;
        }
      });

      const deadline = Date.now() + 10_000;
      let workingDiffVisible = false;
      let browserTabFound = false;
      const fileItem = page
        .locator('[data-testid="diff-tree-file-0"], [data-testid^="diff-tree-file-"]')
        .first();
      await fileItem.click();
      while (Date.now() < deadline) {
        workingDiffVisible = (await page.locator('[data-testid="working-diff-panel"]').count()) > 0;
        if (workingDiffVisible) break;

        browserTabFound =
          (await page.locator('[data-testid^="workspace-tab-browser_"]').count()) > 0;
        if (browserTabFound && bridgeLogFound) break;

        await page.waitForTimeout(200);
      }

      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "After shot captured");

      ctx.expect(
        !workingDiffVisible,
        "working-diff-panel must not appear; clicking a changed file must open VS Code Web instead",
      );
      ctx.expect(
        browserTabFound,
        "Expected a VS Code Web browser tab (workspace-tab-browser_*) to be created/selected",
      );
      ctx.expect(
        bridgeLogFound,
        `Expected [paseo-bridge] console log matching mode "diff" and file "changed.ts", but got: ${matchingBridgeLog ?? "none"}`,
      );
      return `browserTabFound=${browserTabFound} matchingBridgeLog=${matchingBridgeLog}`;
    },
  },
  {
    id: "base-picker-workspace-load",
    label: "Navigate to the branch-off workspace and open Changes in committed mode",
    narrate: "Base picker workspace loaded with committed diff mode; default label shown.",
    async run(ctx) {
      const page = ctx.page;

      // Click the second workspace row
      const row = page.locator(`[data-testid$=":${ctx.basePickerWorkspaceId}"]`);
      await row.waitFor({ state: "visible", timeout: 15_000 });
      await row.click();

      await page.waitForTimeout(3000);
      await ctx.shot("base-after-nav");

      // Jump straight to the Changes tab via keyboard shortcut (see the
      // open-workspace-changes-tree step for why the launcher/new-tab panel
      // may not be showing).
      await page.keyboard.press("Control+Shift+G");
      await page.waitForTimeout(1000);
      // Two workspaces are mounted (the first workspace's deck stays in the
      // DOM), so scope every locator to the row we navigated to.
      const deck = page.locator(
        `[data-testid^="workspace-deck-entry-"][data-testid$=":${ctx.basePickerWorkspaceId}"]`,
      );
      if (
        !(await deck
          .locator('[data-testid="changes-tree-panel"]')
          .isVisible()
          .catch(() => false))
      ) {
        const newTabBtn = deck.locator('[data-testid="workspace-new-tab-changes"]');
        if (await newTabBtn.isVisible().catch(() => false)) {
          await newTabBtn.click();
        }
      }
      await deck
        .locator('[data-testid="changes-file-tree"]')
        .waitFor({ state: "visible", timeout: 30_000 });

      const trigger = deck.locator('[data-testid="changes-diff-status-trigger"]');
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      await trigger.click();
      await page.waitForTimeout(500);
      // The menu engine renders surfaces in a body-level portal, outside the
      // workspace deck, so menu items must be located on the page, not in `deck`.
      const committedOption = page.locator('[data-testid="changes-diff-mode-committed"]').last();
      await committedOption.click();
      await page.waitForTimeout(1000);

      // base-branch trigger should show, default label = "feature-base"
      const baseTrigger = deck.locator('[data-testid="changes-base-branch-trigger"]');
      await baseTrigger.waitFor({ state: "visible", timeout: 10_000 });

      const triggerLabel = await baseTrigger.textContent();
      ctx.expect(
        triggerLabel.includes("feature-base"),
        `Expected base-branch trigger label to contain "feature-base", got "${triggerLabel}"`,
      );

      // Open dropdown
      await baseTrigger.click();
      await page.waitForTimeout(500);

      // The base-branch picker is a Combobox in the shared menu portal too.
      const mainOption = page
        .locator(
          '[data-testid="changes-base-branch-option-main"], [data-testid="changes-base-branch-option-refs/heads/main"]',
        )
        .last();
      await mainOption.waitFor({ state: "visible", timeout: 5_000 });
      ctx.expect(
        await mainOption.isVisible(),
        "Expected changes-base-branch-option-main to be visible",
      );

      // Select main
      await mainOption.click();
      await page.waitForTimeout(1000);

      // Trigger label should update to main
      const updatedLabel = await baseTrigger.textContent();
      ctx.expect(
        updatedLabel.includes("main"),
        `Expected base-branch trigger label to contain "main" after selecting main, got "${updatedLabel}"`,
      );

      const pickerShot = await ctx.shot("base-picker");
      ctx.expect(Boolean(pickerShot), "base-picker shot captured");
      return `base-picker: default=feature-base, then selected main, label="${updatedLabel}"`;
    },
  },
];
