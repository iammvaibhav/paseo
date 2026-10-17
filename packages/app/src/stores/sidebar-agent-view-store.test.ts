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
      showDone: false,
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
      store.setShowDone(true);

      store.clearHostFilters();

      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual([]);
      expect(useSidebarAgentViewStore.getState().projectFilters).toEqual(["proj-1"]);
      expect(useSidebarAgentViewStore.getState().showDone).toBe(true);
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
      store.setShowDone(true);

      store.clearProjectFilters();

      expect(useSidebarAgentViewStore.getState().projectFilters).toEqual([]);
      expect(useSidebarAgentViewStore.getState().hostFilters).toEqual(["host-a"]);
      expect(useSidebarAgentViewStore.getState().showDone).toBe(true);
    });
  });

  describe("showDone", () => {
    it("defaults to false and updates via setter", () => {
      expect(useSidebarAgentViewStore.getState().showDone).toBe(false);

      useSidebarAgentViewStore.getState().setShowDone(true);
      expect(useSidebarAgentViewStore.getState().showDone).toBe(true);

      useSidebarAgentViewStore.getState().setShowDone(false);
      expect(useSidebarAgentViewStore.getState().showDone).toBe(false);
    });
  });

  describe("migration", () => {
    it("migrates from garbage to default state", () => {
      expect(migrateSidebarAgentViewState(null)).toEqual({
        hostFilters: [],
        projectFilters: [],
        showDone: false,
      });

      expect(migrateSidebarAgentViewState("invalid json")).toEqual({
        hostFilters: [],
        projectFilters: [],
        showDone: false,
      });

      expect(migrateSidebarAgentViewState(42)).toEqual({
        hostFilters: [],
        projectFilters: [],
        showDone: false,
      });

      expect(migrateSidebarAgentViewState({ unexpectedKey: "boom" })).toEqual({
        hostFilters: [],
        projectFilters: [],
        showDone: false,
      });

      expect(migrateSidebarAgentViewState({ hostFilters: "not-an-array" })).toEqual({
        hostFilters: [],
        projectFilters: [],
        showDone: false,
      });

      expect(migrateSidebarAgentViewState({ showDone: "not-a-boolean" })).toEqual({
        hostFilters: [],
        projectFilters: [],
        showDone: false,
      });
    });

    it("preserves valid fields and supplies defaults for omitted ones", () => {
      expect(
        migrateSidebarAgentViewState({
          hostFilters: ["host-1", "host-2"],
          showDone: true,
        }),
      ).toEqual({
        hostFilters: ["host-1", "host-2"],
        projectFilters: [],
        showDone: true,
      });

      expect(
        migrateSidebarAgentViewState({
          projectFilters: ["proj-a"],
        }),
      ).toEqual({
        hostFilters: [],
        projectFilters: ["proj-a"],
        showDone: false,
      });
    });
  });
});
