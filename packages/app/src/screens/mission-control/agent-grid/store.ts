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

interface AgentGridStoreState {
  view: MissionControlView;
  visibleCount: number;
  direction: AgentGridDirection;
  setView: (view: MissionControlView) => void;
  setVisibleCount: (count: number) => void;
  setDirection: (direction: AgentGridDirection) => void;
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
