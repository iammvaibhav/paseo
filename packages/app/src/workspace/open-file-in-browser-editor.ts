import { getIsElectron } from "@/constants/platform";
import {
  createWorkspaceBrowser,
  getBrowserRecord,
  resolveBrowserChromeMode,
  useBrowserStore,
} from "@/stores/browser-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { browserEditorOriginFromUrl, buildBrowserEditorUrl } from "@/workspace/browser-editor-url";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { takePreloadedBrowserEditor } from "@/workspace/preload-browser-editor";

interface BrowserEditorTabActions {
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
  /** Absolute host path of the file to open. */
  absolutePath: string;
  line?: number | null;
}

/**
 * Open (or focus) a chrome-less VS Code Web tab for the given folder URL.
 * Adopts a preloaded (warm) webview when one exists so the tab appears instantly.
 * Returns true when handled.
 */
export function openBrowserEditorTab(input: OpenBrowserEditorTabInput): boolean {
  if (!getIsElectron()) {
    return false;
  }

  const origin = browserEditorOriginFromUrl(input.browserEditorUrl);
  if (!origin) {
    return false;
  }

  const store = useBrowserStore.getState();

  const existing = findExistingBrowserEditorTab({ tabs: input.workspaceTabs, origin });
  if (existing) {
    store.requestNavigation(existing.browserId, input.url);
    input.navigateToTabId(existing.tabId);
    return true;
  }

  const preloaded = takePreloadedBrowserEditor(origin);
  if (preloaded) {
    createWorkspaceBrowser({
      browserId: preloaded.browserId,
      initialUrl: preloaded.folderUrl,
      chrome: "embedded",
    });
    const tabId = input.openWorkspaceTabFocused({
      kind: "browser",
      browserId: preloaded.browserId,
    });
    if (tabId) {
      input.navigateToTabId(tabId);
    }
    // The warm window may be rooted at another folder (same host, different
    // workspace). Point it at the requested folder if so.
    if (preloaded.folderUrl !== input.url) {
      store.requestNavigation(preloaded.browserId, input.url);
    }
    return true;
  }

  const { browserId } = createWorkspaceBrowser({
    initialUrl: input.url,
    chrome: "embedded",
  });
  const tabId = input.openWorkspaceTabFocused({ kind: "browser", browserId });
  if (tabId) {
    input.navigateToTabId(tabId);
  }
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
 * absolute path, and a cold window is rooted at the file's directory.
 */
export function openHostFileInBrowserEditor(input: OpenHostFileInBrowserEditorInput): boolean {
  if (!getIsElectron()) {
    return false;
  }

  return openFileInBrowserEditorCore({
    browserEditorUrl: input.browserEditorUrl,
    folderPath: parentDirectory(input.absolutePath),
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
  const origin = browserEditorOriginFromUrl(input.browserEditorUrl);
  if (!origin) {
    return false;
  }

  // Fallback URL: a classic ?folder=&payload= open, used only when the bridge is
  // unreachable (cold window / extension not up yet) or for a truly cold create.
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

  const store = useBrowserStore.getState();
  const bridgeOpen = {
    path: input.absolutePath,
    line: input.line,
    column: 1,
    fallbackUrl: fileUrl,
  };

  const existing = findExistingBrowserEditorTab({ tabs: input.workspaceTabs, origin });
  if (existing) {
    input.navigateToTabId(existing.tabId);
    store.requestBridgeOpen(existing.browserId, bridgeOpen);
    return true;
  }

  const preloaded = takePreloadedBrowserEditor(origin);
  if (preloaded) {
    createWorkspaceBrowser({
      browserId: preloaded.browserId,
      initialUrl: preloaded.folderUrl,
      chrome: "embedded",
    });
    const tabId = input.openWorkspaceTabFocused({
      kind: "browser",
      browserId: preloaded.browserId,
    });
    if (tabId) {
      input.navigateToTabId(tabId);
    }
    store.requestBridgeOpen(preloaded.browserId, bridgeOpen);
    return true;
  }

  // Cold create: boot the workbench straight to the file (single reload).
  const { browserId } = createWorkspaceBrowser({ initialUrl: fileUrl, chrome: "embedded" });
  const tabId = input.openWorkspaceTabFocused({ kind: "browser", browserId });
  if (tabId) {
    input.navigateToTabId(tabId);
  }
  return true;
}

function parentDirectory(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  const parent = normalized.replace(/\/[^/]*\/?$/, "");
  return parent || "/";
}

function findExistingBrowserEditorTab(input: {
  tabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  origin: string;
}): { tabId: string; browserId: string } | null {
  for (const tab of input.tabs) {
    if (tab.target.kind !== "browser") {
      continue;
    }
    const record = getBrowserRecord(tab.target.browserId);
    if (!record) {
      continue;
    }
    if (resolveBrowserChromeMode(record.chrome) !== "embedded") {
      continue;
    }
    if (browserEditorOriginFromUrl(record.url) === input.origin) {
      return { tabId: tab.tabId, browserId: tab.target.browserId };
    }
  }
  return null;
}
