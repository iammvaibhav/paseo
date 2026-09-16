import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  name: "paseo50-tab-menu-hover-zindex",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "Right-click on a VS Code editor tab and sidebar hover tooltips render cleanly above the VS Code Web window without z-index clipping",
};

function repoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo50-zindex-${ctx.stack.runId}`);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

export const steps = [
  {
    id: "health",
    label: "Daemon answers health endpoint",
    narrate: "Daemon is healthy and answering loopback requests.",
    async run(ctx) {
      const res = await fetch(`${ctx.host().httpUrl}/api/health`);
      ctx.expect(res.status === 200, "health endpoint returned 200");
      return "health 200 ok";
    },
  },
  {
    id: "build-fixture-and-workspace",
    label: "Build fixture repo with a modified file and create workspace",
    narrate: "Fixture repo with modified file backs the test workspace.",
    async run(ctx) {
      const repoDir = repoDirFor(ctx);
      fs.mkdirSync(repoDir, { recursive: true });
      if (!fs.existsSync(path.join(repoDir, ".git"))) {
        git(repoDir, ["init", "-b", "main"]);
        git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
        git(repoDir, ["config", "user.name", "Paseo Verify"]);
        git(repoDir, ["config", "commit.gpgsign", "false"]);
        fs.writeFileSync(path.join(repoDir, "file.ts"), "export const a = 1;\n");
        git(repoDir, ["add", "-A"]);
        git(repoDir, ["commit", "-m", "initial fixture commit"]);
      }
      fs.writeFileSync(path.join(repoDir, "file.ts"), "export const a = 2;\n");

      const client = ctx.host().client;
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repoDir },
        title: "paseo50-zindex-test",
      });
      ctx.expect(!created.error, `Workspace create failed: ${created.error}`);
      ctx.expect(Boolean(created.workspace?.id), "Workspace has an id");
      ctx.uiWorkspaceId = created.workspace.id;
      ctx.uiRepoDir = repoDir;
      return `workspace ${ctx.uiWorkspaceId} created at ${repoDir}`;
    },
  },
  {
    id: "load-app-with-desktop-shim",
    label: "Load web UI under an Electron desktop shim",
    narrate: "Web UI loaded with desktop host bridge for persistent browser webviews.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");

      page.on("console", (msg) => {
        if (msg.type() === "error") {
          ctx.log(`[browser-console:error] ${msg.text()}`);
        }
      });

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
      await page.waitForSelector(
        '[data-testid="sidebar-home"], [data-testid="sidebar-settings"], [data-testid="sidebar-mission-control"]',
        { state: "attached", timeout: 30_000 },
      );
      return `app loaded from ${ctx.host().httpUrl}`;
    },
  },
  {
    id: "open-workspace-and-vscode-editor-tab",
    label: "Navigate to workspace and open a VS Code editor tab",
    narrate: "VS Code Web editor tab opened in workspace with the editor window below.",
    async run(ctx) {
      const page = ctx.page;

      // Click the workspace row in the sidebar
      const row = page.locator(`[data-testid$=":${ctx.uiWorkspaceId}"]`);
      await row.waitFor({ state: "visible", timeout: 15_000 });
      await row.click();
      await page.waitForTimeout(2000);

      // Open Changes tree via shortcut Ctrl+Shift+G
      await page.keyboard.press("Control+Shift+G");
      await page.waitForTimeout(1000);

      const changesPanel = page.locator('[data-testid="changes-tree-panel"]');
      if (!(await changesPanel.isVisible().catch(() => false))) {
        const newTabBtn = page.locator('[data-testid="workspace-new-tab-changes"]');
        if (await newTabBtn.isVisible().catch(() => false)) {
          await newTabBtn.click();
        }
      }

      await page.waitForSelector('[data-testid="changes-file-tree"]', { timeout: 30_000 });
      const fileItem = page
        .locator('[data-testid="diff-tree-file-0"], [data-testid^="diff-tree-file-"]')
        .first();
      await fileItem.waitFor({ state: "visible", timeout: 10_000 });

      // Click the changed file to open VS Code Web editor tab
      await fileItem.click();

      // Wait for the VS Code Web browser tab to be created in the tab bar
      const vscodeTab = page.locator('[data-testid^="workspace-tab-browser_"]').first();
      await vscodeTab.waitFor({ state: "visible", timeout: 15_000 });

      // Present the persistent browser webview over the main editor content area
      const presentation = await page.evaluate(() => {
        let wrapper = document.querySelector("[data-paseo-persistent-browser-wrapper]");
        if (!wrapper) {
          wrapper = document.createElement("div");
          wrapper.setAttribute("data-paseo-persistent-browser-wrapper", "vscode-web-1");
          const webview = document.createElement("webview");
          webview.style.display = "flex";
          webview.style.width = "100%";
          webview.style.height = "100%";
          wrapper.appendChild(webview);
          document.body.appendChild(wrapper);
        }

        // Target the main workspace content area (below the top tab bar)
        const tabBar =
          document
            .querySelector('[data-testid^="workspace-tab-browser_"]')
            ?.closest(".r-flexDirection-18u37iz") ||
          document.querySelector('[data-testid^="workspace-tab-browser_"]')?.parentElement;
        const tabRect = tabBar ? tabBar.getBoundingClientRect() : { top: 0, bottom: 44 };
        const top = Math.round(tabRect.bottom || 44);
        const left = 240; // Sidebar width
        const width = Math.max(400, window.innerWidth - left);
        const height = Math.max(300, window.innerHeight - top);

        if (window.__paseoResidentWebviews?.showPersistentBrowserWebview) {
          const fakeTarget = document.createElement("div");
          fakeTarget.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
          document.body.appendChild(fakeTarget);
          window.__paseoResidentWebviews.showPersistentBrowserWebview("vscode-web-1", fakeTarget);
        } else {
          // Unfixed behavior: wrapper with z-index 2
          wrapper.setAttribute("aria-hidden", "false");
          wrapper.style.position = "fixed";
          wrapper.style.left = `${left}px`;
          wrapper.style.top = `${top}px`;
          wrapper.style.width = `${width}px`;
          wrapper.style.height = `${height}px`;
          wrapper.style.overflow = "hidden";
          wrapper.style.opacity = "1";
          wrapper.style.pointerEvents = "auto";
          wrapper.style.zIndex = "2";
          wrapper.style.visibility = "visible";
        }

        return {
          top,
          left,
          width,
          height,
          wrapperZ: window.getComputedStyle(wrapper).zIndex,
        };
      });

      // Wait for code-server workbench to finish loading inside the iframe
      await page.waitForTimeout(5000);

      ctx.log(
        `VS Code Web editor tab opened, wrapper bounds=(${presentation.left},${presentation.top},${presentation.width},${presentation.height}), zIndex=${presentation.wrapperZ}`,
      );
      return "VS Code Web editor tab open with editor window positioned below";
    },
  },
  {
    id: "verify-tab-context-menu-layering",
    label: "Right-click on VS Code editor tab renders context menu cleanly above the editor window",
    narrate:
      "Context menu on VS Code editor tab floats above the editor window without z-index clipping.",
    async run(ctx) {
      const page = ctx.page;

      // Find the VS Code Web editor tab in the top tab bar
      const vscodeTab = page.locator('[data-testid^="workspace-tab-browser_"]').first();
      await vscodeTab.waitFor({ state: "visible", timeout: 10_000 });

      // Right-click directly on the VS Code editor tab
      await vscodeTab.click({ button: "right" });

      // Wait for context menu to appear
      const contextMenu = page.locator('[data-menu-surface="true"]').first();
      await contextMenu.waitFor({ state: "visible", timeout: 10_000 });

      // Capture before shot showing context menu on the VS Code editor tab
      await ctx.shot("before");

      // Verify z-index planes in the DOM
      const zIndexCheck = await page.evaluate(() => {
        const overlayRoot = document.getElementById("overlay-root");
        const wrapper = document.querySelector("[data-paseo-persistent-browser-wrapper]");
        const overlayZ = overlayRoot
          ? Number.parseInt(window.getComputedStyle(overlayRoot).zIndex || "0", 10)
          : null;
        const wrapperZ = wrapper
          ? Number.parseInt(window.getComputedStyle(wrapper).zIndex || "0", 10)
          : null;
        return { overlayZ, wrapperZ };
      });

      ctx.log(
        `Overlay z-index: ${zIndexCheck.overlayZ}, Webview wrapper z-index: ${zIndexCheck.wrapperZ}`,
      );

      // Check hit testing: point at the bottom half of the context menu (where it hangs down over the editor window)
      const menuBounds = await contextMenu.boundingBox();
      ctx.expect(Boolean(menuBounds), "Context menu must have bounds");

      const testPoint = {
        x: menuBounds.x + menuBounds.width / 2,
        y: menuBounds.y + menuBounds.height - 10,
      };

      const hitTestResult = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return { hitInsideOverlay: false, topElementTag: "null", topElementClass: "" };
        const overlayRoot = document.getElementById("overlay-root");
        const wrapper = document.querySelector("[data-paseo-persistent-browser-wrapper]");
        const hitInsideOverlay = overlayRoot ? overlayRoot.contains(el) : false;
        const hitInsideWrapper = wrapper ? wrapper.contains(el) : false;
        return {
          hitInsideOverlay,
          hitInsideWrapper,
          topElementTag: el.tagName,
          topElementClass: el.className || "",
        };
      }, testPoint);

      ctx.log(
        `Hit test on overlapping context menu item at (${testPoint.x}, ${testPoint.y}): hitInsideOverlay=${hitTestResult.hitInsideOverlay}, hitInsideWrapper=${hitTestResult.hitInsideWrapper}, tag=${hitTestResult.topElementTag}`,
      );

      ctx.expect(
        zIndexCheck.overlayZ !== null &&
          zIndexCheck.wrapperZ !== null &&
          zIndexCheck.overlayZ > zIndexCheck.wrapperZ,
        `overlay-root z-index (${zIndexCheck.overlayZ}) must be strictly greater than webview wrapper z-index (${zIndexCheck.wrapperZ})`,
      );

      ctx.expect(
        hitTestResult.hitInsideOverlay === true,
        `Point on context menu must hit-test inside overlay-root, but hit ${hitTestResult.topElementTag} (inside wrapper: ${hitTestResult.hitInsideWrapper})`,
      );

      // Verify that a menu action like "Close other tabs" is visible and clickable
      const closeOthersItem = page
        .locator('[data-menu-item="true"]')
        .filter({ hasText: /Close/i })
        .first();
      await closeOthersItem.waitFor({ state: "visible", timeout: 5000 });

      // Close menu by pressing Escape
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden", timeout: 5000 });

      return "VS Code editor tab context menu renders above the editor window and passes hit-testing";
    },
  },
  {
    id: "verify-sidebar-hover-layering",
    label: "Sidebar hover tooltips render above the VS Code Web window",
    narrate: "Hover tooltips from the left sidebar float above the VS Code Web window.",
    async run(ctx) {
      const page = ctx.page;

      // Hover on the add-project button or a sidebar row
      const addProjectBtn = page.locator('[data-testid="sidebar-add-project"]').first();
      await addProjectBtn.waitFor({ state: "visible", timeout: 10_000 });
      await addProjectBtn.hover();

      // Wait a moment for tooltip delay
      await page.waitForTimeout(500);

      // Capture after shot
      await ctx.shot("after");

      // Verify that the tooltip in overlay-root is above the webview wrapper
      const tooltipCheck = await page.evaluate(() => {
        const overlayRoot = document.getElementById("overlay-root");
        const wrapper = document.querySelector("[data-paseo-persistent-browser-wrapper]");
        const overlayZ = overlayRoot
          ? Number.parseInt(window.getComputedStyle(overlayRoot).zIndex || "0", 10)
          : null;
        const wrapperZ = wrapper
          ? Number.parseInt(window.getComputedStyle(wrapper).zIndex || "0", 10)
          : null;
        return overlayZ !== null && wrapperZ !== null && overlayZ > wrapperZ;
      });

      ctx.expect(
        tooltipCheck,
        "Sidebar hover tooltips in overlay-root must render above the webview wrapper",
      );

      return "Sidebar hover tooltips render above VS Code Web window";
    },
  },
];
