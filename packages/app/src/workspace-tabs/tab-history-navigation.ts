import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToWorkspaceTab } from "@/stores/navigation-active-workspace-store";
import type { TabHistoryMode } from "@/keyboard/route-shortcut";
import { createTabHistory, type TabHistoryEntry } from "./tab-history";

// One history for the whole app session, across every workspace and host.
const tabHistory = createTabHistory();

/** The focused workspace screen reports every tab that gains focus. */
export function recordFocusedWorkspaceTab(entry: TabHistoryEntry): void {
  tabHistory.record(entry);
}

function tabStillExists(entry: TabHistoryEntry): boolean {
  return (
    useWorkspaceLayoutStore.getState().getTabDestination(entry.workspaceKey, entry.tabId) !== null
  );
}

/**
 * "history" steps back (-1) / forward (1) through every tab focused this
 * session; "recent" shows the most (1) / least (-1) recently used other tab.
 * Returns the tab it showed, or null when there is nowhere to go.
 */
export function navigateTabHistory(mode: TabHistoryMode, delta: 1 | -1): TabHistoryEntry | null {
  const entry =
    mode === "history"
      ? tabHistory.step(delta, tabStillExists)
      : tabHistory.recent(delta, tabStillExists);
  if (entry) {
    navigateToWorkspaceTab(entry);
  }
  return entry;
}
