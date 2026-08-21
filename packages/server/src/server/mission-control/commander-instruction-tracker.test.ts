import { describe, expect, test } from "vitest";
import { CommanderInstructionTracker } from "./commander-instruction-tracker.js";

describe("CommanderInstructionTracker", () => {
  test("stages ids before dispatch and the rollback forgets them (delivery failure)", () => {
    const tracker = new CommanderInstructionTracker();
    const rollback = tracker.stage(["#1", "#2"]);
    expect(tracker.hasTrackedIds).toBe(true);
    rollback();
    expect(tracker.hasTrackedIds).toBe(false);
    expect(tracker.complete()).toBeNull();
  });

  test("turn_started binds pending ids to the active turn and resets the row window", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.stage(["#1"]);
    tracker.assistantRow(1, "leftover prose from an earlier window");
    tracker.turnStarted();
    // The pre-window rows are dropped: the window starts clean, and the
    // staged id rides the new window.
    tracker.assistantRow(2, "fresh answer");
    const answered = tracker.complete();
    expect(answered?.ids).toEqual(["#1"]);
    expect(answered?.text).toBe("fresh answer");
  });

  test("accumulates assistant rows in seq order and completes with active plus pending", () => {
    const tracker = new CommanderInstructionTracker();
    // Mid-turn attach: rows arrive before any turn_started, ids stay pending.
    tracker.assistantRow(2, "world");
    tracker.stage(["#1", "#2"]);
    tracker.assistantRow(1, "hello ");
    const snapshot = tracker.complete();
    expect(snapshot?.ids).toEqual(["#1", "#2"]);
    // Ordered join, no separators (the ack-drop convention).
    expect(snapshot?.text).toBe("hello world");
    expect(tracker.hasTrackedIds).toBe(false);
  });

  test("a busy steer into an active turn lands in active and the completion covers it", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.turnStarted();
    tracker.stage(["#1"], { intoActiveTurn: true });
    tracker.assistantRow(1, "on it");
    const snapshot = tracker.complete();
    expect(snapshot?.ids).toEqual(["#1"]);
    expect(snapshot?.text).toBe("on it");
  });

  test("a busy steer with no active turn stays pending and the completion still covers it", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.stage(["#1"], { intoActiveTurn: true });
    tracker.assistantRow(1, "answered anyway");
    const snapshot = tracker.complete();
    expect(snapshot?.ids).toEqual(["#1"]);
    expect(snapshot?.text).toBe("answered anyway");
  });

  test("a completed turn with only a pure-ack reply synthesizes nothing and drops the id", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.stage(["#1"]);
    tracker.turnStarted();
    tracker.assistantRow(1, "ok");
    expect(tracker.complete()).toBeNull();
    expect(tracker.hasTrackedIds).toBe(false);
  });

  test("a completed turn with empty prose synthesizes nothing", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.stage(["#1"]);
    tracker.turnStarted();
    expect(tracker.complete()).toBeNull();
  });

  test("a failed turn keeps ids pending for the next window and drops its prose", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.stage(["#1"]);
    tracker.turnStarted();
    tracker.assistantRow(1, "partial answer that never completed");
    tracker.fail();
    // The failed turn's prose must not leak into the recovery window.
    tracker.turnStarted();
    tracker.assistantRow(2, "the real answer");
    const snapshot = tracker.complete();
    expect(snapshot?.ids).toEqual(["#1"]);
    expect(snapshot?.text).toBe("the real answer");
  });

  test("a failed turn never synthesizes even when prose exists", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.stage(["#1"]);
    tracker.turnStarted();
    tracker.assistantRow(1, "prose");
    tracker.fail();
    expect(tracker.hasTrackedIds).toBe(true); // id kept, pending for recovery
    expect(tracker.complete()).toBeNull(); // nothing to synthesize yet
  });

  test("machinery turns with no staged ids finalize to nothing", () => {
    const tracker = new CommanderInstructionTracker();
    tracker.turnStarted();
    tracker.assistantRow(1, "acknowledged, standing by");
    expect(tracker.complete()).toBeNull();
    expect(tracker.hasTrackedIds).toBe(false);
  });
});
