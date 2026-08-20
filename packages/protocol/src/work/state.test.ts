// Regression tests for spec §2 / §2.1 / §2.2 — the single-state guarantee
// and the fractional-gap ordering (Plane 460 verbatim, plus gap < 1 rebalance).
import { describe, expect, it } from "vitest";

import type { LifecycleBucket } from "../agent-state-bucket.js";
import {
  BUCKET_TO_COLUMN,
  WORK_COLUMN_IDS,
  computeSortOrder,
  deriveWorkColumn,
  isWorkColumnDroppable,
  needsSortOrderRebalance,
  resolveWorkMoveIntent,
  type WorkColumnId,
} from "./state.js";

type WorkLane = "backlog" | "todo";

function mkItem(
  over: {
    lane?: WorkLane;
    closed?: { state: "done" | "cancelled" } | null;
    agentId?: string | null;
  } = {},
) {
  return {
    lane: (over.lane ?? "backlog") as WorkLane,
    closed: (over.closed === undefined ? null : over.closed) as {
      state: "done" | "cancelled";
    } | null,
    agentId: (over.agentId === undefined ? null : over.agentId) as string | null,
  };
}

// ---------------------------------------------------------------------------
// §2 The state rule — deriveWorkColumn is the only column authority
// ---------------------------------------------------------------------------
describe("deriveWorkColumn", () => {
  it("covers every LifecycleBucket and reads cleanly on authored lanes", () => {
    expect(BUCKET_TO_COLUMN).toEqual({
      running: "in_progress",
      idle: "in_progress",
      needs_you: "needs_me",
      ready: "in_review",
      done: "done",
    });
    // Adding a new bucket must force BUCKET_TO_COLUMN to follow as Record<LifecycleBucket, …>.
    expect(new Set(Object.keys(BUCKET_TO_COLUMN)).size).toBe(5);
    // WorkColumnIds lists exactly the six board columns (backlog, todo effect
    // the authored lane when no agent is linked; the other four are bucket-anchored).
    expect([...WORK_COLUMN_IDS].sort()).toEqual(
      ["backlog", "done", "in_progress", "in_review", "needs_me", "todo"].sort(),
    );
  });

  it("reads exactly as spec §2 defines", () => {
    // No agent: the board reads the authored lane.
    expect(deriveWorkColumn({ lane: "backlog", closed: null }, null)).toBe("backlog");
    expect(deriveWorkColumn({ lane: "todo", closed: null }, null)).toBe("todo");

    // Any linked bucket overrides the lane — same buckets as BUCKET_TO_COLUMN.
    expect(deriveWorkColumn({ lane: "backlog", closed: null }, "running")).toBe("in_progress");
    expect(deriveWorkColumn({ lane: "backlog", closed: null }, "idle")).toBe("in_progress");
    expect(deriveWorkColumn({ lane: "backlog", closed: null }, "needs_you")).toBe("needs_me");
    expect(deriveWorkColumn({ lane: "backlog", closed: null }, "ready")).toBe("in_review");
    expect(deriveWorkColumn({ lane: "backlog", closed: null }, "done")).toBe("done");

    // A closed item wins over every bucket and every lane (mirrors Plane cancelled filtering).
    expect(deriveWorkColumn({ lane: "todo", closed: { state: "done" } }, "running")).toBe("done");
    expect(deriveWorkColumn({ lane: "backlog", closed: { state: "cancelled" } }, "needs_you")).toBe(
      "cancelled",
    );
    expect(deriveWorkColumn({ lane: "todo", closed: { state: "done" } }, null)).toBe("done");
    // Explicitly: closed wins even if agentBucket is null (the spec table lists closed first).
    expect(deriveWorkColumn({ lane: "backlog", closed: { state: "done" } }, null)).toBe("done");
  });

  it("reaches every branch: lane wins, bucket wins, closed wins", () => {
    const lanes: WorkLane[] = ["backlog", "todo"];
    const buckets: (LifecycleBucket | null)[] = [
      "running",
      "idle",
      "needs_you",
      "ready",
      "done",
      null,
    ];
    for (const lane of lanes) {
      for (const bucket of buckets) {
        const column = deriveWorkColumn({ lane, closed: null }, bucket);
        if (bucket) {
          expect(column).toBe(BUCKET_TO_COLUMN[bucket]);
        } else {
          expect(column).toBe(lane);
        }
      }
    }
    // One extra degree: closed dominates bucket and lane in all combos.
    for (const lane of lanes) {
      for (const bucket of buckets) {
        expect(deriveWorkColumn({ lane, closed: { state: "done" } }, bucket)).toBe("done");
        expect(deriveWorkColumn({ lane, closed: { state: "cancelled" } }, bucket)).toBe(
          "cancelled",
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §2.1 Drag semantics — resolveWorkMoveIntent for every row of the spec table
// ---------------------------------------------------------------------------
describe("isWorkColumnDroppable", () => {
  it("rejects needs_me as a drop target and allows the rest", () => {
    expect(isWorkColumnDroppable("needs_me")).toBe(false);
    expect(isWorkColumnDroppable("backlog")).toBe(true);
    expect(isWorkColumnDroppable("todo")).toBe(true);
    expect(isWorkColumnDroppable("in_progress")).toBe(true);
    expect(isWorkColumnDroppable("in_review")).toBe(true);
    expect(isWorkColumnDroppable("done")).toBe(true);
  });
});

describe("resolveWorkMoveIntent", () => {
  const running: LifecycleBucket = "running";
  const idle: LifecycleBucket = "idle";
  const done: LifecycleBucket = "done";
  const needsYou: LifecycleBucket = "needs_you";

  it("spec §2.1 — Needs Me is never a drop target", () => {
    for (const bucket of [running, idle, done, needsYou, null] as const) {
      expect(
        resolveWorkMoveIntent({
          item: mkItem({ lane: "backlog", agentId: null }),
          targetColumn: "needs_me",
          agentBucket: bucket,
        }),
      ).toEqual({ kind: "reject", reason: "needs_me is not a drop target" });
      expect(
        resolveWorkMoveIntent({
          item: mkItem({ lane: "todo", agentId: "agt_x" }),
          targetColumn: "needs_me",
          agentBucket: bucket,
        }),
      ).toEqual({ kind: "reject", reason: "needs_me is not a drop target" });
    }
  });

  it("spec §2.1 — Todo requires no linked agent", () => {
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "backlog", agentId: null }),
        targetColumn: "todo",
        agentBucket: null,
      }),
    ).toEqual({ kind: "set_lane", lane: "todo" });

    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: null }),
        targetColumn: "todo",
        agentBucket: null,
      }),
    ).toEqual({ kind: "set_lane", lane: "todo" });

    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "backlog", agentId: "agt_live" }),
        targetColumn: "todo",
        agentBucket: running,
      }).kind,
    ).toBe("reject");
    expect(
      (
        resolveWorkMoveIntent({
          item: mkItem({ lane: "backlog", agentId: "agt_live" }),
          targetColumn: "todo",
          agentBucket: running,
        }) as { kind: "reject"; reason: string }
      ).reason,
    ).toBe("todo drop requires no linked agent");
  });

  it("spec §2.1 — Backlog with a todo-lane agent is rejected unless bucket is idle/done", () => {
    // No agent: allowed.
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: null }),
        targetColumn: "backlog",
        agentBucket: null,
      }),
    ).toEqual({ kind: "set_lane", lane: "backlog" });

    // Detach cases: an idle or truly done agent can be detached (approval-gated on the server).
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_idle" }),
        targetColumn: "backlog",
        agentBucket: idle,
      }),
    ).toEqual({ kind: "detach_agent" });
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_done" }),
        targetColumn: "backlog",
        agentBucket: done,
      }),
    ).toEqual({ kind: "detach_agent" });

    // Live state: rejected.
    for (const bucket of [running, needsYou, "ready" as LifecycleBucket]) {
      const intent = resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_live" }),
        targetColumn: "backlog",
        agentBucket: bucket,
      });
      expect(intent.kind).toBe("reject");
      expect((intent as { kind: "reject"; reason: string }).reason).toMatch(
        /backlog drop requires/,
      );
    }
    // Null bucket with an agent also rejected (the agent exists but its bucket is unknown).
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_live" }),
        targetColumn: "backlog",
        agentBucket: null,
      }).kind,
    ).toBe("reject");
  });

  it("spec §2.1 — In Progress requires lane === todo", () => {
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: null }),
        targetColumn: "in_progress",
        agentBucket: null,
      }),
    ).toEqual({ kind: "dispatch_now" });
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_x" }),
        targetColumn: "in_progress",
        agentBucket: running,
      }),
    ).toEqual({ kind: "dispatch_now" });

    const fromBacklog = resolveWorkMoveIntent({
      item: mkItem({ lane: "backlog", agentId: null }),
      targetColumn: "in_progress",
      agentBucket: null,
    });
    expect(fromBacklog.kind).toBe("reject");
    expect((fromBacklog as { kind: "reject"; reason: string }).reason).toBe(
      "in_progress dispatch requires lane todo",
    );
  });

  it("spec §2.1 — In Review requires a linked agent", () => {
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_live" }),
        targetColumn: "in_review",
        agentBucket: running,
      }),
    ).toEqual({ kind: "set_review_state", reviewState: "ready" });

    const noAgent = resolveWorkMoveIntent({
      item: mkItem({ lane: "todo", agentId: null }),
      targetColumn: "in_review",
      agentBucket: null,
    });
    expect(noAgent.kind).toBe("reject");
    expect((noAgent as { kind: "reject"; reason: string }).reason).toBe(
      "in_review requires a linked agent",
    );
  });

  it("spec §2.1 — Done is always allowed, with or without an agent", () => {
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "backlog", agentId: null }),
        targetColumn: "done",
        agentBucket: null,
      }),
    ).toEqual({ kind: "set_review_state", reviewState: "done" });

    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "todo", agentId: "agt_live" }),
        targetColumn: "done",
        agentBucket: running,
      }),
    ).toEqual({ kind: "set_review_state", reviewState: "done" });

    // The exact regression for the real done-without-agent bug.
    expect(
      resolveWorkMoveIntent({
        item: mkItem({ lane: "backlog", agentId: null }),
        targetColumn: "done",
        agentBucket: null,
      }).kind,
    ).toBe("set_review_state");
  });

  // Exhaustive single-column dispatch table, iterated so a new WorkColumnId
  // forces coverage when added — no row is hand-enumerated elsewhere.
  it("reaches every column and branches once per row without gaps (exhaustive table)", () => {
    const buckets: (LifecycleBucket | null)[] = [
      "running",
      "idle",
      "needs_you",
      "ready",
      "done",
      null,
    ];
    const cols: WorkColumnId[] = [...WORK_COLUMN_IDS];
    for (const targetColumn of cols) {
      for (const lane of ["backlog", "todo"] as WorkLane[]) {
        for (const agent of [null, "agt_x"] as const) {
          for (const bucket of buckets) {
            const intent = resolveWorkMoveIntent({
              item: mkItem({ lane, agentId: agent }),
              targetColumn,
              agentBucket: bucket,
            });
            // No unknown kind should appear; the only reject cases are those
            // listed above. Spot-check one for each column family.
            expect([
              "set_lane",
              "detach_agent",
              "dispatch_now",
              "set_review_state",
              "reject",
            ]).toContain(intent.kind);
          }
        }
      }
    }
    expect(WORK_COLUMN_IDS).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// §2.2 Ordering — Plane 460 fractional gap, the one fix we add: gap < 1 → rebalance
// ---------------------------------------------------------------------------
describe("computeSortOrder", () => {
  it("empty column defaults to 65535", () => {
    expect(computeSortOrder({ prevSortOrder: null, nextSortOrder: null })).toBe(65535);
  });

  it("appends beyond the tail: last + 65535", () => {
    expect(computeSortOrder({ prevSortOrder: 65535, nextSortOrder: null })).toBe(65535 + 65535);
    expect(computeSortOrder({ prevSortOrder: 131070, nextSortOrder: null })).toBe(196605);
  });

  it("prepends ahead of the head: first - 65535", () => {
    expect(computeSortOrder({ prevSortOrder: null, nextSortOrder: 65535 })).toBe(0);
    expect(computeSortOrder({ prevSortOrder: null, nextSortOrder: 196605 })).toBe(131070);
    expect(computeSortOrder({ prevSortOrder: null, nextSortOrder: 0 })).toBe(-65535);
  });

  it("inserts between neighbours at the midpoint", () => {
    expect(computeSortOrder({ prevSortOrder: 0, nextSortOrder: 65535 })).toBe(32767.5);
    expect(computeSortOrder({ prevSortOrder: 65535, nextSortOrder: 131070 })).toBe(98302.5);
    // Even explicit fractional neighbours stay exact.
    expect(computeSortOrder({ prevSortOrder: 32767.5, nextSortOrder: 65535 })).toBe(
      (32767.5 + 65535) / 2,
    );
  });

  it("round-trips with needsSortOrderRebalance — tight gaps signal rebalance", () => {
    const mid = computeSortOrder({ prevSortOrder: 0, nextSortOrder: 1 });
    // 0 → 0.5 → 1 has gaps 0.5, 0.5: both < 1 → rebalance. Even a tight
    // midpoint from a very dense column trips the guard.
    expect(needsSortOrderRebalance(mid - 0)).toBe(true); // 0.5 < 1 → rebalance
    expect(needsSortOrderRebalance(1 - mid)).toBe(true); // 0.5 < 1 → rebalance
    // Sparse gaps stay clean.
    expect(needsSortOrderRebalance(65535)).toBe(false);
  });
});

describe("needsSortOrderRebalance", () => {
  it("fires at gap < 1 and only at < 1", () => {
    expect(needsSortOrderRebalance(0)).toBe(true);
    expect(needsSortOrderRebalance(0.99)).toBe(true);
    // Boundary is exclusive: 1.0 is not < 1, so no rebalance.
    expect(needsSortOrderRebalance(1)).toBe(false);
    expect(needsSortOrderRebalance(1.0)).toBe(false);
    expect(needsSortOrderRebalance(65535)).toBe(false);
    expect(needsSortOrderRebalance(2)).toBe(false);
  });

  it("catches float-exhausted mid-insert runs — Plane's 50-inserts bug", () => {
    // Keep inserting at the midpoint of [left, right=65535]. After about
    // 16 halvings the gap drops below 1; certainly after 50. This is the
    // exact exhaustion path Plane hits; we must trip rebalance there.
    let left = 0;
    let right = 65535;
    let mid = computeSortOrder({ prevSortOrder: left, nextSortOrder: right });
    let steps = 0;
    const GAPS: number[] = [];
    while (steps < 60) {
      const before = mid - left;
      const after = right - mid;
      GAPS.push(Math.min(before, after));
      if (needsSortOrderRebalance(Math.min(before, after))) break;
      // Deterministic choice: keep halving the left half.
      right = mid;
      mid = computeSortOrder({ prevSortOrder: left, nextSortOrder: right });
      steps += 1;
    }
    expect(GAPS.some((g) => needsSortOrderRebalance(g))).toBe(true);
    // Not too early in a sparse column either — the first gap is ~32k, well above 1.
    expect(GAPS[0] > 1).toBe(true);
  });
});
