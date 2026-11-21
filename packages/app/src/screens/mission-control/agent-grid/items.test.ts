import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { LifecycleBucket, LifecycleRow } from "@/mission-control/lifecycle";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import {
  agentGridRunStartMs,
  buildAgentGridItems,
  insertSnapshotKey,
  resolveAgentGridSection,
} from "./items";

interface RowFixture {
  id: string;
  bucket: LifecycleBucket;
  status?: "running" | "idle";
  turn?: TurnLiveness;
  name?: string;
  sortTime?: number;
  archivedAt?: Date | null;
}

function makeRow(fixture: RowFixture): LifecycleRow {
  const { id, bucket, status, turn, name, sortTime } = fixture;
  return {
    bucket,
    reviewState: "none",
    verdict: null,
    doneReason: null,
    lastReportHeadline: null,
    lastEventAt: null,
    pendingProposalCount: 0,
    dormant: bucket === "dormant",
    withinWindow: true,
    snapshotTitle: null,
    snapshotName: null,
    snapshotShortDescription: null,
    snapshotStoppedBy: null,
    sortTime: sortTime ?? 0,
    agent: {
      id,
      serverId: "local",
      serverLabel: "Local",
      title: null,
      name: name ?? `Agent ${id}`,
      status: status ?? (bucket === "running" ? "running" : "idle"),
      turn: turn ?? TURN_LIVENESS_IDLE,
      lastActivityAt: new Date(0),
      lastUserMessageAt: null,
      cwd: "~",
      provider: "claude",
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      stoppedBy: null,
      archivedAt: fixture.archivedAt ?? null,
      createdAt: new Date(0),
      labels: {},
      projectPlacement: null,
      bucket,
    } as AggregatedAgent,
  };
}

function openTurn(startedAtMs: number | null): TurnLiveness {
  return {
    phase: "open",
    turnId: "turn-1",
    startedAt: startedAtMs === null ? null : new Date(startedAtMs),
    cancellationRequestId: null,
  };
}

function keysOf(rows: readonly { key: string }[]): string[] {
  return rows.map((row) => row.key);
}

describe("agentGridRunStartMs", () => {
  it("reads the open turn's start instant", () => {
    const row = makeRow({ id: "a", bucket: "running", turn: openTurn(5_000) });
    expect(agentGridRunStartMs(row)).toBe(5_000);
  });

  it("is null for a closed turn even while running", () => {
    const row = makeRow({
      id: "a",
      bucket: "running",
      turn: TURN_LIVENESS_IDLE,
    });
    expect(agentGridRunStartMs(row)).toBeNull();
  });
});

describe("resolveAgentGridSection", () => {
  it("shows running rows in the running section", () => {
    expect(resolveAgentGridSection(makeRow({ id: "a", bucket: "running" }))).toBe("running");
  });

  it("shows a needs_you row in the needs-you section regardless of agent status", () => {
    const runningRow = makeRow({ id: "a", bucket: "needs_you", status: "running" });
    expect(resolveAgentGridSection(runningRow)).toBe("needs-you");

    const idleRow = makeRow({ id: "b", bucket: "needs_you", status: "idle" });
    expect(resolveAgentGridSection(idleRow)).toBe("needs-you");
  });

  it("shows ready rows in the ready section", () => {
    expect(resolveAgentGridSection(makeRow({ id: "a", bucket: "ready" }))).toBe("ready");
  });

  it("hides done and dormant rows", () => {
    expect(resolveAgentGridSection(makeRow({ id: "a", bucket: "done" }))).toBeNull();
    expect(resolveAgentGridSection(makeRow({ id: "a", bucket: "dormant" }))).toBeNull();
  });
});

describe("buildAgentGridItems", () => {
  it("places the running section before the ready section", () => {
    const ready = makeRow({ id: "r", bucket: "ready" });
    const running = makeRow({
      id: "w",
      bucket: "running",
      turn: openTurn(1_000),
    });
    const items = buildAgentGridItems([ready, running]);
    expect(items.map((item) => item.section)).toEqual(["running", "ready"]);
  });
  it("places the needs-you section before running and ready sections", () => {
    const ready = makeRow({ id: "r", bucket: "ready", sortTime: 100 });
    const running = makeRow({
      id: "w",
      bucket: "running",
      turn: openTurn(1_000),
    });
    const needsYou = makeRow({
      id: "n",
      bucket: "needs_you",
      sortTime: 500,
    });
    const items = buildAgentGridItems([ready, running, needsYou]);
    expect(items.map((item) => item.section)).toEqual(["needs-you", "running", "ready"]);
    expect(keysOf(items)).toEqual(["local:n", "local:w", "local:r"]);
  });

  it("orders running rows by most recently started, with an unknown start last", () => {
    const older = makeRow({
      id: "a",
      bucket: "running",
      turn: openTurn(1_000),
    });
    const newer = makeRow({
      id: "b",
      bucket: "running",
      turn: openTurn(3_000),
    });
    const unknown = makeRow({
      id: "c",
      bucket: "running",
      turn: TURN_LIVENESS_IDLE,
    });
    const items = buildAgentGridItems([older, unknown, newer]);
    expect(keysOf(items)).toEqual(["local:b", "local:a", "local:c"]);
  });

  it("orders needs-you rows by sortTime descending regardless of agent status", () => {
    const older = makeRow({
      id: "p",
      bucket: "needs_you",
      status: "running",
      sortTime: 1_000,
    });
    const newer = makeRow({
      id: "i",
      bucket: "needs_you",
      status: "idle",
      sortTime: 3_000,
    });
    const items = buildAgentGridItems([older, newer]);
    expect(items).toEqual([
      { key: "local:i", section: "needs-you", row: newer },
      { key: "local:p", section: "needs-you", row: older },
    ]);
  });

  it("orders ready rows by sortTime descending", () => {
    const older = makeRow({ id: "a", bucket: "ready", sortTime: 100 });
    const newer = makeRow({ id: "b", bucket: "ready", sortTime: 200 });
    const items = buildAgentGridItems([older, newer]);
    expect(keysOf(items)).toEqual(["local:b", "local:a"]);
  });
  it("excludes done and dormant rows from dynamic pass", () => {
    const done = makeRow({ id: "d", bucket: "done" });
    const dormant = makeRow({ id: "m", bucket: "dormant" });
    const items = buildAgentGridItems([done, dormant]);
    expect(items).toEqual([]);
  });

  it("returns the exact same array reference when nothing changed", () => {
    const rows = [
      makeRow({ id: "a", bucket: "running", turn: openTurn(1_000) }),
      makeRow({ id: "b", bucket: "ready", sortTime: 100 }),
    ];
    const first = buildAgentGridItems(rows);
    const second = buildAgentGridItems(rows, first);
    expect(second).toBe(first);
  });

  it("moves a row from ready to running while every other item object stays identical", () => {
    const r1 = makeRow({ id: "r1", bucket: "running", turn: openTurn(5_000) });
    const r2 = makeRow({ id: "r2", bucket: "running", turn: openTurn(8_000) });
    const x = makeRow({ id: "rx", bucket: "ready", sortTime: 100 });
    const r3 = makeRow({ id: "r3", bucket: "ready", sortTime: 200 });

    const before = buildAgentGridItems([r1, r2, x, r3]);
    expect(keysOf(before)).toEqual(["local:r2", "local:r1", "local:r3", "local:rx"]);

    const xPromoted = makeRow({
      id: "rx",
      bucket: "running",
      turn: openTurn(9_000),
    });
    const after = buildAgentGridItems([r1, r2, xPromoted, r3], before);

    expect(after[0]).toMatchObject({ key: "local:rx", section: "running" });
    expect(keysOf(after)).toEqual(["local:rx", "local:r2", "local:r1", "local:r3"]);

    const beforeByKey = new Map(before.map((item) => [item.key, item]));
    for (const item of after) {
      if (item.key === "local:rx") {
        continue;
      }
      expect(item).toBe(beforeByKey.get(item.key));
    }
  });

  it("freezes snapshot order even when timestamps or sections change", () => {
    const a = makeRow({ id: "a", bucket: "running", turn: openTurn(1_000) });
    const b = makeRow({ id: "b", bucket: "ready", sortTime: 200 });
    const c = makeRow({ id: "c", bucket: "running", turn: openTurn(500) });

    const snapshotKeys = ["local:a", "local:b", "local:c"];
    const initial = buildAgentGridItems([a, b, c], undefined, snapshotKeys);
    expect(keysOf(initial)).toEqual(["local:a", "local:b", "local:c"]);

    // Row c starts a newer run that would sort first dynamically.
    // Row b also starts running.
    const cNewRun = makeRow({ id: "c", bucket: "running", turn: openTurn(10_000) });
    const bRunning = makeRow({ id: "b", bucket: "running", turn: openTurn(8_000) });
    const updated = buildAgentGridItems([a, bRunning, cNewRun], initial, snapshotKeys);

    // Order remains frozen in snapshot order
    expect(keysOf(updated)).toEqual(["local:a", "local:b", "local:c"]);
    // In-place section update for b
    expect(updated[1]).toMatchObject({ key: "local:b", section: "running" });
    // a was untouched, keeps reference identity
    expect(updated[0]).toBe(initial[0]);
  });

  it("appends newcomers after snapshot items, sorted needs-you then running then ready", () => {
    const snap1 = makeRow({ id: "s1", bucket: "running", turn: openTurn(1_000) });
    const snap2 = makeRow({ id: "s2", bucket: "ready", sortTime: 100 });
    const snapshotKeys = ["local:s1", "local:s2"];

    // Newcomers: one needs-you, two running with different start times, one ready
    const newNeedsYou = makeRow({ id: "nny", bucket: "needs_you", sortTime: 6_000 });
    const newRunOld = makeRow({ id: "nro", bucket: "running", turn: openTurn(2_000) });
    const newRunNew = makeRow({ id: "nrn", bucket: "running", turn: openTurn(5_000) });
    const newReady = makeRow({ id: "nready", bucket: "ready", sortTime: 300 });

    const items = buildAgentGridItems(
      [snap1, snap2, newRunOld, newNeedsYou, newRunNew, newReady],
      undefined,
      snapshotKeys,
    );

    expect(keysOf(items)).toEqual([
      "local:s1",
      "local:s2",
      "local:nny",
      "local:nrn",
      "local:nro",
      "local:nready",
    ]);
    expect(items.map((item) => item.section)).toEqual([
      "running",
      "ready",
      "needs-you",
      "running",
      "running",
      "ready",
    ]);
  });

  it("does not append newcomers that are done", () => {
    const snap1 = makeRow({ id: "s1", bucket: "running", turn: openTurn(1_000) });
    const snapshotKeys = ["local:s1"];
    const doneNewcomer = makeRow({ id: "dnew", bucket: "done" });

    const items = buildAgentGridItems([snap1, doneNewcomer], undefined, snapshotKeys);
    expect(keysOf(items)).toEqual(["local:s1"]);
  });

  it("retains an agent in snapshot that transitions to done with section done", () => {
    const a = makeRow({ id: "a", bucket: "running", turn: openTurn(2_000) });
    const b = makeRow({ id: "b", bucket: "ready", sortTime: 100 });
    const snapshotKeys = ["local:a", "local:b"];

    const initial = buildAgentGridItems([a, b], undefined, snapshotKeys);
    expect(keysOf(initial)).toEqual(["local:a", "local:b"]);

    // a finishes and transitions to done
    const aDone = makeRow({ id: "a", bucket: "done" });
    const updated = buildAgentGridItems([aDone, b], initial, snapshotKeys);

    expect(keysOf(updated)).toEqual(["local:a", "local:b"]);
    expect(updated[0]).toMatchObject({ key: "local:a", section: "done" });
    expect(updated[1]).toBe(initial[1]);
  });
  it("retains an agent in snapshot that transitions to needs-you with section needs-you", () => {
    const a = makeRow({ id: "a", bucket: "running", turn: openTurn(2_000) });
    const b = makeRow({ id: "b", bucket: "ready", sortTime: 100 });
    const snapshotKeys = ["local:a", "local:b"];

    const initial = buildAgentGridItems([a, b], undefined, snapshotKeys);
    expect(keysOf(initial)).toEqual(["local:a", "local:b"]);

    // a pauses on permission / input -> transitions to needs_you
    const aNeedsYou = makeRow({ id: "a", bucket: "needs_you", sortTime: 3_000 });
    const updated = buildAgentGridItems([aNeedsYou, b], initial, snapshotKeys);

    expect(keysOf(updated)).toEqual(["local:a", "local:b"]);
    expect(updated[0]).toMatchObject({ key: "local:a", section: "needs-you" });
    expect(updated[1]).toBe(initial[1]);
  });

  it("promotes an agent to needs-you above running and ready in dynamic mode", () => {
    const r1 = makeRow({ id: "r1", bucket: "running", turn: openTurn(5_000) });
    const r2 = makeRow({ id: "r2", bucket: "ready", sortTime: 100 });

    const before = buildAgentGridItems([r1, r2]);
    expect(keysOf(before)).toEqual(["local:r1", "local:r2"]);

    // r2 transitions to needs_you
    const r2NeedsYou = makeRow({ id: "r2", bucket: "needs_you", sortTime: 6_000 });
    const after = buildAgentGridItems([r1, r2NeedsYou], before);

    expect(keysOf(after)).toEqual(["local:r2", "local:r1"]);
    expect(after[0]).toMatchObject({ key: "local:r2", section: "needs-you" });
    expect(after[1]).toMatchObject({ key: "local:r1", section: "running" });
  });

  it("removes an agent immediately when archived or removed from rows", () => {
    const a = makeRow({ id: "a", bucket: "running", turn: openTurn(2_000) });
    const b = makeRow({ id: "b", bucket: "ready", sortTime: 100 });
    const c = makeRow({ id: "c", bucket: "running", turn: openTurn(1_000) });
    const snapshotKeys = ["local:a", "local:b", "local:c"];

    const initial = buildAgentGridItems([a, b, c], undefined, snapshotKeys);
    expect(keysOf(initial)).toEqual(["local:a", "local:b", "local:c"]);

    // a is archived, c is removed from rows entirely
    const aArchived = makeRow({
      id: "a",
      bucket: "running",
      turn: openTurn(2_000),
      archivedAt: new Date("2026-09-22T10:00:00.000Z"),
    });
    const updated = buildAgentGridItems([aArchived, b], initial, snapshotKeys);

    expect(keysOf(updated)).toEqual(["local:b"]);
    expect(updated[0]).toBe(initial[1]);
  });
  it("pins draft-created agent at draft slot (index 0) across running-ready-done lifecycle", () => {
    const a = makeRow({ id: "a", bucket: "running", turn: openTurn(1_000) });
    const b = makeRow({ id: "b", bucket: "ready", sortTime: 100 });
    const existingSnapshotKeys = ["local:a", "local:b"];

    // 1. Draft creates new agent, pinning key at slot 0 as snapshot member
    const pinnedSnapshotKeys = insertSnapshotKey(existingSnapshotKeys, "local:new", 0);
    expect(pinnedSnapshotKeys).toEqual(["local:new", "local:a", "local:b"]);

    // 2. Newly created agent is running -> rendered at slot 0, NOT appended at end
    const newRunning = makeRow({ id: "new", bucket: "running", turn: openTurn(500) });
    const initial = buildAgentGridItems([a, b, newRunning], undefined, pinnedSnapshotKeys);
    expect(keysOf(initial)).toEqual(["local:new", "local:a", "local:b"]);
    expect(initial[0]).toMatchObject({ key: "local:new", section: "running" });

    // 3. Agent transitions to ready -> stays at slot 0
    const newReady = makeRow({ id: "new", bucket: "ready", sortTime: 300 });
    const readyState = buildAgentGridItems([a, b, newReady], initial, pinnedSnapshotKeys);
    expect(keysOf(readyState)).toEqual(["local:new", "local:a", "local:b"]);
    expect(readyState[0]).toMatchObject({ key: "local:new", section: "ready" });

    // 4. Agent transitions to done -> stays at slot 0 (done-stays rule)
    const newDone = makeRow({ id: "new", bucket: "done" });
    const doneState = buildAgentGridItems([a, b, newDone], readyState, pinnedSnapshotKeys);
    expect(keysOf(doneState)).toEqual(["local:new", "local:a", "local:b"]);
    expect(doneState[0]).toMatchObject({ key: "local:new", section: "done" });

    // 5. Agent is archived -> removed from snapshot grid
    const newArchived = makeRow({ id: "new", bucket: "done", archivedAt: new Date() });
    const archivedState = buildAgentGridItems([a, b, newArchived], doneState, pinnedSnapshotKeys);
    expect(keysOf(archivedState)).toEqual(["local:a", "local:b"]);
  });

  it("pins spin-in-workspace draft-created agent in source neighborhood across lifecycle", () => {
    const a = makeRow({ id: "a", bucket: "running", turn: openTurn(2_000) });
    const b = makeRow({ id: "b", bucket: "ready", sortTime: 100 });
    const c = makeRow({ id: "c", bucket: "running", turn: openTurn(1_000) });
    const existingSnapshotKeys = ["local:a", "local:b", "local:c"];

    // Spin in workspace from agent b (slot 1) -> pin slot is 2 (source neighborhood)
    const pinnedSnapshotKeys = insertSnapshotKey(existingSnapshotKeys, "local:spun", 2);
    expect(pinnedSnapshotKeys).toEqual(["local:a", "local:b", "local:spun", "local:c"]);

    // Spun agent starts running -> pinned at slot 2, NOT appended after c
    const spunRunning = makeRow({ id: "spun", bucket: "running", turn: openTurn(3_000) });
    const initial = buildAgentGridItems([a, b, c, spunRunning], undefined, pinnedSnapshotKeys);
    expect(keysOf(initial)).toEqual(["local:a", "local:b", "local:spun", "local:c"]);
    expect(initial[2]).toMatchObject({ key: "local:spun", section: "running" });

    // Transitions to ready -> stays at slot 2
    const spunReady = makeRow({ id: "spun", bucket: "ready", sortTime: 500 });
    const readyState = buildAgentGridItems([a, b, c, spunReady], initial, pinnedSnapshotKeys);
    expect(keysOf(readyState)).toEqual(["local:a", "local:b", "local:spun", "local:c"]);
    expect(readyState[2]).toMatchObject({ key: "local:spun", section: "ready" });

    // Transitions to done -> stays at slot 2
    const spunDone = makeRow({ id: "spun", bucket: "done" });
    const doneState = buildAgentGridItems([a, b, c, spunDone], readyState, pinnedSnapshotKeys);
    expect(keysOf(doneState)).toEqual(["local:a", "local:b", "local:spun", "local:c"]);
    expect(doneState[2]).toMatchObject({ key: "local:spun", section: "done" });
  });
});

describe("insertSnapshotKey", () => {
  it("inserts a key at index 0 by default", () => {
    const keys = ["local:a", "local:b"];
    expect(insertSnapshotKey(keys, "local:new")).toEqual(["local:new", "local:a", "local:b"]);
  });

  it("inserts a key at the specified target slot index", () => {
    const keys = ["local:a", "local:b", "local:c"];
    expect(insertSnapshotKey(keys, "local:new", 2)).toEqual([
      "local:a",
      "local:b",
      "local:new",
      "local:c",
    ]);
  });

  it("clamps out-of-bounds target index", () => {
    const keys = ["local:a", "local:b"];
    expect(insertSnapshotKey(keys, "local:new", 99)).toEqual(["local:a", "local:b", "local:new"]);
    expect(insertSnapshotKey(keys, "local:new", -5)).toEqual(["local:new", "local:a", "local:b"]);
  });

  it("initializes a new array when snapshotKeys is null or empty", () => {
    expect(insertSnapshotKey(null, "local:new")).toEqual(["local:new"]);
    expect(insertSnapshotKey([], "local:new")).toEqual(["local:new"]);
  });

  it("returns the existing array when the key is already present", () => {
    const keys = ["local:a", "local:b"];
    expect(insertSnapshotKey(keys, "local:a")).toBe(keys);
  });
});
