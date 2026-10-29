import {
  getZonedDateTime,
  resolveAgentReminderPreset,
  type AgentReminderPreset,
} from "@getpaseo/protocol/agent-reminders";

/** The time zone the app shows and picks reminder times in: the device's own. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface ReminderWhen {
  day: "today" | "tomorrow" | "other";
  /** "Mon, Oct 26"; used when day is "other". */
  date: string;
  /** "9:00 AM". */
  time: string;
}

const dayKey = (parts: { year: number; month: number; day: number }) =>
  Date.UTC(parts.year, parts.month - 1, parts.day);

/** How a reminder time reads relative to now, in timeZone. */
export function describeReminderTime(at: Date, now: Date, timeZone: string): ReminderWhen {
  const days = Math.round(
    (dayKey(getZonedDateTime(at, timeZone)) - dayKey(getZonedDateTime(now, timeZone))) / 86_400_000,
  );
  const relativeDays: Record<number, ReminderWhen["day"]> = { 0: "today", 1: "tomorrow" };
  return {
    day: relativeDays[days] ?? "other",
    date: new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(at),
    time: new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(at),
  };
}

export interface ReminderPresetOption {
  preset: AgentReminderPreset;
  at: Date;
}

export const REMINDER_MENU_PRESETS: readonly AgentReminderPreset[] = [
  "in_20m",
  "in_1h",
  "in_3h",
  "tomorrow_9am",
  "next_monday_9am",
];

export function buildReminderPresetOptions(now: Date, timeZone: string): ReminderPresetOption[] {
  return REMINDER_MENU_PRESETS.map((preset) => ({
    preset,
    at: resolveAgentReminderPreset(preset, now, timeZone),
  }));
}

export interface ReminderDayOption {
  /** "2026-10-19". */
  key: string;
  year: number;
  month: number;
  day: number;
  /** Days from today: 0 is today. */
  offset: number;
  /** "Mon, Oct 19". */
  label: string;
}

/** Today and the following days, in timeZone. */
export function buildReminderDayOptions(
  now: Date,
  timeZone: string,
  count: number,
): ReminderDayOption[] {
  const today = getZonedDateTime(now, timeZone);
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return Array.from({ length: count }, (_, offset) => {
    // Calendar arithmetic on a UTC date is free of the zone's DST shifts.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return {
      key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      year,
      month,
      day,
      offset,
      label: formatter.format(date),
    };
  });
}

export interface ReminderTimeOption {
  /** "09:00". */
  key: string;
  hour: number;
  minute: number;
  /** "9:00 AM", in the device locale's clock. */
  label: string;
}

/** Every quarter hour of a day. */
export function buildReminderTimeOptions(): ReminderTimeOption[] {
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  });
  return Array.from({ length: 96 }, (_, index) => {
    const hour = Math.floor(index / 4);
    const minute = (index % 4) * 15;
    return {
      key: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      hour,
      minute,
      label: formatter.format(new Date(Date.UTC(2000, 0, 1, hour, minute))),
    };
  });
}

/** The quarter hour at or after `now` plus 30 minutes: the custom picker's starting time. */
export function defaultCustomReminderStart(
  now: Date,
  timeZone: string,
): { dayOffset: number; timeKey: string } {
  const local = getZonedDateTime(new Date(now.getTime() + 30 * 60_000), timeZone);
  const today = getZonedDateTime(now, timeZone);
  let minutes = Math.ceil((local.hour * 60 + local.minute) / 15) * 15;
  let dayOffset = Math.round((dayKey(local) - dayKey(today)) / 86_400_000);
  if (minutes >= 24 * 60) {
    minutes = 0;
    dayOffset += 1;
  }
  const hour = Math.floor(minutes / 60);
  return {
    dayOffset,
    timeKey: `${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
  };
}
