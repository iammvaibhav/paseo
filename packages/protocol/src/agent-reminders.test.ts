import { describe, expect, it } from "vitest";
import { resolveAgentReminderPreset, zonedDateTimeToInstant } from "./agent-reminders.js";

const iso = (date: Date) => date.toISOString();

describe("resolveAgentReminderPreset", () => {
  // Tuesday 2026-10-20, 01:30 in Kolkata: still Monday evening in UTC.
  const tuesdayEarlyIst = new Date("2026-10-19T20:00:00Z");

  it("adds relative presets to now", () => {
    expect(iso(resolveAgentReminderPreset("in_20m", tuesdayEarlyIst, "Asia/Calcutta"))).toBe(
      "2026-10-19T20:20:00.000Z",
    );
    expect(iso(resolveAgentReminderPreset("in_3h", tuesdayEarlyIst, "Asia/Calcutta"))).toBe(
      "2026-10-19T23:00:00.000Z",
    );
  });

  it("reads tomorrow from the reminder's time zone, not UTC", () => {
    // Local date is the 20th, so tomorrow is the 21st at 09:00 IST.
    expect(iso(resolveAgentReminderPreset("tomorrow_9am", tuesdayEarlyIst, "Asia/Calcutta"))).toBe(
      "2026-10-21T03:30:00.000Z",
    );
  });

  it("picks the coming Monday, a week out on a Monday", () => {
    const monday = new Date("2026-10-19T05:00:00Z");
    const sunday = new Date("2026-10-25T05:00:00Z");
    for (const now of [tuesdayEarlyIst, monday, sunday]) {
      expect(iso(resolveAgentReminderPreset("next_monday_9am", now, "Asia/Calcutta"))).toBe(
        "2026-10-26T03:30:00.000Z",
      );
    }
  });

  it("lands on 9:00 local across daylight-saving changes", () => {
    const beforeSpringForward = new Date("2026-03-07T15:00:00Z");
    expect(
      iso(resolveAgentReminderPreset("tomorrow_9am", beforeSpringForward, "America/New_York")),
    ).toBe("2026-03-08T13:00:00.000Z");
    const beforeFallBack = new Date("2026-10-31T16:00:00Z");
    expect(
      iso(resolveAgentReminderPreset("tomorrow_9am", beforeFallBack, "America/New_York")),
    ).toBe("2026-11-01T14:00:00.000Z");
  });
});

describe("zonedDateTimeToInstant", () => {
  it("rolls an out-of-range day into the next month", () => {
    expect(
      iso(
        zonedDateTimeToInstant(
          { year: 2026, month: 10, day: 32, hour: 9, minute: 0 },
          "Asia/Calcutta",
        ),
      ),
    ).toBe("2026-11-01T03:30:00.000Z");
  });
});
