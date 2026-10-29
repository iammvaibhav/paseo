import { useCallback } from "react";
import { create } from "zustand";
import {
  resolveWorkingDiffBaseRefFromState,
  resolveWorkingDiffComparisonFromState,
  selectWorkingDiffBaseRefInState,
  selectWorkingDiffComparisonInState,
  type WorkingDiffCheckoutIdentity,
  type WorkingDiffComparison,
  type WorkingDiffComparisonState,
} from "./state";

interface WorkingDiffComparisonStore extends WorkingDiffComparisonState {
  select: (
    input: WorkingDiffCheckoutIdentity & {
      comparison: WorkingDiffComparison;
    },
  ) => void;
  selectBaseRef: (input: WorkingDiffCheckoutIdentity & { baseRef: string | null }) => void;
}

const useWorkingDiffComparisonStore = create<WorkingDiffComparisonStore>((set) => ({
  overrides: {},
  baseRefs: {},
  select: (input) => set((state) => selectWorkingDiffComparisonInState(state, input)),
  selectBaseRef: (input) => set((state) => selectWorkingDiffBaseRefInState(state, input)),
}));

export function useWorkingDiffComparison(input: WorkingDiffCheckoutIdentity): {
  comparison: WorkingDiffComparison;
  selectComparison: (comparison: WorkingDiffComparison) => void;
  baseRef: string | null;
  selectBaseRef: (baseRef: string | null) => void;
} {
  const { serverId, workspaceId, cwd } = input;
  const comparison = useWorkingDiffComparisonStore((state) =>
    resolveWorkingDiffComparisonFromState(state, { serverId, workspaceId, cwd }),
  );
  const baseRef = useWorkingDiffComparisonStore((state) =>
    resolveWorkingDiffBaseRefFromState(state, { serverId, workspaceId, cwd }),
  );
  const select = useWorkingDiffComparisonStore((state) => state.select);
  const selectStoreBaseRef = useWorkingDiffComparisonStore((state) => state.selectBaseRef);
  const selectComparison = useCallback(
    (next: WorkingDiffComparison) => select({ serverId, workspaceId, cwd, comparison: next }),
    [cwd, select, serverId, workspaceId],
  );
  const selectBaseRef = useCallback(
    (next: string | null) => selectStoreBaseRef({ serverId, workspaceId, cwd, baseRef: next }),
    [cwd, selectStoreBaseRef, serverId, workspaceId],
  );
  return { comparison, selectComparison, baseRef, selectBaseRef };
}

export function selectWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & {
    comparison: WorkingDiffComparison;
  },
): void {
  useWorkingDiffComparisonStore.getState().select(input);
}

export function resolveWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity,
): WorkingDiffComparison {
  return resolveWorkingDiffComparisonFromState(useWorkingDiffComparisonStore.getState(), input);
}

export function resetWorkingDiffComparisons(): void {
  useWorkingDiffComparisonStore.setState({ overrides: {}, baseRefs: {} });
}
