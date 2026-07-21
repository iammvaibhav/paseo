import { getIsElectron } from "@/constants/platform";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
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

/**
 * Open a markdown file in an embedded Plannotator annotate session.
 * Returns true when a session/tab was opened; false when the caller should
 * fall through to another opener (VS Code Web / built-in viewer).
 */
export async function tryOpenFileInPlannotator(
  input: OpenFileInPlannotatorInput,
): Promise<boolean> {
  if (!getIsElectron()) {
    return false;
  }
  if (!isRenderedMarkdownFile(input.location.path)) {
    return false;
  }

  const resolved = resolveWorkspaceFilePaths({
    path: input.location.path,
    workspaceRoot: input.workspaceDirectory,
  });
  if (!resolved) {
    return false;
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
    console.warn("[plannotator] failed to start session", error);
    return false;
  }

  const embedUrl = buildPlannotatorEmbedUrl({
    port: started.port,
    daemonUrl: started.url,
    remote: input.remote === true,
    embedHost: input.embedHost,
  });

  const browserId = `plannotator-${started.sessionId}`;
  if (!getBrowserRecord(browserId)) {
    createWorkspaceBrowser({
      browserId,
      initialUrl: embedUrl,
      chrome: "embedded-transient",
    });
  } else {
    useBrowserStore.getState().updateBrowser(browserId, { url: embedUrl });
  }

  // Stash session id on the title so the feedback handler can stop/close.
  useBrowserStore.getState().updateBrowser(browserId, {
    title: `Plannotator · ${resolved.relativePath ?? resolved.absolutePath}`,
  });

  registerPlannotatorBrowserSession({
    browserId,
    sessionId: started.sessionId,
    workspaceKey: input.workspaceKey,
  });

  const openTab = input.workspaceTabs.find(
    (tab) => tab.target.kind === "browser" && tab.target.browserId === browserId,
  );
  if (openTab) {
    input.navigateToTabId(openTab.tabId);
    return true;
  }

  const tabId = input.openWorkspaceTabFocused({ kind: "browser", browserId });
  if (tabId) {
    input.navigateToTabId(tabId);
  }
  return true;
}

// --- session ↔ browser bookkeeping (module-local) ---

export interface PlannotatorBrowserSession {
  browserId: string;
  sessionId: string;
  workspaceKey: string;
}

const sessionsByBrowserId = new Map<string, PlannotatorBrowserSession>();
const sessionsBySessionId = new Map<string, PlannotatorBrowserSession>();

export function registerPlannotatorBrowserSession(session: PlannotatorBrowserSession): void {
  sessionsByBrowserId.set(session.browserId, session);
  sessionsBySessionId.set(session.sessionId, session);
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

export function clearPlannotatorBrowserSession(
  sessionId: string,
): PlannotatorBrowserSession | null {
  const session = sessionsBySessionId.get(sessionId) ?? null;
  if (!session) {
    return null;
  }
  sessionsBySessionId.delete(sessionId);
  sessionsByBrowserId.delete(session.browserId);
  return session;
}
