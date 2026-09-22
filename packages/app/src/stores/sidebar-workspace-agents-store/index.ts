import { create } from "zustand";

export type SidebarAgentsSort = "activity" | "created";

interface SidebarWorkspaceAgentsState {
  /** Workspace keys whose expanded agent list is open. */
  expandedWorkspaceKeys: Set<string>;
  /** How an expanded agent list is ordered. */
  agentsSort: SidebarAgentsSort;
  toggleWorkspaceExpanded: (workspaceKey: string) => void;
  setAgentsSort: (sort: SidebarAgentsSort) => void;
}

/**
 * In-memory sidebar state for the per-workspace agent expansion: which workspaces are
 * expanded and how their agent lists are sorted. Deliberately not persisted — expansion is
 * transient exploration state, like the "show more" group expansion, and stale workspace
 * keys would accumulate in storage.
 */
export const useSidebarWorkspaceAgentsStore = create<SidebarWorkspaceAgentsState>()((set) => ({
  expandedWorkspaceKeys: new Set(),
  agentsSort: "activity",
  toggleWorkspaceExpanded: (workspaceKey) =>
    set((state) => {
      const next = new Set(state.expandedWorkspaceKeys);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return { expandedWorkspaceKeys: next };
    }),
  setAgentsSort: (agentsSort) => set({ agentsSort }),
}));
