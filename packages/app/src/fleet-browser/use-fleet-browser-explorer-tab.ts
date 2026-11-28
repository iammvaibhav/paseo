import { useEffect, useRef } from "react";
import {
  collectAllTabs,
  findPaneContainingTab,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { useFleetBrowserChangeFeed, useFleetBrowserWindows } from "./use-fleet-browser-windows";

// The Browser tab lives in the Explorer next to Files and Changes, and only
// while an agent in this workspace has a fleet browser window open. It is added
// in the background (never stealing the user's view), revealed when an agent
// asks for help, and removed once the windows are gone and the user has moved
// off it, so a window that closes under the user's eyes does not yank the tab.

const FLEET_BROWSER_TAB_ID = buildDeterministicWorkspaceTabId({ kind: "fleet_browser" });

interface FleetBrowserTabState {
  exists: boolean;
  selected: boolean;
}

function readTabState(layout: WorkspaceLayout | undefined): FleetBrowserTabState {
  if (!layout) return { exists: false, selected: false };
  const exists = collectAllTabs(layout.root).some((tab) => tab.target.kind === "fleet_browser");
  const pane = exists ? findPaneContainingTab(layout.root, FLEET_BROWSER_TAB_ID) : null;
  return { exists, selected: pane?.focusedTabId === FLEET_BROWSER_TAB_ID };
}

function addFleetBrowserTab(workspaceKey: string): void {
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.ensureExplorerSidebar(workspaceKey);
  const layout = store.layoutByWorkspace[workspaceKey];
  const changes = layout
    ? collectAllTabs(layout.root).find(
        (tab) =>
          tab.target.kind === "changes_tree" &&
          findPaneContainingTab(layout.root, tab.tabId)?.id === paneId,
      )
    : undefined;
  store.openTab({
    workspaceKey,
    target: { kind: "fleet_browser" },
    intent: "background",
    placement: paneId ? { mode: "pane", paneId } : { mode: "ambient" },
    insertionPosition: changes ? { afterTabId: changes.tabId } : undefined,
  });
}

export function useFleetBrowserExplorerTab(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
  isCompact: boolean;
}): void {
  const { serverId, workspaceId, workspaceKey, isCompact } = input;
  useFleetBrowserChangeFeed({ serverId, workspaceId });
  const { supported, windows, settled } = useFleetBrowserWindows({ serverId, workspaceId });
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const tabExists = useWorkspaceLayoutStore((state) =>
    workspaceKey ? readTabState(state.layoutByWorkspace[workspaceKey]).exists : false,
  );
  const tabSelected = useWorkspaceLayoutStore((state) =>
    workspaceKey ? readTabState(state.layoutByWorkspace[workspaceKey]).selected : false,
  );
  const hasWindows = windows.length > 0;

  useEffect(() => {
    if (!hydrated || !workspaceKey || !settled) return;
    if (hasWindows && supported && !tabExists) {
      addFleetBrowserTab(workspaceKey);
      return;
    }
    if (!hasWindows && tabExists && !tabSelected) {
      useWorkspaceLayoutStore.getState().closeTab(workspaceKey, FLEET_BROWSER_TAB_ID);
    }
  }, [hydrated, workspaceKey, settled, hasWindows, supported, tabExists, tabSelected]);

  // An agent asking for help (captcha, code, approval) reveals the tab once per request.
  const handoffKey = windows
    .filter((window) => window.handoff)
    .map((window) => `${window.id}:${window.handoff?.requestedAt}`)
    .join("|");
  const revealedHandoff = useRef<string>("");
  useEffect(() => {
    if (!hydrated || !workspaceKey || !handoffKey || handoffKey === revealedHandoff.current) return;
    revealedHandoff.current = handoffKey;
    // On a phone the Explorer is a full-screen overlay: the request shows on the tab
    // instead of covering the chat the user is reading.
    if (isCompact) return;
    openExplorerSidebarView({ isCompact, workspaceKey, view: "browser" });
  }, [hydrated, workspaceKey, handoffKey, isCompact]);
}
