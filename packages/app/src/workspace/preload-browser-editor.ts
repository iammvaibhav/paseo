import { useEffect } from "react";
import {
  ensureResidentBrowserWebview,
  removeResidentBrowserWebview,
} from "@/components/browser-webview-resident";
import { getIsElectron } from "@/constants/platform";
import { createBrowserId } from "@/stores/browser-store";
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
    ensureResidentBrowserWebview({ browserId: existing.browserId, url: existing.folderUrl });
    return existing;
  }
  const folderUrl = input.folderUrl?.trim();
  if (!folderUrl) {
    return null;
  }
  const browserId = createBrowserId();
  const instance: BrowserEditorInstance = { browserId, origin, folderUrl };
  instanceByOrigin.set(origin, instance);
  ensureResidentBrowserWebview({ browserId, url: folderUrl });
  return instance;
}

/** Drops and destroys the instance for an origin (e.g. host URL removed). */
export function clearBrowserEditorInstance(origin: string): void {
  const instance = instanceByOrigin.get(origin);
  if (!instance) {
    return;
  }
  instanceByOrigin.delete(origin);
  removeResidentBrowserWebview(instance.browserId);
}

/** For tests: drop registry state without touching the DOM resident map. */
export function resetBrowserEditorInstancesForTests(): void {
  instanceByOrigin.clear();
}

/**
 * Warms VS Code Web for the active workspace's host whenever it has a configured
 * URL. Mount once from the workspace screen (Electron only; no-op elsewhere).
 */
export function usePreloadBrowserEditor(input: {
  browserEditorUrl: string | null | undefined;
  workspaceDirectory: string | null | undefined;
}): void {
  const { browserEditorUrl, workspaceDirectory } = input;
  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }
    const url = browserEditorUrl?.trim();
    const folder = workspaceDirectory?.trim();
    if (!url || !folder) {
      return;
    }
    const folderUrl = buildBrowserEditorUrl({ baseUrl: url, folderPath: folder });
    ensureBrowserEditorInstance({ browserEditorUrl: url, folderUrl });
  }, [browserEditorUrl, workspaceDirectory]);
}
