import { create } from "zustand";

/**
 * The sidebar search bar. It is always on screen; a blank query means no search.
 * Not persisted: a search does not survive a reload.
 */
interface SidebarSearchStoreState {
  query: string;
  /** The bar has focus; focusing it warms each host's search before the first query. */
  inputFocused: boolean;
  setQuery: (query: string) => void;
  setInputFocused: (inputFocused: boolean) => void;
  clear: () => void;
}

export const useSidebarSearchStore = create<SidebarSearchStoreState>((set) => ({
  query: "",
  inputFocused: false,
  setQuery: (query) => set({ query }),
  setInputFocused: (inputFocused) => set({ inputFocused }),
  clear: () => set({ query: "" }),
}));
