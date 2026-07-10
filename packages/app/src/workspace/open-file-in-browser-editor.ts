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

export interface OpenBrowserEditorTabInput {
  url: string;
  browserEditorUrl: string;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
}

export interface OpenFileInBrowserEditorInput {
  browserEditorUrl: string;
  workspaceDirectory: string;
  location: WorkspaceFileLocation;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
}

/**
 * Open (or focus) a chrome-less VS Code Web tab for the given URL.
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

  const existing = findExistingBrowserEditorTab({
    tabs: input.workspaceTabs,
    origin,
  });

  if (existing) {
    useBrowserStore.getState().requestNavigation(existing.browserId, input.url);
    input.navigateToTabId(existing.tabId);
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

  const url = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: input.workspaceDirectory,
    filePath: resolved.absolutePath,
    line: input.location.lineStart ?? null,
    column: 1,
  });
  if (!url) {
    return false;
  }

  return openBrowserEditorTab({
    url,
    browserEditorUrl: input.browserEditorUrl,
    workspaceTabs: input.workspaceTabs,
    openWorkspaceTabFocused: input.openWorkspaceTabFocused,
    navigateToTabId: input.navigateToTabId,
  });
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
