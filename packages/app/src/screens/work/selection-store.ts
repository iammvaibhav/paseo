import { create } from "zustand";

interface WorkSelectionState {
  selectedProjectKey: string | null;
  setSelectedProjectKey: (key: string | null) => void;
}

const useWorkSelectionStore = create<WorkSelectionState>()((set) => ({
  selectedProjectKey: null,
  setSelectedProjectKey: (key) =>
    set((state) => (state.selectedProjectKey === key ? state : { selectedProjectKey: key })),
}));

export function useSelectedWorkProjectKey(): string | null {
  return useWorkSelectionStore((state) => state.selectedProjectKey);
}

export function setSelectedWorkProjectKey(key: string | null): void {
  useWorkSelectionStore.getState().setSelectedProjectKey(key);
}
