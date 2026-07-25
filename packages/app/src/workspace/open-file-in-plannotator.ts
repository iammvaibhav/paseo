import { getIsElectron } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import {
  createBrowserId,
  createWorkspaceBrowser,
  getBrowserRecord,
  useBrowserStore,
} from "@/stores/browser-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";

export interface PlannotatorSessionStartResult {
  sessionId: string;
  port: number;
  url: string;
}

export interface PlannotatorSessionClient {
  startPlannotatorSession: (input: {
    kind: "annotate";
    path: string;
    workspaceDir: string;
    agentId?: string;
    workspaceKey?: string;
    remote?: boolean;
  }) => Promise<PlannotatorSessionStartResult>;
  stopPlannotatorSession: (sessionId: string) => Promise<void>;
}

interface PlannotatorTabActions {
  workspaceKey: string;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
}

export interface OpenFileInPlannotatorInput extends PlannotatorTabActions {
  client: PlannotatorSessionClient;
  workspaceDirectory: string;
  location: WorkspaceFileLocation;
  agentId?: string | null;
  /** When true, daemon binds 0.0.0.0 for VPN reachability. */
  remote?: boolean;
  /**
   * Host address used to reach the remote daemon from the desktop
   * (e.g. `blrofc3` or a Tailscale IP). Required when `remote` is true.
   */
  embedHost?: string | null;
}

export type OpenFileInPlannotatorResult =
  | { ok: true; sessionId: string; browserId: string }
  | { ok: false; reason: string; message: string };

const PLANNOTATOR_ANNOTATABLE_DOC_REGEX =
  /(\.(mdx?|txt|html?|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)$/i;

export function isPlannotatorAnnotatableFile(path: string): boolean {
  return PLANNOTATOR_ANNOTATABLE_DOC_REGEX.test(path.trim());
}

/** Map a daemon-local ready URL onto the host address the desktop can reach. */
export function buildPlannotatorEmbedUrl(input: {
  port: number;
  daemonUrl: string;
  remote: boolean;
  embedHost?: string | null;
}): string {
  if (!input.remote) {
    return `http://127.0.0.1:${input.port}`;
  }
  const host = input.embedHost?.trim();
  if (host) {
    return `http://${host}:${input.port}`;
  }
  // Fall back to rewriting localhost in the daemon-reported URL.
  try {
    const parsed = new URL(input.daemonUrl);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "0.0.0.0"
    ) {
      // Without embedHost we cannot reach a remote bind — still return loopback
      // so local testing works; caller should supply embedHost for remotes.
      return `http://127.0.0.1:${input.port}`;
    }
    return `http://${parsed.hostname}:${input.port}`;
  } catch {
    return `http://127.0.0.1:${input.port}`;
  }
}

function focusPlannotatorBrowserTab(input: PlannotatorTabActions & { browserId: string }): boolean {
  const openTab = input.workspaceTabs.find(
    (tab) => tab.target.kind === "browser" && tab.target.browserId === input.browserId,
  );
  if (openTab) {
    input.navigateToTabId(openTab.tabId);
    return true;
  }

  const tabId = input.openWorkspaceTabFocused({ kind: "browser", browserId: input.browserId });
  if (tabId) {
    input.navigateToTabId(tabId);
    return true;
  }
  return false;
}

/**
 * Ensure a browser-store record exists for this session. Browser automation IDs
 * must match `BrowserAutomationBrowserIdSchema` (uuid / timestamp-hex) — do NOT
 * use a `plannotator-` prefix (Zod throws and the tab never opens).
 */
function ensurePlannotatorBrowserRecord(input: {
  browserId: string;
  sessionId: string;
  embedUrl: string;
  title: string;
}): string {
  const existing = getPlannotatorBrowserSessionBySessionId(input.sessionId);
  if (existing && getBrowserRecord(existing.browserId)) {
    useBrowserStore.getState().updateBrowser(existing.browserId, {
      url: input.embedUrl,
      chrome: "embedded-transient",
      title: input.title,
    });
    return existing.browserId;
  }

  createWorkspaceBrowser({
    browserId: input.browserId,
    initialUrl: input.embedUrl,
    chrome: "embedded-transient",
  });
  useBrowserStore.getState().updateBrowser(input.browserId, {
    title: input.title,
  });
  return input.browserId;
}

async function requestPlannotatorSession(input: {
  openInput: OpenFileInPlannotatorInput;
  absolutePath: string;
}): Promise<
  | { started: PlannotatorSessionStartResult }
  | { error: OpenFileInPlannotatorResult & { ok: false } }
> {
  try {
    const started = await input.openInput.client.startPlannotatorSession({
      kind: "annotate",
      path: input.absolutePath,
      workspaceDir: input.openInput.workspaceDirectory,
      ...(input.openInput.agentId ? { agentId: input.openInput.agentId } : {}),
      workspaceKey: input.openInput.workspaceKey,
      remote: input.openInput.remote === true,
    });
    return { started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[plannotator] failed to start session", error);
    return {
      error: {
        ok: false,
        reason: "start_failed",
        message: message.trim() || "Could not open Plannotator",
      },
    };
  }
}

async function preparePlannotatorUiUrl(input: {
  browserId: string;
  remoteUrl: string;
}): Promise<string> {
  try {
    const prepared = await getDesktopHost()?.browser?.preparePlannotator?.({
      browserId: input.browserId,
      remoteUrl: input.remoteUrl,
    });
    if (prepared?.url) {
      console.log(
        `[plannotator] UI ${prepared.accelerated ? "served locally" : "loaded remotely"} url=${prepared.url}`,
      );
      return prepared.url;
    }
  } catch (error) {
    console.warn("[plannotator] local UI proxy unavailable; loading directly", error);
  }
  return input.remoteUrl;
}

async function createPlannotatorBrowser(input: {
  browserId: string;
  sessionId: string;
  embedUrl: string;
  title: string;
  client: PlannotatorSessionClient;
}): Promise<{ browserId: string } | { error: OpenFileInPlannotatorResult & { ok: false } }> {
  try {
    return {
      browserId: ensurePlannotatorBrowserRecord({
        browserId: input.browserId,
        sessionId: input.sessionId,
        embedUrl: input.embedUrl,
        title: input.title,
      }),
    };
  } catch (error) {
    void getDesktopHost()?.browser?.releasePlannotator?.(input.browserId);
    void input.client.stopPlannotatorSession(input.sessionId).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[plannotator] failed to create browser tab", error);
    return {
      error: {
        ok: false,
        reason: "browser_create_failed",
        message: message.trim() || "Could not open Plannotator browser tab",
      },
    };
  }
}

/**
 * Open a markdown file in an embedded Plannotator annotate session.
 * Returns a structured result so callers can surface the real failure reason.
 */
export async function tryOpenFileInPlannotator(
  input: OpenFileInPlannotatorInput,
): Promise<OpenFileInPlannotatorResult> {
  if (!getIsElectron()) {
    return {
      ok: false,
      reason: "not_electron",
      message: "Plannotator is only available in the desktop app",
    };
  }
  if (!isPlannotatorAnnotatableFile(input.location.path)) {
    return {
      ok: false,
      reason: "unsupported_file",
      message: "This file type is not supported by Plannotator",
    };
  }

  const resolved = resolveWorkspaceFilePaths({
    path: input.location.path,
    workspaceRoot: input.workspaceDirectory,
  });
  if (!resolved) {
    console.warn("[plannotator] path did not resolve under workspace", {
      path: input.location.path,
      workspaceDirectory: input.workspaceDirectory,
    });
    return {
      ok: false,
      reason: "path_resolve_failed",
      message: "Could not resolve the file path under the workspace",
    };
  }

  // Client-side reuse: same path already open in a live tab.
  const existing = findPlannotatorBrowserSessionByPath(resolved.absolutePath);
  if (existing && getBrowserRecord(existing.browserId)) {
    const focused = focusPlannotatorBrowserTab({
      ...input,
      browserId: existing.browserId,
    });
    if (focused) {
      console.log(
        `[plannotator] reuse client session=${existing.sessionId} browserId=${existing.browserId} path=${resolved.absolutePath}`,
      );
      return { ok: true, sessionId: existing.sessionId, browserId: existing.browserId };
    }
  }

  const sessionAttempt = await requestPlannotatorSession({
    openInput: input,
    absolutePath: resolved.absolutePath,
  });
  if ("error" in sessionAttempt) {
    return sessionAttempt.error;
  }
  const { started } = sessionAttempt;

  const remoteEmbedUrl = buildPlannotatorEmbedUrl({
    port: started.port,
    daemonUrl: started.url,
    remote: input.remote === true,
    embedHost: input.embedHost,
  });

  if (input.remote === true && !input.embedHost?.trim()) {
    console.warn(
      "[plannotator] remote session started but embedHost is missing; webview may not load",
      { embedUrl: remoteEmbedUrl, daemonUrl: started.url },
    );
  }

  const title = `Plannotator · ${resolved.relativePath ?? resolved.absolutePath}`;
  const requestedBrowserId = createBrowserId();
  const embedUrl = await preparePlannotatorUiUrl({
    browserId: requestedBrowserId,
    remoteUrl: remoteEmbedUrl,
  });
  const browserAttempt = await createPlannotatorBrowser({
    browserId: requestedBrowserId,
    sessionId: started.sessionId,
    embedUrl,
    title,
    client: input.client,
  });
  if ("error" in browserAttempt) {
    return browserAttempt.error;
  }
  const { browserId } = browserAttempt;

  console.log(
    `[plannotator] open session=${started.sessionId} browserId=${browserId} port=${started.port} remote=${input.remote === true} url=${embedUrl} path=${resolved.absolutePath}`,
  );

  registerPlannotatorBrowserSession({
    browserId,
    sessionId: started.sessionId,
    workspaceKey: input.workspaceKey,
    path: resolved.absolutePath,
  });

  const focused = focusPlannotatorBrowserTab({ ...input, browserId });
  if (!focused) {
    console.warn("[plannotator] session started but failed to open a workspace tab", { browserId });
    // Still ok — session is running; user may open the browser tab manually.
  }

  return { ok: true, sessionId: started.sessionId, browserId };
}

/**
 * Stop the daemon session (if any) for a closed browser tab. Safe no-op for
 * non-plannotator browsers. Does not remove the browser record — caller owns that.
 */
export async function stopPlannotatorBrowserIfNeeded(input: {
  client: PlannotatorSessionClient | null | undefined;
  browserId: string;
}): Promise<void> {
  const session = getPlannotatorBrowserSessionByBrowserId(input.browserId);
  if (!session) {
    return;
  }

  clearPlannotatorBrowserSession(session.sessionId);
  await releasePlannotatorLocalProxy(input.browserId);

  if (!input.client || !session.sessionId) {
    return;
  }
  try {
    await input.client.stopPlannotatorSession(session.sessionId);
  } catch (error) {
    console.warn("[plannotator] failed to stop session on tab close", {
      sessionId: session.sessionId,
      error,
    });
  }
}

export async function releasePlannotatorLocalProxy(browserId: string): Promise<void> {
  try {
    await getDesktopHost()?.browser?.releasePlannotator?.(browserId);
  } catch (error) {
    console.warn("[plannotator] failed to release local UI proxy", { browserId, error });
  }
}

// --- session ↔ browser bookkeeping (module-local) ---

export interface PlannotatorBrowserSession {
  browserId: string;
  sessionId: string;
  workspaceKey: string;
  /** Absolute host path being annotated (for client-side reuse). */
  path: string;
}

const sessionsByBrowserId = new Map<string, PlannotatorBrowserSession>();
const sessionsBySessionId = new Map<string, PlannotatorBrowserSession>();
const sessionsByPath = new Map<string, PlannotatorBrowserSession>();

export function registerPlannotatorBrowserSession(session: PlannotatorBrowserSession): void {
  // Drop stale path mapping if another session previously owned this path.
  const previousForPath = sessionsByPath.get(session.path);
  if (previousForPath && previousForPath.sessionId !== session.sessionId) {
    sessionsByBrowserId.delete(previousForPath.browserId);
    sessionsBySessionId.delete(previousForPath.sessionId);
  }
  // Drop stale browser mapping if session was re-bound to a new browser id.
  const previousForSession = sessionsBySessionId.get(session.sessionId);
  if (previousForSession && previousForSession.browserId !== session.browserId) {
    sessionsByBrowserId.delete(previousForSession.browserId);
  }
  sessionsByBrowserId.set(session.browserId, session);
  sessionsBySessionId.set(session.sessionId, session);
  if (session.path) {
    sessionsByPath.set(session.path, session);
  }
}

export function getPlannotatorBrowserSessionBySessionId(
  sessionId: string,
): PlannotatorBrowserSession | null {
  return sessionsBySessionId.get(sessionId) ?? null;
}

export function getPlannotatorBrowserSessionByBrowserId(
  browserId: string,
): PlannotatorBrowserSession | null {
  return sessionsByBrowserId.get(browserId) ?? null;
}

export function findPlannotatorBrowserSessionByPath(
  absolutePath: string,
): PlannotatorBrowserSession | null {
  return sessionsByPath.get(absolutePath) ?? null;
}

export function clearPlannotatorBrowserSession(
  sessionId: string,
): PlannotatorBrowserSession | null {
  const session = sessionsBySessionId.get(sessionId) ?? null;
  if (!session) {
    return null;
  }
  sessionsBySessionId.delete(sessionId);
  sessionsByBrowserId.delete(session.browserId);
  if (session.path && sessionsByPath.get(session.path)?.sessionId === sessionId) {
    sessionsByPath.delete(session.path);
  }
  return session;
}
