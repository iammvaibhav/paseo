import { getIsElectron } from "@/constants/platform";
import {
  type BrowserBridgeCommand,
  createWorkspaceBrowser,
  getBrowserRecord,
  useBrowserStore,
} from "@/desktop/browser/store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
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
  /** `diff` opens VS Code's diff editor for the file instead of the file. */
  mode?: "file" | "diff";
  /** Diff left side. Null/absent diffs the working tree against HEAD. */
  baseRef?: string | null;
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
 * Open a file or folder in the host's VS Code Web (code-server) browser tab: a
 * workspace path, any absolute host path, or a `~/…` path (the bridge expands
 * `~` on the host). Folders are revealed in VS Code's Explorer. Returns true when
 * handled; false when the caller should use the default in-app file tab.
 */
export function tryOpenFileInBrowserEditor(input: OpenFileInBrowserEditorInput): boolean {
  if (!getIsElectron()) {
    return false;
  }

  const path = input.location.path.trim();
  const isHomePath = path === "~" || path.startsWith("~/");
  const absolutePath = isHomePath
    ? path
    : resolveWorkspaceFilePaths({ path, workspaceRoot: input.workspaceDirectory })?.absolutePath;
  if (!absolutePath) {
    return false;
  }

  const folderUrl = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: input.workspaceDirectory,
  });
  // Fallback URL: a classic ?folder=&payload= open, used only when the bridge is
  // unreachable / times out (the pane reloads to it so the file still opens).
  // A `~` path has no URL form: only the host can expand it.
  const fileUrl = isHomePath
    ? null
    : buildBrowserEditorUrl({
        baseUrl: input.browserEditorUrl,
        folderPath: input.workspaceDirectory,
        filePath: absolutePath,
        line: input.location.lineStart ?? null,
        column: 1,
      });
  const instance = folderUrl
    ? ensureBrowserEditorInstance({ browserEditorUrl: input.browserEditorUrl, folderUrl })
    : null;
  if (!instance) {
    return false;
  }

  const mode = input.mode ?? "file";
  console.log(
    `[paseo-bridge] ${mode} browserId=${instance.browserId} path=${absolutePath} base=${input.baseRef ?? "-"}`,
  );
  revealBrowserEditor(instance, input);
  useBrowserStore.getState().requestBridgeOpen(instance.browserId, {
    path: absolutePath,
    line: input.location.lineStart ?? null,
    column: 1,
    mode,
    baseRef: input.baseRef ?? null,
    // A bridge too old to know about `mode` opens the plain file, so the reload
    // fallback matching that is the honest one for a diff request too.
    fallbackUrl: fileUrl,
    targetWorkspaceKey: input.workspaceKey,
  });
  return true;
}

/**
 * Show the host's VS Code tab, focus it, and run a VS Code command in it (Quick
 * Open, the Open File path browser). Returns true when handled.
 */
export function runBrowserEditorCommand(
  input: BrowserEditorTabActions & {
    browserEditorUrl: string;
    workspaceDirectory: string;
    command: BrowserBridgeCommand;
  },
): boolean {
  if (!getIsElectron()) {
    return false;
  }
  const folderUrl = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: input.workspaceDirectory,
  });
  const instance = folderUrl
    ? ensureBrowserEditorInstance({ browserEditorUrl: input.browserEditorUrl, folderUrl })
    : null;
  if (!instance) {
    return false;
  }
  revealBrowserEditor(instance, input);
  useBrowserStore.getState().requestBridgeCommand(instance.browserId, {
    command: input.command,
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
