/** One focused tab, anywhere in the app: the workspace it lives in and its tab id. */
export interface TabHistoryEntry {
  serverId: string;
  workspaceId: string;
  /** The workspace layout key (`serverId:workspaceId`) the tab id belongs to. */
  workspaceKey: string;
  tabId: string;
}

export type TabHistoryEntryValidator = (entry: TabHistoryEntry) => boolean;

export interface TabHistory {
  /**
   * Records that a tab gained focus. Moves it to the front of the recently used
   * list, and pushes it onto the back/forward stack unless it is the entry the
   * stack already points at (which is what a back/forward step lands on).
   */
  record: (entry: TabHistoryEntry) => void;
  /**
   * Steps the back/forward stack like a browser: -1 is back, 1 is forward.
   * Entries the validator rejects (closed tabs, removed workspaces) are skipped.
   * Returns the entry to show, or null when there is nowhere to go.
   */
  step: (delta: 1 | -1, isValid: TabHistoryEntryValidator) => TabHistoryEntry | null;
  /**
   * The recently used target: 1 is the most recently used tab other than the
   * current one (pressing it again returns), -1 is the least recently used one
   * (pressing it again keeps walking from oldest to newest).
   */
  recent: (delta: 1 | -1, isValid: TabHistoryEntryValidator) => TabHistoryEntry | null;
}

const DEFAULT_LIMIT = 100;

export function isSameTabHistoryEntry(left: TabHistoryEntry, right: TabHistoryEntry): boolean {
  return left.workspaceKey === right.workspaceKey && left.tabId === right.tabId;
}

export function createTabHistory(options: { limit?: number } = {}): TabHistory {
  const limit = options.limit ?? DEFAULT_LIMIT;
  let entries: TabHistoryEntry[] = [];
  let index = -1;
  // Most recently used first; each tab appears once.
  let recentlyUsed: TabHistoryEntry[] = [];

  function record(entry: TabHistoryEntry): void {
    recentlyUsed = [
      entry,
      ...recentlyUsed.filter((candidate) => !isSameTabHistoryEntry(candidate, entry)),
    ].slice(0, limit);

    const current = entries[index];
    if (current && isSameTabHistoryEntry(current, entry)) {
      return;
    }
    // A new focus after stepping back drops the forward entries, as a browser does.
    entries = [...entries.slice(0, index + 1), entry];
    if (entries.length > limit) {
      entries = entries.slice(entries.length - limit);
    }
    index = entries.length - 1;
  }

  function step(delta: 1 | -1, isValid: TabHistoryEntryValidator): TabHistoryEntry | null {
    const current = entries[index] ?? null;
    for (let candidate = index + delta; candidate >= 0 && candidate < entries.length; ) {
      const entry = entries[candidate];
      if (entry && isValid(entry) && !(current && isSameTabHistoryEntry(current, entry))) {
        index = candidate;
        return entry;
      }
      candidate += delta;
    }
    return null;
  }

  function recent(delta: 1 | -1, isValid: TabHistoryEntryValidator): TabHistoryEntry | null {
    const current = recentlyUsed[0] ?? null;
    const others = recentlyUsed
      .slice(1)
      .filter((entry) => isValid(entry) && !(current && isSameTabHistoryEntry(current, entry)));
    return (delta === 1 ? others[0] : others.at(-1)) ?? null;
  }

  return { record, step, recent };
}
