import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import {
  AGENT_REMINDER_NOTE_MAX_LENGTH,
  AgentReminderSchema,
  type AgentReminder,
} from "@getpaseo/protocol/agent-reminders";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { McpFinishNotifier, McpNotifyTarget } from "../mcp-fleet/finish-notifier.js";

/**
 * "Remind me" for agents. A reminder lives on the daemon that hosts its agent
 * and POSTs paseo.agent.reminder to a named notify target when due.
 *
 * Fire-once: a due reminder is persisted as firing (with its deliveryId)
 * before the POST, and removed once the POST settles. A restart in between
 * resends under the same deliveryId, so receivers dedupe on it. Reminders
 * that came due while the daemon was down fire at startup with late: true.
 */

export const AGENT_REMINDER_EVENT = "paseo.agent.reminder";
/** Where a reminder POSTs when the caller names no target. */
export const DEFAULT_REMINDER_NOTIFY_TARGET = "grok-bot";
/** Fired this long after remindAt (a daemon restart, a sleeping host) → late: true. */
export const REMINDER_LATE_AFTER_MS = 60_000;
const MAX_HORIZON_MS = 366 * 24 * 60 * 60_000;
const RECENT_LIMIT = 50;
/** setTimeout's ceiling; a later reminder re-arms when this fires. */
const MAX_TIMER_MS = 2_147_483_647;

const FiringSchema = z.object({
  deliveryId: z.string(),
  firedAt: z.string(),
  late: z.boolean(),
});

const StoredReminderSchema = AgentReminderSchema.extend({
  firing: FiringSchema.nullable(),
});
type StoredReminder = z.infer<typeof StoredReminderSchema>;
type FiringReminder = StoredReminder & { firing: z.infer<typeof FiringSchema> };

const FiredReminderSchema = AgentReminderSchema.extend({
  firedAt: z.string(),
  late: z.boolean(),
  deliveryId: z.string(),
  delivered: z.boolean(),
  status: z.number().nullable(),
  error: z.string().nullable(),
});
export type FiredAgentReminder = z.infer<typeof FiredReminderSchema>;

const StoreFileSchema = z.object({
  version: z.literal(1),
  reminders: z.array(StoredReminderSchema),
  recent: z.array(FiredReminderSchema),
});
type StoreFile = z.infer<typeof StoreFileSchema>;

/** What a reminder event says about its agent, read when it fires. */
export interface ReminderAgentInfo {
  title: string | null;
  host: string;
  workspaceId: string | null;
  cwd: string | null;
  status: string | null;
  bucket: string | null;
  lastMessage: string | null;
  deepLink: string;
  webUrl: string | null;
}

export interface AgentReminderServiceOptions {
  filePath: string;
  logger: Logger;
  /** Whether this daemon hosts the agent; reminders are only set where the agent lives. */
  hostsAgent: (agentId: string) => Promise<boolean>;
  resolveTarget: (name: string) => McpNotifyTarget | null;
  describeAgent: (agentId: string) => Promise<ReminderAgentInfo>;
  deliver: McpFinishNotifier["deliver"];
  /** The agent's pending reminder changed: push its snapshot to clients. */
  onChange: (agentId: string) => void;
  now?: () => Date;
}

export interface SetAgentReminderInput {
  agentId: string;
  remindAt: Date;
  note?: string | null;
  createdBy: string;
  notifyTarget?: string | null;
}

export interface AgentReminderService {
  /** Load the store, fire what came due while the daemon was down, arm the timer. */
  start(): Promise<void>;
  stop(): void;
  /** Set the agent's reminder, replacing a pending one. Throws on invalid input. */
  set(input: SetAgentReminderInput): Promise<{ reminder: AgentReminder; replaced: boolean }>;
  /** Cancel the agent's pending reminder; null when it had none. */
  cancel(agentId: string): Promise<AgentReminder | null>;
  /** The agent's reminder that has not fired yet. */
  getPending(agentId: string): AgentReminder | null;
  list(): { pending: AgentReminder[]; recent: FiredAgentReminder[] };
}

function toWire(reminder: StoredReminder): AgentReminder {
  const { firing: _firing, ...wire } = reminder;
  return wire;
}

export function createAgentReminderService(
  options: AgentReminderServiceOptions,
): AgentReminderService {
  const logger = options.logger.child({ module: "agent-reminders" });
  const now = options.now ?? (() => new Date());
  let reminders: StoredReminder[] = [];
  let recent: FiredAgentReminder[] = [];
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let writes: Promise<void> = Promise.resolve();
  /** Reminder ids with a POST in flight in this process. */
  const sending = new Set<string>();

  const persist = (): Promise<void> => {
    const snapshot: StoreFile = { version: 1, reminders, recent };
    writes = writes
      .catch(() => undefined)
      .then(() => writeJsonFileAtomic(options.filePath, snapshot));
    return writes;
  };

  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(options.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = StoreFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.error({ err: parsed.error }, "agent reminder store unreadable; starting empty");
      return;
    }
    reminders = parsed.data.reminders;
    recent = parsed.data.recent;
  };

  const send = async (reminder: FiringReminder) => {
    if (sending.has(reminder.id)) return;
    sending.add(reminder.id);
    try {
      const target = options.resolveTarget(reminder.notifyTarget);
      let outcome: { delivered: boolean; status: number | null; error: string | null };
      if (!target) {
        const error = `notify target "${reminder.notifyTarget}" is not configured`;
        outcome = { delivered: false, status: null, error };
        logger.error({ reminderId: reminder.id, agentId: reminder.agentId }, error);
      } else {
        const agent = await options.describeAgent(reminder.agentId);
        const body = JSON.stringify({
          type: AGENT_REMINDER_EVENT,
          deliveryId: reminder.firing.deliveryId,
          reminderId: reminder.id,
          late: reminder.firing.late,
          agentId: reminder.agentId,
          note: reminder.note,
          remindAt: reminder.remindAt,
          createdAt: reminder.createdAt,
          createdBy: reminder.createdBy,
          firedAt: reminder.firing.firedAt,
          notifyTarget: reminder.notifyTarget,
          agent: { id: reminder.agentId, ...agent },
        });
        outcome = await options.deliver({
          // Delivery-log rows are per client; the target's owner lists them with fleet_webhook_deliveries.
          client: reminder.notifyTarget,
          target,
          watchId: `reminder:${reminder.id}`,
          deliveryId: reminder.firing.deliveryId,
          body,
        });
      }
      if (stopped) return;
      reminders = reminders.filter((entry) => entry.id !== reminder.id);
      recent = [
        {
          ...toWire(reminder),
          ...reminder.firing,
          delivered: outcome.delivered,
          status: outcome.status,
          error: outcome.error,
        },
        ...recent.filter((entry) => entry.id !== reminder.id),
      ].slice(0, RECENT_LIMIT);
      await persist();
    } finally {
      sending.delete(reminder.id);
    }
  };

  // Delivery retries for up to ~15 minutes; nothing waits on it.
  const sendInBackground = (reminder: FiringReminder) => {
    send(reminder).catch((error: unknown) => {
      logger.error({ err: error, reminderId: reminder.id }, "agent reminder send failed");
    });
  };

  const fire = async (reminder: StoredReminder): Promise<void> => {
    const firedAt = now();
    const firing = {
      deliveryId: randomUUID(),
      firedAt: firedAt.toISOString(),
      late: firedAt.getTime() - Date.parse(reminder.remindAt) > REMINDER_LATE_AFTER_MS,
    };
    const fired = { ...reminder, firing };
    reminders = reminders.map((entry) => (entry.id === reminder.id ? fired : entry));
    // On disk as firing before the POST: a crash mid-send resends, never drops.
    await persist();
    options.onChange(reminder.agentId);
    logger.info(
      { reminderId: reminder.id, agentId: reminder.agentId, late: firing.late },
      "agent reminder fired",
    );
    sendInBackground(fired);
  };

  const schedule = () => {
    clearTimeout(timer ?? undefined);
    timer = null;
    if (stopped) return;
    const next = reminders
      .filter((entry) => entry.firing === null)
      .reduce<number | null>((earliest, entry) => {
        const at = Date.parse(entry.remindAt);
        return earliest === null || at < earliest ? at : earliest;
      }, null);
    if (next === null) return;
    timer = setTimeout(
      () => {
        timer = null;
        void fireDue().catch((error: unknown) => {
          logger.error({ err: error }, "agent reminder tick failed");
        });
      },
      Math.min(Math.max(next - now().getTime(), 0), MAX_TIMER_MS),
    );
    timer.unref?.();
  };

  const fireDue = async (): Promise<void> => {
    const due = reminders.filter(
      (entry) => entry.firing === null && Date.parse(entry.remindAt) <= now().getTime(),
    );
    // fire() marks each entry firing before its first await, so the timer
    // armed next only sees reminders that are still ahead.
    const fired = due.map((entry) => fire(entry));
    schedule();
    await Promise.all(fired);
  };

  return {
    async start() {
      await load();
      // A POST the previous process started and never settled: resend it.
      for (const entry of reminders) {
        if (entry.firing) sendInBackground({ ...entry, firing: entry.firing });
      }
      await fireDue();
    },

    stop() {
      stopped = true;
      clearTimeout(timer ?? undefined);
      timer = null;
    },

    async set(input) {
      const remindAtMs = input.remindAt.getTime();
      const nowMs = now().getTime();
      if (Number.isNaN(remindAtMs)) throw new Error("remindAt is not a valid time");
      if (remindAtMs <= nowMs) throw new Error("remindAt must be in the future");
      if (remindAtMs - nowMs > MAX_HORIZON_MS) {
        throw new Error("remindAt must be within a year");
      }
      const note = input.note?.trim() || null;
      if (note && note.length > AGENT_REMINDER_NOTE_MAX_LENGTH) {
        throw new Error(`note is longer than ${AGENT_REMINDER_NOTE_MAX_LENGTH} characters`);
      }
      const notifyTarget = input.notifyTarget?.trim() || DEFAULT_REMINDER_NOTIFY_TARGET;
      if (!options.resolveTarget(notifyTarget)) {
        throw new Error(
          `Notify target "${notifyTarget}" is not configured on this host (daemon.mcp.notifyTargets)`,
        );
      }
      if (!(await options.hostsAgent(input.agentId))) {
        throw new Error(`Agent ${input.agentId} is not on this host`);
      }
      const replaced = reminders.some(
        (entry) => entry.agentId === input.agentId && entry.firing === null,
      );
      const reminder: StoredReminder = {
        id: randomUUID(),
        agentId: input.agentId,
        remindAt: new Date(remindAtMs).toISOString(),
        note,
        createdAt: new Date(nowMs).toISOString(),
        createdBy: input.createdBy,
        notifyTarget,
        firing: null,
      };
      reminders = [
        ...reminders.filter((entry) => entry.agentId !== input.agentId || entry.firing !== null),
        reminder,
      ];
      await persist();
      schedule();
      options.onChange(input.agentId);
      logger.info(
        { reminderId: reminder.id, agentId: reminder.agentId, remindAt: reminder.remindAt },
        "agent reminder set",
      );
      return { reminder: toWire(reminder), replaced };
    },

    async cancel(agentId) {
      const pending = reminders.find((entry) => entry.agentId === agentId && entry.firing === null);
      if (!pending) return null;
      reminders = reminders.filter((entry) => entry.id !== pending.id);
      await persist();
      schedule();
      options.onChange(agentId);
      logger.info({ reminderId: pending.id, agentId }, "agent reminder cancelled");
      return toWire(pending);
    },

    getPending(agentId) {
      const pending = reminders.find((entry) => entry.agentId === agentId && entry.firing === null);
      return pending ? toWire(pending) : null;
    },

    list() {
      return {
        pending: reminders
          .filter((entry) => entry.firing === null)
          .map(toWire)
          .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt)),
        recent,
      };
    },
  };
}
