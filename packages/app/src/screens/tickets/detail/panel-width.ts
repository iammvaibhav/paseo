import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export const DEFAULT_TICKET_PANEL_WIDTH = 560;
export const MIN_TICKET_PANEL_WIDTH = 400;
export const MAX_TICKET_PANEL_WIDTH = 960;

const STORAGE_KEY = "ticket-detail-panel";
const STORE_VERSION = 1;

interface TicketPanelWidthState {
  width: number;
  setWidth: (width: number) => void;
}

const PersistedSchema = z.strictObject({
  width: z.number(),
});

type PersistedTicketPanelWidth = z.infer<typeof PersistedSchema>;

export function clampTicketPanelWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_TICKET_PANEL_WIDTH;
  }
  return Math.max(MIN_TICKET_PANEL_WIDTH, Math.min(MAX_TICKET_PANEL_WIDTH, width));
}

/** Width of the desktop ticket side panel, persisted like the inspector rail. */
export const useTicketPanelWidthStore = create<TicketPanelWidthState>()(
  persist(
    (set) => ({
      width: DEFAULT_TICKET_PANEL_WIDTH,
      setWidth: (width) => set({ width: clampTicketPanelWidth(width) }),
    }),
    {
      name: STORAGE_KEY,
      version: STORE_VERSION,
      storage: createValidatedPersistStorage<PersistedTicketPanelWidth>(
        AsyncStorage,
        PersistedSchema,
      ),
      partialize: (state) => ({ width: state.width }),
    },
  ),
);
