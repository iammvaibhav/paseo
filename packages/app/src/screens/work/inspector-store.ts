import { useMemo } from "react";
import { create } from "zustand";

/**
 * Work inspector intent: which work item the right-hand pane shows.
 *
 * Copies Mission Control's `{ target, revision }` shape. Reopening the same
 * item bumps `revision` so subscribers can re-focus / scroll to top.
 */
export interface WorkInspectorTarget {
  itemId: string;
}

interface WorkInspectorState {
  target: WorkInspectorTarget | null;
  revision: number;
  openWorkItem: (itemId: string) => void;
  closeWorkInspector: () => void;
}

const useWorkInspectorStore = create<WorkInspectorState>()((set) => ({
  target: null,
  revision: 0,
  openWorkItem: (itemId) =>
    set((state) => {
      if (state.target?.itemId === itemId) {
        return { target: state.target, revision: state.revision + 1 };
      }
      return { target: { itemId }, revision: state.revision + 1 };
    }),
  closeWorkInspector: () =>
    set((state) =>
      state.target === null ? state : { target: null, revision: state.revision + 1 },
    ),
}));

/** Subscribe to the current work inspector target and its revision. */
export function useWorkInspectorTarget(): {
  target: WorkInspectorTarget | null;
  revision: number;
} {
  const target = useWorkInspectorStore((state) => state.target);
  const revision = useWorkInspectorStore((state) => state.revision);
  return useMemo(() => ({ target, revision }), [target, revision]);
}

/** Open the inspector on a work item. Bumps revision even if already open. */
export function openWorkItem(itemId: string): void {
  useWorkInspectorStore.getState().openWorkItem(itemId);
}

/** Close the inspector. */
export function closeWorkInspector(): void {
  useWorkInspectorStore.getState().closeWorkInspector();
}
