import { create } from "zustand";
import type { HistoryAskScope } from "./scope";

export type HistoryAskTab = "agents" | "ask";

interface HistoryAskStoreState {
  pendingScope: HistoryAskScope | null;
  pendingQuestion: string | null;
  activeTab: HistoryAskTab;
  setPendingScope: (scope: HistoryAskScope) => void;
  clearPending: () => void;
  setActiveTab: (tab: HistoryAskTab) => void;
  askAboutSearch: (question: string) => void;
  consumePendingQuestion: () => void;
}

export const useHistoryAskStore = create<HistoryAskStoreState>((set) => ({
  pendingScope: null,
  pendingQuestion: null,
  activeTab: "agents",
  setPendingScope: (scope) => set({ pendingScope: scope, activeTab: "ask" }),
  clearPending: () => set({ pendingScope: null }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  askAboutSearch: (question) => set({ pendingQuestion: question, activeTab: "ask" }),
  consumePendingQuestion: () => set({ pendingQuestion: null }),
}));
