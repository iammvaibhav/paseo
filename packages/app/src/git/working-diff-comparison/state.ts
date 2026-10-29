export type WorkingDiffComparison = "uncommitted" | "base" | "all";

export interface WorkingDiffComparisonOverride {
  comparison: WorkingDiffComparison;
}

export interface WorkingDiffComparisonState {
  overrides: Record<string, WorkingDiffComparisonOverride>;
  // A picked comparison base is a separate decision from the mode: it outlives mode flips.
  // Keyed per checkout, so another workspace never inherits it.
  baseRefs: Record<string, string>;
}

export interface WorkingDiffCheckoutIdentity {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
}

export function workingDiffComparisonKey(input: WorkingDiffCheckoutIdentity): string {
  const workspaceId = input.workspaceId?.trim();
  const checkout = workspaceId
    ? `workspace=${encodeURIComponent(workspaceId)}`
    : `cwd=${encodeURIComponent(normalizeCwd(input.cwd))}`;
  return `working-diff:server=${encodeURIComponent(input.serverId.trim())}:${checkout}`;
}

export function selectWorkingDiffComparisonInState(
  state: WorkingDiffComparisonState,
  input: WorkingDiffCheckoutIdentity & {
    comparison: WorkingDiffComparison;
  },
): WorkingDiffComparisonState {
  return {
    ...state,
    overrides: {
      ...state.overrides,
      [workingDiffComparisonKey(input)]: {
        comparison: input.comparison,
      },
    },
  };
}

export function resolveWorkingDiffComparisonFromState(
  state: WorkingDiffComparisonState,
  input: WorkingDiffCheckoutIdentity,
): WorkingDiffComparison {
  return state.overrides[workingDiffComparisonKey(input)]?.comparison ?? "all";
}

export function selectWorkingDiffBaseRefInState(
  state: WorkingDiffComparisonState,
  input: WorkingDiffCheckoutIdentity & { baseRef: string | null },
): WorkingDiffComparisonState {
  const key = workingDiffComparisonKey(input);
  const baseRef = input.baseRef?.trim();
  if (!baseRef) {
    if (!(key in state.baseRefs)) return state;
    const baseRefs = { ...state.baseRefs };
    delete baseRefs[key];
    return { ...state, baseRefs };
  }
  if (state.baseRefs[key] === baseRef) return state;
  return { ...state, baseRefs: { ...state.baseRefs, [key]: baseRef } };
}

export function resolveWorkingDiffBaseRefFromState(
  state: WorkingDiffComparisonState,
  input: WorkingDiffCheckoutIdentity,
): string | null {
  return state.baseRefs[workingDiffComparisonKey(input)] ?? null;
}
