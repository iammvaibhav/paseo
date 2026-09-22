import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { LifecycleBucket, LifecycleRow } from "@/mission-control/lifecycle";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import { agentGridRunStartMs, buildAgentGridItems, resolveAgentGridSection } from "./items";

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

  it("shows a needs_you row paused mid-run in the running section", () => {
    const row = makeRow({ id: "a", bucket: "needs_you", status: "running" });
    expect(resolveAgentGridSection(row)).toBe("running");
  });

  it("hides a needs_you row whose agent is not actually running", () => {
    const row = makeRow({ id: "a", bucket: "needs_you", status: "idle" });
    expect(resolveAgentGridSection(row)).toBeNull();
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

  it("counts a needs_you row whose agent is running as a running row", () => {
    const pausedOnPermission = makeRow({
      id: "p",
      bucket: "needs_you",
      status: "running",
      turn: openTurn(2_000),
    });
    const items = buildAgentGridItems([pausedOnPermission]);
    expect(items).toEqual([{ key: "local:p", section: "running", row: pausedOnPermission }]);
  });

  it("orders ready rows by sortTime descending", () => {
    const older = makeRow({ id: "a", bucket: "ready", sortTime: 100 });
    const newer = makeRow({ id: "b", bucket: "ready", sortTime: 200 });
    const items = buildAgentGridItems([older, newer]);
    expect(keysOf(items)).toEqual(["local:b", "local:a"]);
  });

  it("excludes done, dormant, and non-running needs_you rows", () => {
    const done = makeRow({ id: "d", bucket: "done" });
    const dormant = makeRow({ id: "m", bucket: "dormant" });
    const idleNeedsYou = makeRow({
      id: "n",
      bucket: "needs_you",
      status: "idle",
    });
    const items = buildAgentGridItems([done, dormant, idleNeedsYou]);
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

  it("appends newcomers after snapshot items, sorted running then ready", () => {
    const snap1 = makeRow({ id: "s1", bucket: "running", turn: openTurn(1_000) });
    const snap2 = makeRow({ id: "s2", bucket: "ready", sortTime: 100 });
    const snapshotKeys = ["local:s1", "local:s2"];

    // Newcomers: two running with different start times, one ready
    const newRunOld = makeRow({ id: "nro", bucket: "running", turn: openTurn(2_000) });
    const newRunNew = makeRow({ id: "nrn", bucket: "running", turn: openTurn(5_000) });
    const newReady = makeRow({ id: "nready", bucket: "ready", sortTime: 300 });

    const items = buildAgentGridItems(
      [snap1, snap2, newRunOld, newRunNew, newReady],
      undefined,
      snapshotKeys,
    );

    expect(keysOf(items)).toEqual([
      "local:s1",
      "local:s2",
      "local:nrn",
      "local:nro",
      "local:nready",
    ]);
    expect(items.map((item) => item.section)).toEqual([
      "running",
      "ready",
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
});
