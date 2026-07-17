import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { buildBrowserEditorUrl } from "@/workspace/browser-editor-url";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import {
  ensureBrowserEditorInstance,
  type BrowserEditorInstance,
} from "@/workspace/preload-browser-editor";

interface BrowserEditorTabActions {
  workspaceKey: string;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
}

export interface OpenBrowserEditorTabInput extends BrowserEditorTabActions {
  url: string;
  browserEditorUrl: string;
}

export interface OpenFileInBrowserEditorInput extends BrowserEditorTabActions {
  browserEditorUrl: string;
  workspaceDirectory: string;
  location: WorkspaceFileLocation;
}

export interface OpenHostFileInBrowserEditorInput extends BrowserEditorTabActions {
  browserEditorUrl: string;
  workspaceDirectory: string;
  /** Absolute host path of the file to open. */
  absolutePath: string;
  line?: number | null;
}

/**
 * Reveal the host's single persistent VS Code Web tab (folder view). Adopts the
 * warm webview so it appears instantly; reopening after close reuses the same
 * instance (no reload). Returns true when handled.
 */
export function openBrowserEditorTab(input: OpenBrowserEditorTabInput): boolean {
  if (!getIsElectron()) {
    return false;
  }
  const instance = ensureBrowserEditorInstance({
    browserEditorUrl: input.browserEditorUrl,
    folderUrl: input.url,
  });
  if (!instance) {
    return false;
  }
  revealBrowserEditor(instance, input);
  return true;
}

/**
 * Open a workspace file in the host's VS Code Web (code-server) browser tab.
 * Returns true when handled; false when the caller should use the default
 * in-app file tab.
 */
export function tryOpenFileInBrowserEditor(input: OpenFileInBrowserEditorInput): boolean {
  if (!getIsElectron()) {
    return false;
  }

  const resolved = resolveWorkspaceFilePaths({
    path: input.location.path,
    workspaceRoot: input.workspaceDirectory,
  });
  if (!resolved) {
    return false;
  }

  return openFileInBrowserEditorCore({
    browserEditorUrl: input.browserEditorUrl,
    folderPath: input.workspaceDirectory,
    workspaceKey: input.workspaceKey,
    absolutePath: resolved.absolutePath,
    line: input.location.lineStart ?? null,
    workspaceTabs: input.workspaceTabs,
    openWorkspaceTabFocused: input.openWorkspaceTabFocused,
    navigateToTabId: input.navigateToTabId,
  });
}

/**
 * Open an arbitrary host file (from the host file browser) in VS Code Web.
 * The file may live outside any workspace folder — the bridge opens it by
 * absolute path.
 */
export function openHostFileInBrowserEditor(input: OpenHostFileInBrowserEditorInput): boolean {
  if (!getIsElectron()) {
    return false;
  }

  return openFileInBrowserEditorCore({
    browserEditorUrl: input.browserEditorUrl,
    // Host files can live anywhere, but the one persistent editor must remain
    // rooted at the active workspace. The bridge can open an absolute path
    // outside that root without changing folders.
    folderPath: input.workspaceDirectory,
    workspaceKey: input.workspaceKey,
    absolutePath: input.absolutePath,
    line: input.line ?? null,
    workspaceTabs: input.workspaceTabs,
    openWorkspaceTabFocused: input.openWorkspaceTabFocused,
    navigateToTabId: input.navigateToTabId,
  });
}

function openFileInBrowserEditorCore(
  input: BrowserEditorTabActions & {
    browserEditorUrl: string;
    folderPath: string;
    absolutePath: string;
    line: number | null;
  },
): boolean {
  // Fallback URL: a classic ?folder=&payload= open, used only when the bridge is
  // unreachable / times out (the pane reloads to it so the file still opens).
  const fileUrl = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: input.folderPath,
    filePath: input.absolutePath,
    line: input.line,
    column: 1,
  });
  if (!fileUrl) {
    return false;
  }
  const folderUrl = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: input.folderPath,
  });

  const instance = ensureBrowserEditorInstance({
    browserEditorUrl: input.browserEditorUrl,
    folderUrl: folderUrl ?? fileUrl,
  });
  if (!instance) {
    return false;
  }

  console.log(`[paseo-bridge] openFile browserId=${instance.browserId} path=${input.absolutePath}`);
  revealBrowserEditor(instance, input);
  useBrowserStore.getState().requestBridgeOpen(instance.browserId, {
    path: input.absolutePath,
    line: input.line,
    column: 1,
    fallbackUrl: fileUrl,
    targetWorkspaceKey: input.workspaceKey,
  });
  return true;
}

/**
 * Ensure a store record + open/focused tab exist for the persistent instance's
 * `browserId`. When the tab was closed the webview is still parked, so opening a
 * tab for the same id re-adopts it (no reload).
 */
function revealBrowserEditor(
  instance: BrowserEditorInstance,
  actions: BrowserEditorTabActions,
): void {
  if (!getBrowserRecord(instance.browserId)) {
    createWorkspaceBrowser({
      browserId: instance.browserId,
      initialUrl: instance.folderUrl,
      chrome: "embedded",
    });
  }

  const openTab = actions.workspaceTabs.find(
    (tab) => tab.target.kind === "browser" && tab.target.browserId === instance.browserId,
  );
  if (openTab) {
    actions.navigateToTabId(openTab.tabId);
    return;
  }

  const tabId = actions.openWorkspaceTabFocused({ kind: "browser", browserId: instance.browserId });
  if (tabId) {
    actions.navigateToTabId(tabId);
  }
}
