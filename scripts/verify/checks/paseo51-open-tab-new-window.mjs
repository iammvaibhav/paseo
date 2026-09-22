import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  name: "paseo51-open-tab-new-window",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Right-clicking a workspace tab or a workspace row in sidebar displays 'Open in new window' and opens a new window with that tab or workspace active.",
};

const MOCK_PROVIDER = "mock";
const FAST_MODEL = "e2e-fast-stream";

function repoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo51-tab-window-${ctx.stack.runId}`);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

export const steps = [
  {
    id: "setup-workspace-and-agent",
    label: "Create a fixture workspace with an agent tab",
    narrate: "Setting up a test workspace with an agent tab.",
    async run(ctx) {
      const repoDir = repoDirFor(ctx);
      fs.mkdirSync(repoDir, { recursive: true });
      if (!fs.existsSync(path.join(repoDir, ".git"))) {
        git(repoDir, ["init", "-b", "main"]);
        git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
        git(repoDir, ["config", "user.name", "Paseo Verify"]);
        git(repoDir, ["config", "commit.gpgsign", "false"]);
        fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Workspace\n");
        git(repoDir, ["add", "-A"]);
        git(repoDir, ["commit", "-m", "initial commit"]);
      }

      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repoDir },
        title: "Tab Window Test Workspace",
      });
      ctx.expect(!created.error, `Workspace create failed: ${created.error}`);
      ctx.expect(Boolean(created.workspace?.id), "Workspace has an id");
      ctx.workspaceId = created.workspace.id;

      const agentResult = await client.createAgent({
        workspaceId: ctx.workspaceId,
        cwd: repoDir,
        title: "Test Tab Agent",
        provider: MOCK_PROVIDER,
        model: FAST_MODEL,
        initialPrompt: "Finish quickly for tab verification",
      });
      const agentId = agentResult?.id ?? agentResult?.agent?.id;
      ctx.expect(
        Boolean(agentId),
        `Agent created successfully, got: ${JSON.stringify(agentResult)}`,
      );
      ctx.agentId = agentId;

      ctx.log(`Workspace ${ctx.workspaceId} created with agent ${ctx.agentId}`);
      return `workspace ${ctx.workspaceId} ready with agent ${ctx.agentId}`;
    },
  },
  {
    id: "load-app-and-open-workspace",
    label: "Load web UI and navigate to the workspace",
    narrate: "Loading the Paseo desktop UI with spy stubs for window creation.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available");

      await page.addInitScript(() => {
        window.__openNewCalls = [];
        window.__windowOpenCalls = [];

        const originalWindowOpen = window.open;
        window.open = function (url, target, features) {
          window.__windowOpenCalls.push({ url: String(url), target, features });
          if (originalWindowOpen) {
            return originalWindowOpen.call(window, url, target, features);
          }
          return null;
        };

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

        window.paseoDesktop = {
          platform: "linux",
          windowChromeMode: "native-mac",
          invoke: async () => ({}),
          getPendingOpenProject: async () => null,
          browser: browserStub,
          browserEditor: {
            setInsecureOrigins: async () => ({ restartRequired: false }),
            getInsecureOrigins: async () => [],
          },
          events: { on: () => () => {} },
          window: {
            openNew: async (options) => {
              window.__openNewCalls.push(options);
            },
            getCurrentWindow: () => ({
              minimize: async () => {},
              close: async () => {},
              toggleMaximize: async () => {},
              isMaximized: async () => false,
              setFullscreen: async () => {},
              isFullscreen: async () => false,
              updateChrome: async () => {},
              onResized: () => () => {},
              setBadgeCount: async () => {},
            }),
          },
          dialog: {},
          notification: {},
          opener: { openUrl: async () => {} },
          editor: {
            listTargets: async () => [],
            openTarget: async () => {},
          },
          webUtils: { getPathForFile: () => "" },
          menu: {
            showContextMenu: async () => {},
            setCapturingShortcut: async () => {},
          },
          agentNavigation: { ready: async () => null },
        };
      });

      await page.goto(ctx.host().httpUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      await page.waitForSelector(
        '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
        { state: "attached", timeout: 30_000 },
      );

      const row = page.locator(
        `[data-testid^="sidebar-workspace-row-"][data-testid$=":${ctx.workspaceId}"]`,
      );
      await row.waitFor({ state: "visible", timeout: 15_000 });
      await row.click();

      const tabLocator = page.locator(`[data-testid="workspace-tab-agent_${ctx.agentId}"]`);
      await tabLocator.waitFor({ state: "visible", timeout: 30_000 });

      ctx.log("Workspace and tab loaded successfully");
      return "workspace loaded";
    },
  },
  {
    id: "context-menu-tab-open-in-new-window",
    label: "Right-click tab: verify 'Open in new window' exists and calls openNew with tab route",
    narrate: "Right-clicking the tab to open context menu and selecting 'Open in new window'.",
    async run(ctx) {
      const page = ctx.page;
      const tabLocator = page.locator(`[data-testid="workspace-tab-agent_${ctx.agentId}"]`);
      await tabLocator.waitFor({ state: "visible", timeout: 10_000 });

      await ctx.shot("before");

      await tabLocator.click({ button: "right" });

      const openInNewWindowItem = page.locator(
        `[data-testid="workspace-tab-context-agent_${ctx.agentId}-open-in-new-window"]`,
      );
      await openInNewWindowItem.waitFor({ state: "visible", timeout: 10_000 });

      await openInNewWindowItem.click({ force: true });

      const calls = await page.evaluate(() => window.__openNewCalls || []);
      ctx.expect(
        calls.length > 0,
        "openNew must be called when 'Open in new window' is selected on tab",
      );

      const lastCall = calls[calls.length - 1];
      ctx.expect(
        Boolean(lastCall?.initialRoute),
        `openNew call must receive an initialRoute, got: ${JSON.stringify(lastCall)}`,
      );
      ctx.expect(
        lastCall.initialRoute.includes(`/workspace/${ctx.workspaceId}`) &&
          lastCall.initialRoute.includes(`agent%3A${ctx.agentId}`),
        `initialRoute must target workspace ${ctx.workspaceId} and agent ${ctx.agentId}, got: ${lastCall.initialRoute}`,
      );

      ctx.log(`Tab open in new window called with initialRoute: ${lastCall.initialRoute}`);
      return `Tab open in new window called with initialRoute ${lastCall.initialRoute}`;
    },
  },
  {
    id: "context-menu-workspace-open-in-new-window",
    label: "Right-click workspace in sidebar: verify 'Open in new window' exists and calls openNew",
    narrate: "Right-clicking workspace row in sidebar and selecting 'Open in new window'.",
    async run(ctx) {
      const page = ctx.page;
      const row = page.locator(
        `[data-testid^="sidebar-workspace-row-"][data-testid$=":${ctx.workspaceId}"]`,
      );
      await row.waitFor({ state: "visible", timeout: 10_000 });

      await row.click({ button: "right" });

      const openWorkspaceInNewWindowItem = page.locator(
        `[data-testid^="sidebar-workspace-menu-open-new-window-"]`,
      );
      await openWorkspaceInNewWindowItem.waitFor({ state: "visible", timeout: 10_000 });

      await openWorkspaceInNewWindowItem.click({ force: true });

      const calls = await page.evaluate(() => window.__openNewCalls || []);
      const lastCall = calls[calls.length - 1];
      ctx.expect(
        Boolean(lastCall?.initialRoute),
        `openNew call must receive an initialRoute for workspace, got: ${JSON.stringify(lastCall)}`,
      );
      ctx.expect(
        lastCall.initialRoute.includes(`/workspace/${ctx.workspaceId}`),
        `initialRoute must target workspace ${ctx.workspaceId}, got: ${lastCall.initialRoute}`,
      );

      ctx.log(`Workspace open in new window called with initialRoute: ${lastCall.initialRoute}`);

      await page.goto(`${ctx.host().httpUrl}${calls[0].initialRoute}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const activeTabLocator = page.locator(`[data-testid="workspace-tab-agent_${ctx.agentId}"]`);
      await activeTabLocator.waitFor({ state: "visible", timeout: 20_000 });

      await ctx.shot("after");
      return "Workspace open in new window verified and tab activation confirmed";
    },
  },
];
