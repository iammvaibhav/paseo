import { useEffect } from "react";
import {
  ensureResidentBrowserWebview,
  removeResidentBrowserWebview,
} from "@/components/browser-webview-resident";
import { getIsElectron } from "@/constants/platform";
import { createBrowserId } from "@/stores/browser-store";
import { browserEditorOriginFromUrl, buildBrowserEditorUrl } from "@/workspace/browser-editor-url";

/**
 * Background warm-up for VS Code Web (code-server).
 *
 * We keep one always-loaded, chrome-less `<webview>` parked per code-server
 * origin (Electron only) so that "Open → VS Code Web" reveals an already-booted
 * workbench instead of cold-loading it. The parked webview lives in the resident
 * webview map (in-memory, not persisted); the browser-store record is created
 * only when the user actually opens the tab, which then adopts this warm webview
 * by its `browserId`. Nothing is written to the persisted browser store until an
 * open happens, so preloading leaves no clutter behind.
 */

interface PreloadedBrowserEditor {
  browserId: string;
  origin: string;
  folderUrl: string;
}

const preloadedByOrigin = new Map<string, PreloadedBrowserEditor>();

export function preloadBrowserEditor(input: {
  browserEditorUrl: string;
  folderPath: string;
}): void {
  if (!getIsElectron()) {
    return;
  }
  const origin = browserEditorOriginFromUrl(input.browserEditorUrl);
  if (!origin) {
    return;
  }
  const folderUrl = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: input.folderPath,
  });
  if (!folderUrl) {
    return;
  }
  // Keep exactly one warm window per origin, rooted at the ACTIVE workspace's
  // folder. If the active workspace changed (same host, different folder), tear
  // the stale warm window down and re-warm for the new folder — otherwise "Open"
  // would adopt a window rooted elsewhere and have to reload to the right folder.
  const existing = preloadedByOrigin.get(origin);
  if (existing) {
    if (existing.folderUrl === folderUrl) {
      return;
    }
    removeResidentBrowserWebview(existing.browserId);
    preloadedByOrigin.delete(origin);
  }
  const browserId = createBrowserId();
  preloadedByOrigin.set(origin, { browserId, origin, folderUrl });
  ensureResidentBrowserWebview({ browserId, url: folderUrl });
}

/**
 * Claims the warm webview for an origin (removing it from the registry) so the
 * caller can open a tab that adopts it. Returns null when nothing is warm.
 */
export function takePreloadedBrowserEditor(origin: string): PreloadedBrowserEditor | null {
  const preloaded = preloadedByOrigin.get(origin) ?? null;
  if (preloaded) {
    preloadedByOrigin.delete(origin);
  }
  return preloaded;
}

/** Drops and destroys the warm webview for an origin (e.g. host URL removed). */
export function clearPreloadedBrowserEditor(origin: string): void {
  const preloaded = preloadedByOrigin.get(origin);
  if (!preloaded) {
    return;
  }
  preloadedByOrigin.delete(origin);
  removeResidentBrowserWebview(preloaded.browserId);
}

/** For tests: drop registry state without touching the DOM resident map. */
export function resetPreloadedBrowserEditorsForTests(): void {
  preloadedByOrigin.clear();
}

/**
 * Warms VS Code Web for the active workspace whenever its host has a configured
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
    preloadBrowserEditor({ browserEditorUrl: url, folderPath: folder });
  }, [browserEditorUrl, workspaceDirectory]);
}
