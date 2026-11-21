import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSidebarAgentViewState, useSidebarAgentViewStore } from "./sidebar-agent-view-store";
const asyncStorageEntries = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageEntries.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorageEntries.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorageEntries.delete(key);
    }),
  },
}));
describe("sidebar agent view store", () => {
  beforeEach(() => {
    asyncStorageEntries.clear();
    useSidebarAgentViewStore.setState({
      hostFilters: [],
      projectFilters: [],
      pinnedAgentOrder: [],
    });
  });

  describe("host filters", () => {
    it("toggles multiple hosts into and out of the filter", () => {
      const store = useSidebarAgentViewStore.getState();
      store.toggleHostFilter("host-a");
      store.toggleHostFilter("host-b");

      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);

      store.toggleHostFilter("host-a");
      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual(["host-b"]);
    });

    it("clears host filters without touching other state", () => {
      const store = useSidebarAgentViewStore.getState();
      store.toggleHostFilter("host-a");
      store.toggleProjectFilter("proj-1");
      store.setPinnedAgentOrder(["host-a:agent-1"]);

      store.clearHostFilters();

      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual([]);
      expect(useSidebarAgentViewStore.getState().projectFilters).toEqual(["proj-1"]);
      expect(useSidebarAgentViewStore.getState().pinnedAgentOrder).toEqual(["host-a:agent-1"]);
    });

    it("reconciles host filters against available server IDs", () => {
      const store = useSidebarAgentViewStore.getState();
      store.toggleHostFilter("host-a");
      store.toggleHostFilter("host-b");
      store.toggleHostFilter("host-c");

      // Keep matching, drop missing
      store.reconcileHostFilters(["host-a", "host-c", "host-d"]);
      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual(["host-a", "host-c"]);

      // No-op if all current filters are still available
      const prevState = useSidebarAgentViewStore.getState();
      store.reconcileHostFilters(["host-a", "host-c", "host-e"]);
      expect(useSidebarAgentViewStore.getState()).toBe(prevState);

      // No-op when filter list is empty
      store.clearHostFilters();
      const emptyState = useSidebarAgentViewStore.getState();
      store.reconcileHostFilters(["host-a"]);
      expect(useSidebarAgentViewStore.getState()).toBe(emptyState);
    });
  });

  describe("project filters", () => {
    it("toggles multiple projects into and out of the filter", () => {
      const store = useSidebarAgentViewStore.getState();
      store.toggleProjectFilter("project-1");
      store.toggleProjectFilter("project-2");

      expect(useSidebarAgentViewStore.getState().projectFilters).toEqual([
        "project-1",
        "project-2",
      ]);

      store.toggleProjectFilter("project-1");
      expect(useSidebarAgentViewStore.getState().projectFilters).toEqual(["project-2"]);
    });

    it("clears project filters without touching other state", () => {
      const store = useSidebarAgentViewStore.getState();
      store.toggleHostFilter("host-a");
      store.toggleProjectFilter("project-1");
      store.setPinnedAgentOrder(["host-a:agent-1"]);

      store.clearProjectFilters();

      expect(useSidebarAgentViewStore.getState().projectFilters).toEqual([]);
      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual(["host-a"]);
      expect(useSidebarAgentViewStore.getState().pinnedAgentOrder).toEqual(["host-a:agent-1"]);
    });
  });

  describe("pinnedAgentOrder", () => {
    it("drops blank and duplicate keys", () => {
      useSidebarAgentViewStore.getState().setPinnedAgentOrder(["h:b", "", "h:a", "h:b"]);
      expect(useSidebarAgentViewStore.getState().pinnedAgentOrder).toEqual(["h:b", "h:a"]);
    });
  });

  describe("migration", () => {
    it("migrates from garbage to default state", () => {
      const empty = { hostFilters: [], projectFilters: [], pinnedAgentOrder: [] };
      expect(migrateSidebarAgentViewState(null)).toEqual(empty);
      expect(migrateSidebarAgentViewState("invalid json")).toEqual(empty);
      expect(migrateSidebarAgentViewState(42)).toEqual(empty);
      expect(migrateSidebarAgentViewState({ unexpectedKey: "boom" })).toEqual(empty);
      expect(migrateSidebarAgentViewState({ hostFilters: "not-an-array" })).toEqual(empty);
      expect(migrateSidebarAgentViewState({ pinnedAgentOrder: "not-an-array" })).toEqual(empty);
    });

    it("preserves valid fields, drops the removed showDone, and defaults omitted ones", () => {
      expect(
        migrateSidebarAgentViewState({
          hostFilters: ["host-1", "host-2"],
          showDone: true,
        }),
      ).toEqual({
        hostFilters: ["host-1", "host-2"],
        projectFilters: [],
        pinnedAgentOrder: [],
      });

      expect(
        migrateSidebarAgentViewState({
          projectFilters: ["proj-a"],
          pinnedAgentOrder: ["h:a"],
        }),
      ).toEqual({
        hostFilters: [],
        projectFilters: ["proj-a"],
        pinnedAgentOrder: ["h:a"],
      });
    });
  });
});
