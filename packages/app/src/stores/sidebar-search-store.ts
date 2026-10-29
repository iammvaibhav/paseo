import { create } from "zustand";

/** The sidebar search bar. Not persisted: a search is over once the bar closes. */
interface SidebarSearchStoreState {
  isOpen: boolean;
  query: string;
  includeArchived: boolean;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setIncludeArchived: (includeArchived: boolean) => void;
}

export const useSidebarSearchStore = create<SidebarSearchStoreState>((set) => ({
  isOpen: false,
  query: "",
  includeArchived: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, query: "", includeArchived: false }),
  setQuery: (query) => set({ query }),
  setIncludeArchived: (includeArchived) => set({ includeArchived }),
}));
