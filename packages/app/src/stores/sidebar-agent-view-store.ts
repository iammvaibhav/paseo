import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { toggleFilterEntry } from "./sidebar-view-store";

export const SIDEBAR_AGENT_VIEW_STORAGE_KEY = "sidebar-agent-view";
export const SIDEBAR_AGENT_VIEW_STORE_VERSION = 1;

export interface SidebarAgentViewStoreState {
  hostFilters: string[];
  projectFilters: string[];
  showDone: boolean;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
  toggleProjectFilter: (viewKey: string) => void;
  clearProjectFilters: () => void;
  setShowDone: (showDone: boolean) => void;
}

export interface SidebarAgentViewPersistedState {
  hostFilters: string[];
  projectFilters: string[];
  showDone: boolean;
}

const SidebarAgentViewPersistedStateSchema = z.strictObject({
  hostFilters: z.array(z.string()).optional(),
  projectFilters: z.array(z.string()).optional(),
  showDone: z.boolean().optional(),
});

export function migrateSidebarAgentViewState(persisted: unknown): {
  hostFilters: string[];
  projectFilters: string[];
  showDone: boolean;
} {
  const result = SidebarAgentViewPersistedStateSchema.safeParse(persisted);
  if (!result.success) {
    return {
      hostFilters: [],
      projectFilters: [],
      showDone: false,
    };
  }

  return {
    hostFilters: result.data.hostFilters ?? [],
    projectFilters: result.data.projectFilters ?? [],
    showDone: result.data.showDone ?? false,
  };
}

export const useSidebarAgentViewStore = create<SidebarAgentViewStoreState>()(
  persist(
    (set) => ({
      hostFilters: [],
      projectFilters: [],
      showDone: false,
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
      setShowDone: (showDone) => set({ showDone }),
    }),
    {
      name: SIDEBAR_AGENT_VIEW_STORAGE_KEY,
      version: SIDEBAR_AGENT_VIEW_STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, SidebarAgentViewPersistedStateSchema),
      partialize: (state) => ({
        hostFilters: state.hostFilters,
        projectFilters: state.projectFilters,
        showDone: state.showDone,
      }),
      migrate: migrateSidebarAgentViewState,
    },
  ),
);
