import { create } from "zustand";
import type { HistoryAskScope } from "./scope";

export type HistoryAskTab = "agents" | "ask";

interface HistoryAskStoreState {
  pendingScope: HistoryAskScope | null;
  activeTab: HistoryAskTab;
  setPendingScope: (scope: HistoryAskScope) => void;
  clearPending: () => void;
  setActiveTab: (tab: HistoryAskTab) => void;
}

export const useHistoryAskStore = create<HistoryAskStoreState>((set) => ({
  pendingScope: null,
  activeTab: "agents",
  setPendingScope: (scope) => set({ pendingScope: scope, activeTab: "ask" }),
  clearPending: () => set({ pendingScope: null }),
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
