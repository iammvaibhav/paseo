import { describe, expect, it } from "vitest";
import { createTabHistory, type TabHistoryEntry } from "./tab-history";

function tab(workspaceId: string, tabId: string): TabHistoryEntry {
  return { serverId: "srv", workspaceId, workspaceKey: `srv:${workspaceId}`, tabId };
}

const always = () => true;

describe("tab history back/forward", () => {
  it("steps back and forward across workspaces like a browser", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "agent"));
    history.record(tab("ws-a", "terminal"));
    history.record(tab("ws-b", "vscode"));

    expect(history.step(-1, always)).toEqual(tab("ws-a", "terminal"));
    history.record(tab("ws-a", "terminal"));
    expect(history.step(-1, always)).toEqual(tab("ws-a", "agent"));
    history.record(tab("ws-a", "agent"));
    expect(history.step(-1, always)).toBeNull();

    expect(history.step(1, always)).toEqual(tab("ws-a", "terminal"));
    history.record(tab("ws-a", "terminal"));
    expect(history.step(1, always)).toEqual(tab("ws-b", "vscode"));
    history.record(tab("ws-b", "vscode"));
    expect(history.step(1, always)).toBeNull();
  });

  it("drops the forward entries when a new tab is focused after going back", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "one"));
    history.record(tab("ws-a", "two"));
    history.record(tab("ws-a", "three"));

    history.step(-1, always);
    history.record(tab("ws-a", "two"));
    history.record(tab("ws-b", "browser"));

    expect(history.step(1, always)).toBeNull();
    expect(history.step(-1, always)).toEqual(tab("ws-a", "two"));
  });

  it("skips tabs that no longer exist and never lands on the current tab", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "one"));
    history.record(tab("ws-a", "closed"));
    history.record(tab("ws-a", "one"));
    history.record(tab("ws-a", "two"));

    const exists = (entry: TabHistoryEntry) => entry.tabId !== "closed";
    expect(history.step(-1, exists)).toEqual(tab("ws-a", "one"));
    // "closed" is skipped, and the older "one" is the tab already shown.
    expect(history.step(-1, exists)).toBeNull();
  });

  it("keeps only the newest entries past the limit", () => {
    const history = createTabHistory({ limit: 2 });
    history.record(tab("ws-a", "one"));
    history.record(tab("ws-a", "two"));
    history.record(tab("ws-a", "three"));

    expect(history.step(-1, always)).toEqual(tab("ws-a", "two"));
    expect(history.step(-1, always)).toBeNull();
  });
});

describe("tab history recently used", () => {
  it("toggles between the two most recent tabs", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "agent"));
    history.record(tab("ws-b", "terminal"));
    history.record(tab("ws-a", "browser"));

    const first = history.recent(1, always);
    expect(first).toEqual(tab("ws-b", "terminal"));
    history.record(tab("ws-b", "terminal"));

    expect(history.recent(1, always)).toEqual(tab("ws-a", "browser"));
  });

  it("walks from the least recently used tab the other way", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "one"));
    history.record(tab("ws-a", "two"));
    history.record(tab("ws-a", "three"));

    expect(history.recent(-1, always)).toEqual(tab("ws-a", "one"));
    history.record(tab("ws-a", "one"));
    expect(history.recent(-1, always)).toEqual(tab("ws-a", "two"));
    history.record(tab("ws-a", "two"));
    expect(history.recent(-1, always)).toEqual(tab("ws-a", "three"));
  });

  it("counts a tab focused again as recent instead of listing it twice", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "one"));
    history.record(tab("ws-a", "two"));
    history.record(tab("ws-a", "one"));

    expect(history.recent(1, always)).toEqual(tab("ws-a", "two"));
    expect(history.recent(-1, always)).toEqual(tab("ws-a", "two"));
  });

  it("skips closed tabs and has nothing to offer with a single tab", () => {
    const history = createTabHistory();
    history.record(tab("ws-a", "closed"));
    history.record(tab("ws-a", "open"));

    expect(history.recent(1, (entry) => entry.tabId !== "closed")).toBeNull();
    expect(history.recent(-1, (entry) => entry.tabId !== "closed")).toBeNull();
  });
});
