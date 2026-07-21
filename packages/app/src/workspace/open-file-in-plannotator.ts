import { getIsElectron } from "@/constants/platform";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import {
  createBrowserId,
  createWorkspaceBrowser,
  getBrowserRecord,
  useBrowserStore,
} from "@/stores/browser-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
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

  const browserId = createBrowserId();
  createWorkspaceBrowser({
    browserId,
    initialUrl: input.embedUrl,
    chrome: "embedded-transient",
  });
  useBrowserStore.getState().updateBrowser(browserId, {
    title: input.title,
  });
  return browserId;
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
  if (!isRenderedMarkdownFile(input.location.path)) {
    return {
      ok: false,
      reason: "not_markdown",
      message: "Only Markdown files can be opened in Plannotator",
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

  let started: PlannotatorSessionStartResult;
  try {
    started = await input.client.startPlannotatorSession({
      kind: "annotate",
      path: resolved.absolutePath,
      workspaceDir: input.workspaceDirectory,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      workspaceKey: input.workspaceKey,
      remote: input.remote === true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[plannotator] failed to start session", error);
    return {
      ok: false,
      reason: "start_failed",
      message: message.trim() || "Could not open Plannotator",
    };
  }

  const embedUrl = buildPlannotatorEmbedUrl({
    port: started.port,
    daemonUrl: started.url,
    remote: input.remote === true,
    embedHost: input.embedHost,
  });

  if (input.remote === true && !input.embedHost?.trim()) {
    console.warn(
      "[plannotator] remote session started but embedHost is missing; webview may not load",
      { embedUrl, daemonUrl: started.url },
    );
  }

  const title = `Plannotator · ${resolved.relativePath ?? resolved.absolutePath}`;

  let browserId: string;
  try {
    browserId = ensurePlannotatorBrowserRecord({
      sessionId: started.sessionId,
      embedUrl,
      title,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[plannotator] failed to create browser tab", error);
    return {
      ok: false,
      reason: "browser_create_failed",
      message: message.trim() || "Could not open Plannotator browser tab",
    };
  }

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
