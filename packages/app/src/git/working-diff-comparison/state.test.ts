import { describe, expect, it } from "vitest";
import {
  resolveWorkingDiffBaseRefFromState,
  resolveWorkingDiffComparisonFromState,
  selectWorkingDiffBaseRefInState,
  selectWorkingDiffComparisonInState,
  type WorkingDiffComparisonState,
  workingDiffComparisonKey,
} from "./state";

const checkout = { serverId: "server-1", workspaceId: "workspace-1", cwd: "/repo" };

function emptyState(): WorkingDiffComparisonState {
  return { overrides: {}, baseRefs: {} };
}

describe("working diff comparison", () => {
  it("scopes selection to the workspace checkout rather than a panel", () => {
    expect(workingDiffComparisonKey(checkout)).toBe(
      "working-diff:server=server-1:workspace=workspace-1",
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: "workspace-2" })).not.toBe(
      workingDiffComparisonKey(checkout),
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: null, cwd: "/repo/" })).toBe(
      "working-diff:server=server-1:cwd=%2Frepo",
    );
  });

  it.each([true, false])("defaults to All changes when checkout dirtiness is %s", (isDirty) => {
    const status = { ...checkout, isDirty };
    expect(resolveWorkingDiffComparisonFromState(emptyState(), status)).toBe("all");
  });

  it.each(["all", "base", "uncommitted"] as const)(
    "keeps the selected %s comparison",
    (comparison) => {
      const selected = selectWorkingDiffComparisonInState(emptyState(), {
        ...checkout,
        comparison,
      });
      expect(resolveWorkingDiffComparisonFromState(selected, checkout)).toBe(comparison);
      expect(
        resolveWorkingDiffComparisonFromState(selected, { ...checkout, workspaceId: "other" }),
      ).toBe("all");
    },
  );

  it("scopes a picked base ref to the checkout and clears it on null", () => {
    expect(resolveWorkingDiffBaseRefFromState(emptyState(), checkout)).toBeNull();

    const picked = selectWorkingDiffBaseRefInState(emptyState(), {
      ...checkout,
      baseRef: "release/1.0",
    });
    expect(resolveWorkingDiffBaseRefFromState(picked, checkout)).toBe("release/1.0");
    expect(
      resolveWorkingDiffBaseRefFromState(picked, { ...checkout, workspaceId: "workspace-2" }),
    ).toBeNull();

    const cleared = selectWorkingDiffBaseRefInState(picked, { ...checkout, baseRef: null });
    expect(resolveWorkingDiffBaseRefFromState(cleared, checkout)).toBeNull();
    expect(selectWorkingDiffBaseRefInState(cleared, { ...checkout, baseRef: "  " })).toBe(cleared);
    expect(selectWorkingDiffBaseRefInState(picked, { ...checkout, baseRef: "release/1.0" })).toBe(
      picked,
    );
  });

  it("keeps a picked base ref across mode selection", () => {
    let state = selectWorkingDiffBaseRefInState(emptyState(), {
      ...checkout,
      baseRef: "release/1.0",
    });
    state = selectWorkingDiffComparisonInState(state, { ...checkout, comparison: "uncommitted" });
    state = selectWorkingDiffComparisonInState(state, { ...checkout, comparison: "base" });
    expect(resolveWorkingDiffComparisonFromState(state, checkout)).toBe("base");
    expect(resolveWorkingDiffBaseRefFromState(state, checkout)).toBe("release/1.0");
  });
});
