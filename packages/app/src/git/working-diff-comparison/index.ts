import { useCallback } from "react";
import { create } from "zustand";
import {
  expireWorkingDiffComparisonsInState,
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
      isDirty: boolean;
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

export function useWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & { isDirty: boolean },
): {
  comparison: WorkingDiffComparison;
  selectComparison: (comparison: WorkingDiffComparison) => void;
  baseRef: string | null;
  selectBaseRef: (baseRef: string | null) => void;
} {
  const { serverId, workspaceId, cwd, isDirty } = input;
  const comparison = useWorkingDiffComparisonStore((state) =>
    resolveWorkingDiffComparisonFromState(state, { serverId, workspaceId, cwd, isDirty }),
  );
  const baseRef = useWorkingDiffComparisonStore((state) =>
    resolveWorkingDiffBaseRefFromState(state, { serverId, workspaceId, cwd }),
  );
  const select = useWorkingDiffComparisonStore((state) => state.select);
  const selectStoreBaseRef = useWorkingDiffComparisonStore((state) => state.selectBaseRef);
  const selectComparison = useCallback(
    (next: WorkingDiffComparison) =>
      select({ serverId, workspaceId, cwd, isDirty, comparison: next }),
    [cwd, isDirty, select, serverId, workspaceId],
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
    isDirty: boolean;
  },
): void {
  useWorkingDiffComparisonStore.getState().select(input);
}

export function resolveWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & { isDirty: boolean },
): WorkingDiffComparison {
  return resolveWorkingDiffComparisonFromState(useWorkingDiffComparisonStore.getState(), input);
}

export function expireWorkingDiffComparisons(input: {
  serverId: string;
  cwd: string;
  isDirty: boolean;
}): void {
  useWorkingDiffComparisonStore.setState((state) =>
    expireWorkingDiffComparisonsInState(state, input),
  );
}

export function resetWorkingDiffComparisons(): void {
  useWorkingDiffComparisonStore.setState({ overrides: {}, baseRefs: {} });
}
