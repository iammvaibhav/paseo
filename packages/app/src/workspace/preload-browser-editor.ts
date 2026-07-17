import { useEffect } from "react";
import {
  ensurePersistentBrowserWebview,
  navigatePersistentBrowserWebview,
  removePersistentBrowserWebview,
} from "@/components/browser-webview-resident";
import { getIsElectron } from "@/constants/platform";
import { createBrowserId, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { browserEditorOriginFromUrl, buildBrowserEditorUrl } from "@/workspace/browser-editor-url";

/**
 * One persistent VS Code Web (code-server) instance per host origin.
 *
 * We keep exactly ONE chrome-less `<webview>` per code-server origin, warmed in
 * the background (Electron only). Opening reveals it, closing parks it (kept
 * alive, hidden), reopening re-reveals the SAME warm instance — so it never
 * cold-reloads. Because there's only one window per host, its extension host
 * reliably owns the paseo-bridge port and is the window the user sees, which is
 * what makes in-place file opens work.
 *
 * The registry is in-memory (not persisted). The browser-store record + tab are
 * created lazily when the instance is first revealed; the parked webview lives in
 * the resident webview map and is adopted by its stable `browserId`.
 */

export interface BrowserEditorInstance {
  browserId: string;
  origin: string;
  folderUrl: string;
}

const instanceByOrigin = new Map<string, BrowserEditorInstance>();

export function isBrowserEditorInstance(browserId: string): boolean {
  return Array.from(instanceByOrigin.values()).some((instance) => instance.browserId === browserId);
}

function removeDuplicateBrowserEditor(browserId: string): void {
  const layoutState = useWorkspaceLayoutStore.getState();
  const tabsToClose: Array<{ workspaceKey: string; tabId: string }> = [];
  for (const [workspaceKey, layout] of Object.entries(layoutState.layoutByWorkspace)) {
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind === "browser" && tab.target.browserId === browserId) {
        tabsToClose.push({ workspaceKey, tabId: tab.tabId });
      }
    }
  }
  useBrowserStore.getState().removeBrowser(browserId);
  for (const tab of tabsToClose) {
    useWorkspaceLayoutStore.getState().closeTab(tab.workspaceKey, tab.tabId);
  }
  removePersistentBrowserWebview(browserId);
}

/**
 * Returns the persistent instance for the host, creating + warming it if needed.
 * Never creates a second instance for the same origin. Returns null off Electron
 * or when the URL/folder can't be resolved.
 */
export function ensureBrowserEditorInstance(input: {
  browserEditorUrl: string;
  folderUrl: string | null | undefined;
}): BrowserEditorInstance | null {
  if (!getIsElectron()) {
    return null;
  }
  const origin = browserEditorOriginFromUrl(input.browserEditorUrl);
  if (!origin) {
    return null;
  }
  const existing = instanceByOrigin.get(origin);
  if (existing) {
    // Make sure the warm webview still exists (recreate it if it was destroyed).
    // No-op when it's already parked or currently adopted into a visible pane.
    ensurePersistentBrowserWebview({ browserId: existing.browserId, url: existing.folderUrl });
    const requestedFolderUrl = input.folderUrl?.trim();
    if (requestedFolderUrl && existing.folderUrl !== requestedFolderUrl) {
      rerootBrowserEditorInstance(existing, requestedFolderUrl);
    }
    return existing;
  }
  const folderUrl = input.folderUrl?.trim();
  if (!folderUrl) {
    return null;
  }
  // Browser records persist across app launches while this in-memory registry
  // does not. Adopt the newest embedded record for this origin and remove stale
  // duplicates, otherwise every relaunch can create another hidden code-server
  // window competing for the bridge port.
  const persistedRecords = Object.values(useBrowserStore.getState().browsersById ?? {})
    .filter(
      (record) => record.chrome === "embedded" && browserEditorOriginFromUrl(record.url) === origin,
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const persisted = persistedRecords[0] ?? null;
  for (const duplicate of persistedRecords.slice(1)) {
    removeDuplicateBrowserEditor(duplicate.browserId);
  }

  const browserId = persisted?.browserId ?? createBrowserId();
  const instance: BrowserEditorInstance = {
    browserId,
    origin,
    // The workspace making this call is authoritative. Persisted records are
    // only reused for identity/partition continuity; their URL may belong to
    // the previously active workspace.
    folderUrl,
  };
  instanceByOrigin.set(origin, instance);
  ensurePersistentBrowserWebview({ browserId, url: instance.folderUrl });
  if (persisted && persisted.url !== folderUrl) {
    useBrowserStore.getState().updateBrowser(browserId, { url: folderUrl });
  }
  return instance;
}

/**
 * Re-root the single per-host instance to a new folder (the active workspace's
 * directory). VS Code Web can't hot-swap its root folder in the browser — the
 * workbench is bootstrapped per root — so this is a navigation (reload). We do it
 * on the parked/hidden webview so it reloads in the background and is already
 * showing the right folder by the time the user opens it.
 */
function rerootBrowserEditorInstance(instance: BrowserEditorInstance, folderUrl: string): void {
  instance.folderUrl = folderUrl;
  const hasBrowserRecord = Boolean(getBrowserRecord(instance.browserId));
  if (hasBrowserRecord) {
    useBrowserStore.getState().updateBrowser(instance.browserId, { url: folderUrl });
  }
  // If the webview is parked here, navigate it directly (background reload).
  if (navigatePersistentBrowserWebview(instance.browserId, folderUrl)) {
    return;
  }
  // Otherwise it's adopted into a pane (possibly hidden): let the pane owning the
  // element navigate it, and keep the store record's URL in sync for adoption.
  if (hasBrowserRecord) {
    useBrowserStore.getState().requestNavigation(instance.browserId, folderUrl);
  }
}

/** Drops and destroys the instance for an origin (e.g. host URL removed). */
export function clearBrowserEditorInstance(origin: string): void {
  const instance = instanceByOrigin.get(origin);
  if (!instance) {
    return;
  }
  instanceByOrigin.delete(origin);
  removePersistentBrowserWebview(instance.browserId);
}

/** For tests: drop registry state without touching the DOM resident map. */
export function resetBrowserEditorInstancesForTests(): void {
  instanceByOrigin.clear();
}

/**
 * Warms VS Code Web for the active workspace's host and keeps its single per-host
 * instance rooted at the active workspace's folder. Mount from the workspace
 * screen with `isActive` = whether this workspace is the one being viewed; when a
 * different workspace becomes active, its folder wins (background re-root/reload).
 * Electron only; no-op elsewhere.
 */
export function usePreloadBrowserEditor(input: {
  browserEditorUrl: string | null | undefined;
  workspaceDirectory: string | null | undefined;
  workspaceKey: string | null | undefined;
  isActive: boolean;
}): void {
  const { browserEditorUrl, workspaceDirectory, workspaceKey, isActive } = input;
  useEffect(() => {
    if (!getIsElectron() || !isActive) {
      return;
    }
    const url = browserEditorUrl?.trim();
    const folder = workspaceDirectory?.trim();
    if (!url || !folder || !workspaceKey?.trim()) {
      return;
    }
    const folderUrl = buildBrowserEditorUrl({ baseUrl: url, folderPath: folder });
    if (!folderUrl) {
      return;
    }
    const instance = ensureBrowserEditorInstance({ browserEditorUrl: url, folderUrl });
    if (instance && instance.folderUrl !== folderUrl) {
      rerootBrowserEditorInstance(instance, folderUrl);
    }
  }, [browserEditorUrl, workspaceDirectory, workspaceKey, isActive]);
}
