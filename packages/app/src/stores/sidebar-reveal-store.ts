import { create } from "zustand";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

/**
 * A one-shot request for the sidebar to bring a project into view. The project row consumes it:
 * it scrolls itself into view and highlights briefly. `nonce` lets the same project be revealed
 * twice in a row.
 */
interface SidebarRevealState {
  projectViewKey: string | null;
  nonce: number;
  request: (projectViewKey: string) => void;
  clear: (nonce: number) => void;
}

export const useSidebarRevealStore = create<SidebarRevealState>()((set) => ({
  projectViewKey: null,
  nonce: 0,
  request: (projectViewKey) => set((state) => ({ projectViewKey, nonce: state.nonce + 1 })),
  clear: (nonce) => set((state) => (state.nonce === nonce ? { projectViewKey: null } : state)),
}));

/**
 * Show a project and its workspaces in the sidebar: open the sidebar, switch it to the
 * project-grouped workspace list (the only view with project rows), expand the project, and ask
 * its row to scroll into view.
 */
export function revealProjectInSidebar(input: { projectViewKey: string; isCompact: boolean }) {
  usePanelStore.getState().openAgentListForLayout({ isCompact: input.isCompact });
  const view = useSidebarViewStore.getState();
  if (view.viewMode !== "workspaces") view.setViewMode("workspaces");
  if (view.groupMode !== "project") view.setGroupMode("project");
  useSidebarCollapsedSectionsStore.getState().setProjectCollapsed(input.projectViewKey, false);
  useSidebarRevealStore.getState().request(input.projectViewKey);
}
