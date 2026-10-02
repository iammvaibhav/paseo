import type { Initiative } from "@getpaseo/protocol/tickets/types";

// Initiative start and target dates are calendar days ("2026-10-03"). The
// arithmetic runs on day numbers, so a time zone or a DST change can never
// move a date by one day.

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a "YYYY-MM-DD" string. Null when it names no real day. */
export function parseCalendarDay(value: string): number | null {
  const match = CALENDAR_DATE.exec(value.slice(0, 10));
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  // Date.UTC rolls 2026-02-30 over to March; a rolled date is not the day typed.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return time / DAY_MS;
}

/** The local calendar day of an instant, as a day number. */
export function localCalendarDay(instant: Date): number {
  return Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()) / DAY_MS;
}

export type CalendarDateInput =
  | { status: "empty" }
  | { status: "valid"; value: string; day: number }
  | { status: "invalid" };

/** Reads what the user typed into a date field. Only the full "YYYY-MM-DD" form is valid. */
export function readCalendarDateInput(text: string): CalendarDateInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { status: "empty" };
  }
  if (trimmed.length !== 10) {
    return { status: "invalid" };
  }
  const day = parseCalendarDay(trimmed);
  return day === null ? { status: "invalid" } : { status: "valid", value: trimmed, day };
}

/** "Oct 3", or "Oct 3, 2027" outside the current year. Null for a value that names no day. */
export function formatCalendarDate(value: string, now: Date): string | null {
  const day = parseCalendarDay(value);
  if (day === null) {
    return null;
  }
  const date = new Date(day * DAY_MS);
  const sameYear = date.getUTCFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}

export interface InitiativeSchedule {
  /** Whole days until the target date. Negative when overdue. Null without a target. */
  daysLeft: number | null;
  /** Fraction 0..1 of the start-to-target span that has passed. Null without a target. */
  elapsed: number | null;
  /** Fraction 0..1 of the linked tickets that are done. */
  workDone: number;
}

function clampFraction(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Compares time elapsed with work done. Without a start date the span starts
 * on the day the initiative was created.
 */
export function deriveSchedule(
  initiative: Pick<
    Initiative,
    "startDate" | "targetDate" | "createdAt" | "ticketCount" | "doneTicketCount"
  >,
  now: Date,
): InitiativeSchedule {
  const workDone = initiativeProgress(initiative);
  const target = initiative.targetDate ? parseCalendarDay(initiative.targetDate) : null;
  if (target === null) {
    return { daysLeft: null, elapsed: null, workDone };
  }
  const today = localCalendarDay(now);
  const explicitStart = initiative.startDate ? parseCalendarDay(initiative.startDate) : null;
  const start = explicitStart ?? localCalendarDay(new Date(initiative.createdAt));
  const span = target - start;
  const elapsed = span <= 0 ? 1 : clampFraction((today - start) / span);
  return { daysLeft: target - today, elapsed, workDone };
}

/** Fraction 0..1 of an initiative's tickets that are done. */
export function initiativeProgress(
  initiative: Pick<Initiative, "ticketCount" | "doneTicketCount">,
): number {
  if (initiative.ticketCount === 0) {
    return 0;
  }
  return clampFraction(initiative.doneTicketCount / initiative.ticketCount);
}
