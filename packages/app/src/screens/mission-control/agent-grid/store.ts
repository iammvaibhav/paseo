import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { AgentGridDirection } from "./layout";

export const AGENT_GRID_STORAGE_KEY = "@paseo:mission-control-agent-grid";
export const AGENT_GRID_STORE_VERSION = 1;

export type MissionControlView = "commander" | "grid";

export const AGENT_GRID_VISIBLE_COUNT_OPTIONS = [1, 2, 4, 6, 8, 9, 12, 16] as const;
export const AGENT_GRID_DEFAULT_VISIBLE_COUNT = 6;

export interface AgentGridDraftState {
  id: string;
  serverId: string | null;
  workspaceId: string | null;
  projectKey: string | null;
}

export interface AgentGridNavigatedFrom {
  serverId: string;
  agentId: string;
}

export interface AgentGridStoreState {
  view: MissionControlView;
  visibleCount: number;
  direction: AgentGridDirection;
  setView: (view: MissionControlView) => void;
  setVisibleCount: (count: number) => void;
  setDirection: (direction: AgentGridDirection) => void;

  snapshotKeys: string[] | null;
  snapshotVersion: number;
  enterGrid: (keys: string[]) => void;
  clearSnapshot: () => void;

  glowKey: string | null;
  setGlow: (key: string | null) => void;

  activeKey: string | null;
  setActiveKey: (key: string | null) => void;

  draft: AgentGridDraftState | null;
  setDraft: (draft: AgentGridDraftState | null) => void;
  clearDraft: () => void;

  navigatedFromGrid: AgentGridNavigatedFrom | null;
  setNavigatedFromGrid: (navigated: AgentGridNavigatedFrom | null) => void;
}

export interface AgentGridPersistedState {
  view: MissionControlView;
  visibleCount: number;
  direction: AgentGridDirection;
}

const AgentGridPersistedStateSchema = z.strictObject({
  view: z.enum(["commander", "grid"]).optional(),
  visibleCount: z.number().int().positive().optional(),
  direction: z.enum(["horizontal", "vertical"]).optional(),
});

export function migrateAgentGridState(persisted: unknown): AgentGridPersistedState {
  const result = AgentGridPersistedStateSchema.safeParse(persisted);
  if (!result.success) {
    return {
      view: "commander",
      visibleCount: AGENT_GRID_DEFAULT_VISIBLE_COUNT,
      direction: "vertical",
    };
  }

  return {
    view: result.data.view ?? "commander",
    visibleCount: result.data.visibleCount ?? AGENT_GRID_DEFAULT_VISIBLE_COUNT,
    direction: result.data.direction ?? "vertical",
  };
}

export const useAgentGridStore: UseBoundStore<StoreApi<AgentGridStoreState>> =
  create<AgentGridStoreState>()(
    persist(
      (set) => ({
        view: "commander",
        visibleCount: AGENT_GRID_DEFAULT_VISIBLE_COUNT,
        direction: "vertical",
        setView: (view) => set({ view }),
        setVisibleCount: (count) => {
          const clamped = Math.max(1, Math.round(count));
          set({ visibleCount: clamped });
        },
        setDirection: (direction) => set({ direction }),

        snapshotKeys: null,
        snapshotVersion: 0,
        enterGrid: (keys) =>
          set((state) => ({
            snapshotKeys: keys,
            snapshotVersion: state.snapshotVersion + 1,
          })),
        clearSnapshot: () => set({ snapshotKeys: null }),

        glowKey: null,
        setGlow: (glowKey) => set({ glowKey }),

        activeKey: null,
        setActiveKey: (activeKey) => set({ activeKey }),

        draft: null,
        setDraft: (draft) => set({ draft }),
        clearDraft: () => set({ draft: null }),

        navigatedFromGrid: null,
        setNavigatedFromGrid: (navigatedFromGrid) => set({ navigatedFromGrid }),
      }),
      {
        name: AGENT_GRID_STORAGE_KEY,
        version: AGENT_GRID_STORE_VERSION,
        storage: createValidatedPersistStorage(AsyncStorage, AgentGridPersistedStateSchema),
        partialize: (state) => ({
          view: state.view,
          visibleCount: state.visibleCount,
          direction: state.direction,
        }),
        migrate: migrateAgentGridState,
      },
    ),
  );
