import { z } from "zod";

/**
 * Agent reminders ("Remind me about this"): at remindAt the daemon that hosts
 * the agent POSTs paseo.agent.reminder to a named notify target
 * (daemon.mcp.notifyTargets). An agent has at most one pending reminder;
 * setting another replaces it.
 */

export const AgentReminderSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** ISO instant the reminder fires at. */
  remindAt: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  /** Who set it: "app", or the MCP client / agent that called fleet_remind_agent. */
  createdBy: z.string(),
  /** The daemon.mcp.notifyTargets name it POSTs to. */
  notifyTarget: z.string(),
});
export type AgentReminder = z.infer<typeof AgentReminderSchema>;

export const AGENT_REMINDER_NOTE_MAX_LENGTH = 2000;

export const AgentReminderSetRequestSchema = z.object({
  type: z.literal("agent.reminder.set.request"),
  requestId: z.string(),
  agentId: z.string(),
  remindAt: z.string(),
  note: z.string().nullable().optional(),
});
export type AgentReminderSetRequest = z.infer<typeof AgentReminderSetRequestSchema>;

export const AgentReminderSetResponseSchema = z.object({
  type: z.literal("agent.reminder.set.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    reminder: AgentReminderSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export type AgentReminderSetResponse = z.infer<typeof AgentReminderSetResponseSchema>;

export const AgentReminderCancelRequestSchema = z.object({
  type: z.literal("agent.reminder.cancel.request"),
  requestId: z.string(),
  agentId: z.string(),
});
export type AgentReminderCancelRequest = z.infer<typeof AgentReminderCancelRequestSchema>;

export const AgentReminderCancelResponseSchema = z.object({
  type: z.literal("agent.reminder.cancel.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    /** False when the agent had no pending reminder. */
    cancelled: z.boolean(),
    error: z.string().nullable(),
  }),
});
export type AgentReminderCancelResponse = z.infer<typeof AgentReminderCancelResponseSchema>;

// ---------------------------------------------------------------------------
// Presets. Shared by the app menu and fleet_remind_agent so "Tomorrow 9:00 AM"
// means the same instant in both. Wall-clock presets resolve in an explicit
// IANA time zone, never the daemon's.
// ---------------------------------------------------------------------------

export const AGENT_REMINDER_PRESETS = [
  "in_20m",
  "in_1h",
  "in_3h",
  "tomorrow_9am",
  "next_monday_9am",
] as const;
export type AgentReminderPreset = (typeof AGENT_REMINDER_PRESETS)[number];

export interface ZonedDateTime {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The wall-clock date and time `instant` shows in `timeZone`, plus its weekday (0 = Sunday). */
export function getZonedDateTime(
  instant: Date,
  timeZone: string,
): ZonedDateTime & { weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.find((part) => part.type === "weekday")?.value ?? "",
  );
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    weekday,
  };
}

/**
 * The instant a wall-clock time in `timeZone` names. Out-of-range fields roll
 * over (day 32 → next month). In a DST gap the time shifts forward; in an
 * overlap the earlier instant wins.
 */
export function zonedDateTimeToInstant(local: ZonedDateTime, timeZone: string): Date {
  const wallAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsetAt = (instant: number) => {
    const shown = getZonedDateTime(new Date(instant), timeZone);
    return (
      Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) -
      Math.floor(instant / 60_000) * 60_000
    );
  };
  // Two passes settle the offset on either side of a DST change.
  let instant = wallAsUtc - offsetAt(wallAsUtc);
  instant = wallAsUtc - offsetAt(instant);
  return new Date(instant);
}

export function resolveAgentReminderPreset(
  preset: AgentReminderPreset,
  now: Date,
  timeZone: string,
): Date {
  switch (preset) {
    case "in_20m":
      return new Date(now.getTime() + 20 * 60_000);
    case "in_1h":
      return new Date(now.getTime() + 60 * 60_000);
    case "in_3h":
      return new Date(now.getTime() + 3 * 60 * 60_000);
    case "tomorrow_9am": {
      const today = getZonedDateTime(now, timeZone);
      return zonedDateTimeToInstant({ ...today, day: today.day + 1, hour: 9, minute: 0 }, timeZone);
    }
    case "next_monday_9am": {
      const today = getZonedDateTime(now, timeZone);
      // The coming Monday; a week out when today is Monday.
      const days = (8 - today.weekday) % 7 || 7;
      return zonedDateTimeToInstant(
        { ...today, day: today.day + days, hour: 9, minute: 0 },
        timeZone,
      );
    }
  }
}
