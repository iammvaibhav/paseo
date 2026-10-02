import { create } from "zustand";

/**
 * Inspector intent: what the embedded Mission Control inspector should show.
 *
 * The board and feed cards never navigate — they set this intent and the
 * screen's inspector subscribes and swaps its content in place. A press on the
 * already-open target is a no-op (revision unchanged); pressing a different
 * agent bumps the revision so the inspector swaps content.
 */
export interface InspectorTarget {
  serverId: string;
  agentId: string;
}

interface InspectorState {
  /** The agent the inspector currently shows, or null (inspector closed). */
  target: InspectorTarget | null;
  /** Bumped on every content-changing intent so subscribers can react. */
  revision: number;
  openInspectorAgent: (target: InspectorTarget) => void;
  closeInspector: () => void;
}

export const useInspectorStore = create<InspectorState>()((set) => ({
  target: null,
  revision: 0,
  openInspectorAgent: (target) =>
    set((state) => {
      if (
        state.target !== null &&
        state.target.serverId === target.serverId &&
        state.target.agentId === target.agentId
      ) {
        // Same agent already open — idempotent, keep the revision.
        return state;
      }
      return { target, revision: state.revision + 1 };
    }),
  closeInspector: () =>
    set((state) =>
      state.target === null ? state : { target: null, revision: state.revision + 1 },
    ),
}));
