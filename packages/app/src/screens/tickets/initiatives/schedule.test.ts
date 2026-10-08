import { describe, expect, it } from "vitest";
import { deriveSchedule, parseCalendarDay, readCalendarDateInput } from "./schedule";

const DAY_MS = 86_400_000;

describe("calendar dates", () => {
  it("accepts real days and refuses days that roll over", () => {
    expect(parseCalendarDay("2028-02-29")).toBe(Date.UTC(2028, 1, 29) / DAY_MS);
    expect(parseCalendarDay("2026-02-29")).toBeNull();
    expect(parseCalendarDay("2026-13-01")).toBeNull();
  });

  it("reads only the date part of a full timestamp", () => {
    expect(parseCalendarDay("2026-10-03T00:00:00.000Z")).toBe(Date.UTC(2026, 9, 3) / DAY_MS);
  });

  it("treats a half-typed date as invalid and a blank field as empty", () => {
    expect(readCalendarDateInput("  ")).toEqual({ status: "empty" });
    expect(readCalendarDateInput("2026-10-3")).toEqual({ status: "invalid" });
    expect(readCalendarDateInput(" 2026-10-03 ")).toEqual({
      status: "valid",
      value: "2026-10-03",
      day: Date.UTC(2026, 9, 3) / DAY_MS,
    });
  });
});

describe("initiative schedule", () => {
  const base = {
    createdAt: "2026-09-01T10:00:00.000Z",
    ticketCount: 4,
    doneTicketCount: 1,
  };

  it("has no pace without a target date", () => {
    expect(
      deriveSchedule({ ...base, startDate: null, targetDate: null }, new Date(2026, 8, 15)),
    ).toEqual({ daysLeft: null, elapsed: null, workDone: 0.25 });
  });

  it("counts calendar days from today to the target", () => {
    const schedule = deriveSchedule(
      { ...base, startDate: "2026-09-10", targetDate: "2026-09-20" },
      new Date(2026, 8, 15, 23, 30),
    );
    expect(schedule).toEqual({ daysLeft: 5, elapsed: 0.5, workDone: 0.25 });
  });

  it("reports an overdue target as negative days and full elapsed time", () => {
    const schedule = deriveSchedule(
      { ...base, startDate: "2026-09-10", targetDate: "2026-09-20" },
      new Date(2026, 8, 23),
    );
    expect(schedule.daysLeft).toBe(-3);
    expect(schedule.elapsed).toBe(1);
  });

  it("starts the span on the creation day when no start date is set", () => {
    const schedule = deriveSchedule(
      {
        ...base,
        createdAt: new Date(2026, 8, 1, 12).toISOString(),
        startDate: null,
        targetDate: "2026-09-11",
      },
      new Date(2026, 8, 6),
    );
    expect(schedule.elapsed).toBe(0.5);
  });

  it("treats a target on or before the start as fully elapsed", () => {
    const schedule = deriveSchedule(
      { ...base, startDate: "2026-09-20", targetDate: "2026-09-20" },
      new Date(2026, 8, 1),
    );
    expect(schedule.elapsed).toBe(1);
    expect(schedule.daysLeft).toBe(19);
  });
});
