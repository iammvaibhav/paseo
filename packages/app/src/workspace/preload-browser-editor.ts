import { useEffect } from "react";
import { buildBridgePostScript } from "@/desktop/browser/bridge-script";
import {
  ensurePersistentBrowserWebview,
  getPersistentBrowserWebview,
  isBrowserWebviewDomReady,
  navigatePersistentBrowserWebview,
  removePersistentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import { getIsElectron } from "@/constants/platform";
import { createBrowserId, getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  browserEditorOriginFromUrl,
  browserEditorWorkspaceFile,
  buildBridgeSwitchPath,
  buildBrowserEditorUrl,
} from "@/workspace/browser-editor-url";

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
 * With the host's workspace file known (`homeDirectory` in server_info), the
 * window opens that multi-root workspace and a project change swaps folder 1 in
 * place through the paseo-bridge, with no reload. Without it, the window opens
 * `?folder=<project>` and a project change reloads the page.
 *
 * The registry is in-memory (not persisted). The browser-store record + tab are
 * created lazily when the instance is first revealed; the parked webview lives in
 * the resident webview map and is adopted by its stable `browserId`.
 */

export interface BrowserEditorInstance {
  browserId: string;
  origin: string;
  /** The host's VS Code Web base URL from its host settings. */
  baseUrl: string;
  /**
   * What the webview loads: the host's multi-root workspace file in workspace
   * mode, otherwise `?folder=<project>`.
   */
  url: string;
  /** The project the window shows, or is switching to. */
  folder: string;
  /**
   * Workspace mode: the `.code-workspace` file the window opens. A project
   * change swaps folder 1 in place through the bridge (no reload). Null in
   * folder mode, where a project change navigates the page.
   */
  workspaceFile: string | null;
  /** The host's bridge can't switch in place; stay in folder mode. */
  workspaceModeUnsupported: boolean;
  /** Serializes switches so a burst of workspace changes lands in order. */
  switchChain: Promise<void>;
}

const instanceByOrigin = new Map<string, BrowserEditorInstance>();
const webviewsWithLoadListener = new WeakSet<HTMLElement>();

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
 * Returns the persistent instance for the host, creating + warming it if needed,
 * and points it at `folder`. Never creates a second instance for the same
 * origin. Returns null off Electron or when the URL/folder can't be resolved.
 *
 * `workspaceFile` selects workspace mode (instant project switches). Omit it
 * when the caller doesn't know the host's file: the instance keeps its mode, and
 * a new one starts in folder mode until a caller supplies it.
 */
export function ensureBrowserEditorInstance(input: {
  browserEditorUrl: string;
  folder: string | null | undefined;
  workspaceFile?: string;
}): BrowserEditorInstance | null {
  if (!getIsElectron()) {
    return null;
  }
  const origin = browserEditorOriginFromUrl(input.browserEditorUrl);
  const folder = input.folder?.trim();
  if (!origin || !folder) {
    return null;
  }
  const existing = instanceByOrigin.get(origin) ?? null;
  const workspaceFile = existing?.workspaceModeUnsupported
    ? null
    : (input.workspaceFile ?? existing?.workspaceFile ?? null);
  const url = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl,
    folderPath: folder,
    workspaceFile,
  });
  if (!url) {
    return null;
  }
  const target = { baseUrl: input.browserEditorUrl, url, folder, workspaceFile };
  if (existing) {
    retargetBrowserEditorInstance(existing, target);
    return existing;
  }
  return createBrowserEditorInstance(origin, target);
}

interface BrowserEditorTarget {
  baseUrl: string;
  url: string;
  folder: string;
  workspaceFile: string | null;
}

function retargetBrowserEditorInstance(
  instance: BrowserEditorInstance,
  target: BrowserEditorTarget,
): void {
  // Make sure the warm webview still exists (recreate it if it was destroyed).
  // No-op when it's already parked or currently adopted into a visible pane.
  ensurePersistentBrowserWebview({ browserId: instance.browserId, url: instance.url });
  watchInstanceLoads(instance);
  const folderChanged = instance.folder !== target.folder;
  instance.baseUrl = target.baseUrl;
  instance.folder = target.folder;
  instance.workspaceFile = target.workspaceFile;
  if (instance.url !== target.url) {
    // Folder mode, or the first time this host's workspace file is known.
    // In workspace mode the reload's dom-ready selects the project.
    navigateBrowserEditorInstance(instance, target.url);
  } else if (target.workspaceFile && folderChanged) {
    queueProjectSwitch(instance);
  }
}

function createBrowserEditorInstance(
  origin: string,
  target: BrowserEditorTarget,
): BrowserEditorInstance {
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
  // The workspace making this call is authoritative. Persisted records are only
  // reused for identity/partition continuity; their URL may belong to the
  // previously active workspace.
  const instance: BrowserEditorInstance = {
    browserId,
    origin,
    ...target,
    workspaceModeUnsupported: false,
    switchChain: Promise.resolve(),
  };
  instanceByOrigin.set(origin, instance);
  ensurePersistentBrowserWebview({ browserId, url: target.url });
  watchInstanceLoads(instance);
  if (persisted && persisted.url !== target.url) {
    useBrowserStore.getState().updateBrowser(browserId, { url: target.url });
  }
  return instance;
}

/**
 * Loads a new URL in the single per-host instance: a project change in folder
 * mode (VS Code Web bootstraps one workbench per `?folder=`, so that is a
 * reload), or a change of mode. Done on the parked webview, so it reloads in the
 * background and shows the right project by the time the user opens it.
 */
function navigateBrowserEditorInstance(instance: BrowserEditorInstance, url: string): void {
  instance.url = url;
  const hasBrowserRecord = Boolean(getBrowserRecord(instance.browserId));
  if (hasBrowserRecord) {
    useBrowserStore.getState().updateBrowser(instance.browserId, { url });
  }
  // If the webview is parked here, navigate it directly (background reload).
  if (navigatePersistentBrowserWebview(instance.browserId, url)) {
    return;
  }
  // Otherwise it's adopted into a pane (possibly hidden): let the pane owning the
  // element navigate it, and keep the store record's URL in sync for adoption.
  if (hasBrowserRecord) {
    useBrowserStore.getState().requestNavigation(instance.browserId, url);
  }
}

/**
 * Every page load in workspace mode (first warm-up, load recovery, a fallback
 * reload) opens whichever project the workspace file last held, so select the
 * current one once the page is up. The bridge answers at once when it already
 * shows that project, and brings back its saved tabs in a fresh window.
 */
function watchInstanceLoads(instance: BrowserEditorInstance): void {
  const webview = getPersistentBrowserWebview(instance.browserId);
  if (!webview || webviewsWithLoadListener.has(webview)) {
    return;
  }
  webviewsWithLoadListener.add(webview);
  webview.addEventListener("dom-ready", () => {
    if (instance.workspaceFile && instanceByOrigin.get(instance.origin) === instance) {
      queueProjectSwitch(instance);
    }
  });
}

function queueProjectSwitch(instance: BrowserEditorInstance): void {
  instance.switchChain = instance.switchChain
    .then(() => switchBrowserEditorProject(instance))
    .catch((error) => {
      console.warn("[paseo-bridge] switch failed", error);
    });
}

interface BridgeSwitchResult {
  ok?: boolean;
  status?: number;
  error?: string;
  switched?: boolean;
  ms?: number;
}

/** Statuses meaning the host can't switch in place (old bridge, no workspace file). */
const SWITCH_UNSUPPORTED_STATUSES = new Set([404, 500, 503]);

async function switchBrowserEditorProject(instance: BrowserEditorInstance): Promise<void> {
  const { folder, workspaceFile } = instance;
  const webview = getPersistentBrowserWebview(instance.browserId);
  // Not loaded yet: the dom-ready listener switches once it is.
  if (!workspaceFile || !webview || !isBrowserWebviewDomReady(webview)) {
    return;
  }
  const started = Date.now();
  const result = ((await (webview as BridgeScriptHost)
    .executeJavaScript(buildBridgePostScript(buildBridgeSwitchPath(), { folder, workspaceFile }))
    .catch(() => null)) ?? {}) as BridgeSwitchResult;
  console.log(
    `[paseo-bridge] switch folder=${folder} ok=${result.ok === true} status=${result.status ?? "-"} switched=${result.switched ?? "-"} bridgeMs=${result.ms ?? "-"} totalMs=${Date.now() - started}${result.error ? ` error=${result.error}` : ""}`,
  );
  if (result.ok || result.status === undefined || !SWITCH_UNSUPPORTED_STATUSES.has(result.status)) {
    return;
  }
  // The host can't do it: fall back to folder mode for this session.
  instance.workspaceModeUnsupported = true;
  instance.workspaceFile = null;
  const folderUrl = buildBrowserEditorUrl({
    baseUrl: instance.baseUrl,
    folderPath: instance.folder,
  });
  if (folderUrl) {
    navigateBrowserEditorInstance(instance, folderUrl);
  }
}

interface BridgeScriptHost extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
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
 * instance on the active workspace's folder. Mount from the workspace screen with
 * `isActive` = whether this workspace is the one being viewed; when a different
 * workspace becomes active, its folder wins (in-place switch in workspace mode,
 * background reload otherwise). Electron only; no-op elsewhere.
 */
export function usePreloadBrowserEditor(input: {
  browserEditorUrl: string | null | undefined;
  workspaceDirectory: string | null | undefined;
  workspaceKey: string | null | undefined;
  /** The host user's home (server_info), which locates its workspace file. */
  homeDirectory: string | null | undefined;
  isActive: boolean;
}): void {
  const { browserEditorUrl, workspaceDirectory, workspaceKey, homeDirectory, isActive } = input;
  useEffect(() => {
    if (!getIsElectron() || !isActive) {
      return;
    }
    const url = browserEditorUrl?.trim();
    if (!url || !workspaceKey?.trim()) {
      return;
    }
    ensureBrowserEditorInstance({
      browserEditorUrl: url,
      folder: workspaceDirectory,
      // Unknown while the host connects: keep the instance's current mode
      // rather than reloading it into folder mode.
      workspaceFile: browserEditorWorkspaceFile(homeDirectory) ?? undefined,
    });
  }, [browserEditorUrl, workspaceDirectory, workspaceKey, homeDirectory, isActive]);
}
