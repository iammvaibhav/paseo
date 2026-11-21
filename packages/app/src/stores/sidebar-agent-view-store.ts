import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { dedupeKeys } from "./sidebar-order-store";
import { toggleFilterEntry } from "./sidebar-view-store";

export const SIDEBAR_AGENT_VIEW_STORAGE_KEY = "sidebar-agent-view";
export const SIDEBAR_AGENT_VIEW_STORE_VERSION = 1;

export interface SidebarAgentViewStoreState {
  hostFilters: string[];
  projectFilters: string[];
  /**
   * `serverId:agentId` order of the Pinned section after a drag. Pins themselves live on the
   * daemon (so every device sees them); the order is per device, like pinned workspaces.
   */
  pinnedAgentOrder: string[];
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
  toggleProjectFilter: (viewKey: string) => void;
  clearProjectFilters: () => void;
  setPinnedAgentOrder: (keys: string[]) => void;
}

export interface SidebarAgentViewPersistedState {
  hostFilters: string[];
  projectFilters: string[];
  pinnedAgentOrder: string[];
}

const SidebarAgentViewPersistedStateSchema = z.strictObject({
  hostFilters: z.array(z.string()).optional(),
  projectFilters: z.array(z.string()).optional(),
  pinnedAgentOrder: z.array(z.string()).optional(),
  // The removed Show done toggle: done agents always list now. Accepted so state stored by older
  // builds still parses, then dropped.
  showDone: z.boolean().optional(),
});

export function migrateSidebarAgentViewState(persisted: unknown): SidebarAgentViewPersistedState {
  const result = SidebarAgentViewPersistedStateSchema.safeParse(persisted);
  if (!result.success) {
    return {
      hostFilters: [],
      projectFilters: [],
      pinnedAgentOrder: [],
    };
  }

  return {
    hostFilters: result.data.hostFilters ?? [],
    projectFilters: result.data.projectFilters ?? [],
    pinnedAgentOrder: dedupeKeys(result.data.pinnedAgentOrder ?? []),
  };
}

export const useSidebarAgentViewStore = create<SidebarAgentViewStoreState>()(
  persist(
    (set) => ({
      hostFilters: [],
      projectFilters: [],
      pinnedAgentOrder: [],
      toggleHostFilter: (serverId) =>
        set((state) => ({ hostFilters: toggleFilterEntry(state.hostFilters, serverId) })),
      clearHostFilters: () => set({ hostFilters: [] }),
      reconcileHostFilters: (serverIds) =>
        set((state) => {
          if (state.hostFilters.length === 0) {
            return state;
          }
          const allowed = new Set(serverIds);
          const next = state.hostFilters.filter((id) => allowed.has(id));
          if (next.length === state.hostFilters.length) {
            return state;
          }
          return { hostFilters: next };
        }),
      toggleProjectFilter: (viewKey) =>
        set((state) => ({ projectFilters: toggleFilterEntry(state.projectFilters, viewKey) })),
      clearProjectFilters: () => set({ projectFilters: [] }),
      setPinnedAgentOrder: (keys) => set({ pinnedAgentOrder: dedupeKeys(keys) }),
    }),
    {
      name: SIDEBAR_AGENT_VIEW_STORAGE_KEY,
      version: SIDEBAR_AGENT_VIEW_STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, SidebarAgentViewPersistedStateSchema),
      partialize: (state) => ({
        hostFilters: state.hostFilters,
        projectFilters: state.projectFilters,
        pinnedAgentOrder: state.pinnedAgentOrder,
      }),
      migrate: migrateSidebarAgentViewState,
    },
  ),
);
