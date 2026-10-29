import { describe, expect, it } from "vitest";
import {
  buildReminderDayOptions,
  buildReminderTimeOptions,
  defaultCustomReminderStart,
  describeReminderTime,
} from "./reminder-time";

const IST = "Asia/Calcutta";

describe("reminder time helpers", () => {
  // 23:50 on Oct 31 in Kolkata.
  const lateOct31 = new Date("2026-10-31T18:20:00Z");

  it("lists days from the reminder zone's today, across a month boundary", () => {
    const days = buildReminderDayOptions(lateOct31, IST, 3);
    expect(days.map((day) => [day.key, day.offset])).toEqual([
      ["2026-10-31", 0],
      ["2026-11-01", 1],
      ["2026-11-02", 2],
    ]);
  });

  it("starts the custom picker on the quarter hour 30 minutes out, rolling past midnight", () => {
    // 23:50 + 30m = 00:20 tomorrow → 00:30.
    expect(defaultCustomReminderStart(lateOct31, IST)).toEqual({ dayOffset: 1, timeKey: "00:30" });
    // 10:00 + 30m = 10:30 exactly.
    expect(defaultCustomReminderStart(new Date("2026-10-31T04:30:00Z"), IST)).toEqual({
      dayOffset: 0,
      timeKey: "10:30",
    });
    // 23:40 + 30m = 00:10 → 00:15 tomorrow; 23:20 + 30m = 23:50 → 00:00 tomorrow.
    expect(defaultCustomReminderStart(new Date("2026-10-31T18:10:00Z"), IST)).toEqual({
      dayOffset: 1,
      timeKey: "00:15",
    });
    expect(defaultCustomReminderStart(new Date("2026-10-31T17:50:00Z"), IST)).toEqual({
      dayOffset: 1,
      timeKey: "00:00",
    });
  });

  it("offers every quarter hour", () => {
    const times = buildReminderTimeOptions();
    expect(times).toHaveLength(96);
    expect(times[36]).toMatchObject({ key: "09:00", hour: 9, minute: 0 });
  });

  it("names today and tomorrow by the reminder zone's calendar", () => {
    expect(describeReminderTime(new Date("2026-10-31T18:25:00Z"), lateOct31, IST).day).toBe(
      "today",
    );
    expect(describeReminderTime(new Date("2026-10-31T18:35:00Z"), lateOct31, IST).day).toBe(
      "tomorrow",
    );
    expect(describeReminderTime(new Date("2026-11-02T03:30:00Z"), lateOct31, IST).day).toBe(
      "other",
    );
  });
});
