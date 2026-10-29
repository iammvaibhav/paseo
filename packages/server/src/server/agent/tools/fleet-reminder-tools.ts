import { z } from "zod";
import {
  AGENT_REMINDER_NOTE_MAX_LENGTH,
  AGENT_REMINDER_PRESETS,
  AgentReminderSchema,
  resolveAgentReminderPreset,
  zonedDateTimeToInstant,
  type AgentReminder,
  type AgentReminderPreset,
} from "@getpaseo/protocol/agent-reminders";
import { ensureValidJson } from "../../json-utils.js";
import type { AgentReminderService } from "../../reminders/agent-reminder-service.js";
import {
  resolvePeerDaemonClient,
  resolveTargetHost,
  type RegisterFleetControlToolsOptions,
} from "./fleet-control-tools.js";
import { executeFleetToolOnPeer } from "./fleet-wait.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

/** Wall-clock presets and naive remindAt values resolve here unless the caller names a zone. */
export const DEFAULT_REMINDER_TIME_ZONE = "Asia/Calcutta";

export interface RegisterFleetReminderToolsOptions extends RegisterFleetControlToolsOptions {
  /** Absent → this host refuses reminders for its own agents; peer agents still route. */
  agentReminders?: AgentReminderService | null;
  /** Peer hosts that are online now, for fleet-wide listing. */
  listOnlinePeerHosts: () => string[];
  callerAgentId?: string;
}

const AGENT_ID_SCHEMA = z
  .string()
  .min(1)
  .describe("Agent UUID from fleet_list_agents data — fleet-wide, no host needed.");

const HOST_HINT_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Optional host hint: a peer name from the daemon peers config, or 'local' for this daemon. " +
      "Omitted → resolved via the fleet index.",
  );

const NAIVE_LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?$/;
const EXPLICIT_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

const REMIND_INPUT_SCHEMA = {
  agentId: AGENT_ID_SCHEMA,
  host: HOST_HINT_SCHEMA,
  preset: z
    .enum(AGENT_REMINDER_PRESETS)
    .optional()
    .describe(
      "Slack-style preset: in_20m, in_1h, in_3h, tomorrow_9am, next_monday_9am (wall-clock " +
        "presets use timeZone). Give exactly one of preset, inMinutes, remindAt.",
    ),
  inMinutes: z
    .number()
    .int()
    .min(1)
    .max(366 * 24 * 60)
    .optional()
    .describe("Fire this many minutes from now."),
  remindAt: z
    .string()
    .min(1)
    .optional()
    .describe(
      "When to fire: an ISO 8601 instant with offset (2026-10-20T09:00:00+05:30) or a local " +
        "wall time without one (2026-10-20T09:00), read in timeZone.",
    ),
  timeZone: z
    .string()
    .min(1)
    .optional()
    .describe(
      `IANA time zone for presets and naive remindAt. Default ${DEFAULT_REMINDER_TIME_ZONE}.`,
    ),
  note: z
    .string()
    .max(AGENT_REMINDER_NOTE_MAX_LENGTH)
    .optional()
    .describe("Optional note carried in the reminder event."),
  notifyTarget: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of a configured notify target (daemon.mcp.notifyTargets) on the agent's host. " +
        "Default grok-bot. URLs are not accepted.",
    ),
  createdBy: z
    .string()
    .min(1)
    .optional()
    .describe("Recorded as who set the reminder. Defaults to the caller."),
};

const REMINDER_OUTPUT_SCHEMA = AgentReminderSchema.extend({ host: z.string() });

const CONTROL_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  host: z.string(),
  agentId: z.string(),
  error: z.string().optional(),
  guidance: z.string().optional(),
};

const PEER_REMIND_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  reminder: AgentReminderSchema.optional(),
  replaced: z.boolean().optional(),
  error: z.string().optional(),
});

const PEER_CANCEL_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  cancelled: z.boolean().optional(),
  reminder: AgentReminderSchema.optional(),
  error: z.string().optional(),
});

const PEER_LIST_RESULT_SCHEMA = z.object({
  reminders: z.array(z.record(z.string(), z.unknown())),
  recent: z.array(z.record(z.string(), z.unknown())).optional(),
});

function result(structuredContent: Record<string, unknown>): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(structuredContent) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The instant a fleet_remind_agent call names; throws a caller-facing message. */
export function resolveRemindAt(
  input: { preset?: AgentReminderPreset; inMinutes?: number; remindAt?: string; timeZone?: string },
  now: Date,
): Date {
  const given = [input.preset, input.inMinutes, input.remindAt].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new Error("Give exactly one of preset, inMinutes, remindAt");
  }
  const timeZone = input.timeZone ?? DEFAULT_REMINDER_TIME_ZONE;
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Unknown time zone "${timeZone}"`);
  }
  if (input.preset) return resolveAgentReminderPreset(input.preset, now, timeZone);
  if (input.inMinutes !== undefined) return new Date(now.getTime() + input.inMinutes * 60_000);
  const text = input.remindAt!.trim();
  const naive = NAIVE_LOCAL_TIME.exec(text);
  if (naive) {
    const [year, month, day, hour, minute] = naive.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    return zonedDateTimeToInstant({ year, month, day, hour, minute }, timeZone);
  }
  const instant = Date.parse(text);
  if (!EXPLICIT_ZONE.test(text) || Number.isNaN(instant)) {
    throw new Error(
      `remindAt "${text}" is neither an ISO instant with offset nor a local time like 2026-10-20T09:00`,
    );
  }
  return new Date(instant);
}

function defaultCreatedBy(
  options: RegisterFleetReminderToolsOptions,
  context: PaseoToolExecutionContext | undefined,
): string {
  if (context?.callerClient) return context.callerClient;
  return options.callerAgentId ? `agent:${options.callerAgentId}` : "mcp";
}

const NOT_AVAILABLE = "Reminders are not available on this host";

export function registerFleetReminderTools(options: RegisterFleetReminderToolsOptions): void {
  const { registerTool } = options;

  registerTool(
    "fleet_remind_agent",
    {
      title: "Remind me about an agent",
      description:
        "Slack-style 'Remind me about this' for an agent: at the chosen time the agent's host POSTs " +
        "paseo.agent.reminder (agent title, status, last message, deep link, your note) to a notify " +
        "target, grok-bot by default. One pending reminder per agent; setting another replaces it. " +
        "Survives daemon restarts; a reminder missed while the host was down fires on startup with " +
        "late: true. agentId is fleet-wide; host is optional.",
      inputSchema: REMIND_INPUT_SCHEMA,
      outputSchema: {
        ...CONTROL_OUTPUT_SCHEMA,
        reminder: AgentReminderSchema.optional(),
        replaced: z.boolean().optional(),
      },
    },
    async (
      input: {
        agentId: string;
        host?: string;
        preset?: AgentReminderPreset;
        inMinutes?: number;
        remindAt?: string;
        timeZone?: string;
        note?: string;
        notifyTarget?: string;
        createdBy?: string;
      },
      context,
    ) => {
      const resolved = await resolveTargetHost(input.agentId, input.host, options);
      const base = { host: resolved.targetHostDisplay, agentId: resolved.agentId };
      if (resolved.error) {
        return result({ ok: false, ...base, error: resolved.error, guidance: resolved.guidance });
      }
      let remindAt: Date;
      try {
        remindAt = resolveRemindAt(input, new Date());
      } catch (error) {
        return result({ ok: false, ...base, error: errorMessage(error) });
      }
      const createdBy = input.createdBy ?? defaultCreatedBy(options, context);
      if (resolved.isLocal) {
        if (!options.agentReminders) return result({ ok: false, ...base, error: NOT_AVAILABLE });
        try {
          const { reminder, replaced } = await options.agentReminders.set({
            agentId: resolved.agentId,
            remindAt,
            note: input.note ?? null,
            createdBy,
            notifyTarget: input.notifyTarget ?? null,
          });
          return result({ ok: true, ...base, reminder, replaced });
        } catch (error) {
          return result({ ok: false, ...base, error: errorMessage(error) });
        }
      }
      const peer = resolvePeerDaemonClient(resolved.host, options);
      if (!peer.client) {
        return result({ ok: false, ...base, error: peer.error, guidance: peer.guidance });
      }
      try {
        const outcome = await executeFleetToolOnPeer(peer.client, "fleet_remind_agent", {
          agentId: resolved.agentId,
          remindAt: remindAt.toISOString(),
          createdBy,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.notifyTarget ? { notifyTarget: input.notifyTarget } : {}),
        });
        if (!outcome.ok) return result({ ok: false, ...base, error: outcome.error });
        const parsed = PEER_REMIND_RESULT_SCHEMA.parse(outcome.structuredContent);
        return result({ ...parsed, ...base });
      } catch (error) {
        return result({ ok: false, ...base, error: errorMessage(error) });
      }
    },
  );

  registerTool(
    "fleet_cancel_reminder",
    {
      title: "Cancel an agent reminder",
      description:
        "Cancel the pending fleet_remind_agent reminder on an agent. cancelled is false when the " +
        "agent had none. agentId is fleet-wide; host is optional.",
      inputSchema: { agentId: AGENT_ID_SCHEMA, host: HOST_HINT_SCHEMA },
      outputSchema: {
        ...CONTROL_OUTPUT_SCHEMA,
        cancelled: z.boolean().optional(),
        reminder: AgentReminderSchema.optional(),
      },
    },
    async (input: { agentId: string; host?: string }) => {
      const resolved = await resolveTargetHost(input.agentId, input.host, options);
      const base = { host: resolved.targetHostDisplay, agentId: resolved.agentId };
      if (resolved.error) {
        return result({ ok: false, ...base, error: resolved.error, guidance: resolved.guidance });
      }
      if (resolved.isLocal) {
        if (!options.agentReminders) return result({ ok: false, ...base, error: NOT_AVAILABLE });
        const cancelled = await options.agentReminders.cancel(resolved.agentId);
        return result({
          ok: true,
          ...base,
          cancelled: cancelled !== null,
          ...(cancelled ? { reminder: cancelled } : {}),
        });
      }
      const peer = resolvePeerDaemonClient(resolved.host, options);
      if (!peer.client) {
        return result({ ok: false, ...base, error: peer.error, guidance: peer.guidance });
      }
      try {
        const outcome = await executeFleetToolOnPeer(peer.client, "fleet_cancel_reminder", {
          agentId: resolved.agentId,
        });
        if (!outcome.ok) return result({ ok: false, ...base, error: outcome.error });
        return result({ ...PEER_CANCEL_RESULT_SCHEMA.parse(outcome.structuredContent), ...base });
      } catch (error) {
        return result({ ok: false, ...base, error: errorMessage(error) });
      }
    },
  );

  const listLocal = async (includeRecent: boolean) => {
    const host = options.hostLabel;
    if (!options.agentReminders) return { host, reminders: [], recent: [] };
    const { pending, recent } = options.agentReminders.list();
    const withTitle = async (reminder: AgentReminder) => ({
      ...reminder,
      host: options.hostLabel,
      title: (await options.agentStorage.get(reminder.agentId).catch(() => null))?.title ?? null,
    });
    return {
      host,
      reminders: await Promise.all(pending.map(withTitle)),
      recent: includeRecent ? await Promise.all(recent.map(withTitle)) : [],
    };
  };

  registerTool(
    "fleet_list_reminders",
    {
      title: "List agent reminders",
      description:
        "Pending fleet_remind_agent reminders, soonest first, across this host and every online " +
        "peer (or one host). includeRecent adds the last fired reminders with their delivery " +
        "outcome (delivered, HTTP status, late).",
      inputSchema: {
        host: z
          .string()
          .min(1)
          .optional()
          .describe("Only this host: a peer name, or 'local'. Omitted → every reachable host."),
        includeRecent: z
          .boolean()
          .optional()
          .describe("Also list recently fired reminders and how their delivery went."),
      },
      outputSchema: {
        reminders: z.array(REMINDER_OUTPUT_SCHEMA.extend({ title: z.string().nullable() })),
        recent: z.array(z.record(z.string(), z.unknown())).optional(),
        errors: z.array(z.object({ host: z.string(), error: z.string() })).optional(),
      },
    },
    async (input: { host?: string; includeRecent?: boolean }) => {
      const includeRecent = input.includeRecent === true;
      const hosts =
        input.host === undefined
          ? ["local", ...options.listOnlinePeerHosts()]
          : [options.isFleetLocalTarget(input.host) ? "local" : input.host];
      const settled = await Promise.all(
        hosts.map(async (host) => {
          if (host === "local") return listLocal(includeRecent);
          const peer = resolvePeerDaemonClient(host, options);
          if (!peer.client) return { host, error: peer.error ?? `Host "${host}" is unreachable` };
          try {
            const outcome = await executeFleetToolOnPeer(peer.client, "fleet_list_reminders", {
              includeRecent,
            });
            if (!outcome.ok) return { host, error: outcome.error };
            const parsed = PEER_LIST_RESULT_SCHEMA.parse(outcome.structuredContent);
            return { host, reminders: parsed.reminders, recent: parsed.recent };
          } catch (error) {
            return { host, error: errorMessage(error) };
          }
        }),
      );
      const reminders = settled
        .flatMap(
          (entry): Array<Record<string, unknown>> =>
            "reminders" in entry ? (entry.reminders ?? []) : [],
        )
        .sort((a, b) => Date.parse(String(a.remindAt)) - Date.parse(String(b.remindAt)));
      const errors = settled.flatMap((entry) =>
        "error" in entry && entry.error ? [{ host: entry.host, error: entry.error }] : [],
      );
      return result({
        reminders,
        ...(includeRecent
          ? { recent: settled.flatMap((entry) => ("recent" in entry ? (entry.recent ?? []) : [])) }
          : {}),
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  );
}
