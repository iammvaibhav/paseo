import type { TFunction } from "i18next";
import {
  TicketAssigneeSchema,
  TicketPrioritySchema,
  TicketRunBucketSchema,
  type TicketActivity,
  type TicketActivityEventType,
} from "@getpaseo/protocol/tickets/types";

const BASE = "tickets.detail.activity.events";

// Assignee, priority and bucket events store the raw enum value. Old or
// imported rows can hold other text, which is shown as it is.
function assigneeText(value: string | null, t: TFunction): string | null {
  const parsed = TicketAssigneeSchema.safeParse(value);
  return parsed.success ? t(`tickets.common.assignee.${parsed.data}`) : value;
}

function priorityText(value: string | null, t: TFunction): string | null {
  const parsed = TicketPrioritySchema.safeParse(value);
  return parsed.success ? t(`tickets.common.priority.${parsed.data}`) : value;
}

function bucketText(value: string | null, t: TFunction): string {
  const parsed = TicketRunBucketSchema.safeParse(value);
  return parsed.success ? t(`tickets.common.runBucket.${parsed.data}`) : (value ?? "");
}

/** "set X", "changed X from A to B" or "cleared X", by which sides are present. */
function describeChange(
  keys: { set: string; changed: string; cleared: string },
  values: { from: string | null; to: string | null },
  t: TFunction,
): string {
  if (!values.to) {
    return t(keys.cleared, { from: values.from ?? "" });
  }
  if (values.from) {
    return t(keys.changed, { from: values.from, to: values.to });
  }
  return t(keys.set, { to: values.to });
}

type EventDescriber = (activity: TicketActivity, t: TFunction) => string;

const EVENT_DESCRIBERS: Record<TicketActivityEventType, EventDescriber> = {
  created: ({ to }, t) => (to ? t(`${BASE}.createdIn`, { column: to }) : t(`${BASE}.created`)),
  moved: ({ from, to }, t) =>
    from ? t(`${BASE}.moved`, { from, to: to ?? "" }) : t(`${BASE}.movedTo`, { to: to ?? "" }),
  renamed: ({ to }, t) => t(`${BASE}.renamed`, { to: to ?? "" }),
  assigned: ({ from, to }, t) =>
    describeChange(
      { set: `${BASE}.assigned`, changed: `${BASE}.reassigned`, cleared: `${BASE}.unassigned` },
      { from: assigneeText(from, t), to: assigneeText(to, t) },
      t,
    ),
  priority_changed: ({ from, to }, t) =>
    describeChange(
      {
        set: `${BASE}.prioritySet`,
        changed: `${BASE}.priorityChanged`,
        cleared: `${BASE}.priorityCleared`,
      },
      { from: priorityText(from, t), to: priorityText(to, t) },
      t,
    ),
  parent_changed: ({ from, to }, t) =>
    describeChange(
      {
        set: `${BASE}.parentSet`,
        changed: `${BASE}.parentChanged`,
        cleared: `${BASE}.parentCleared`,
      },
      { from, to },
      t,
    ),
  initiative_changed: ({ from, to }, t) =>
    describeChange(
      {
        set: `${BASE}.initiativeSet`,
        changed: `${BASE}.initiativeChanged`,
        cleared: `${BASE}.initiativeCleared`,
      },
      { from, to },
      t,
    ),
  blocker_added: ({ to }, t) => t(`${BASE}.blockerAdded`, { key: to ?? "" }),
  blocker_removed: ({ from }, t) => t(`${BASE}.blockerRemoved`, { key: from ?? "" }),
  archived: (_activity, t) => t(`${BASE}.archived`),
  restored: (_activity, t) => t(`${BASE}.restored`),
  run_linked: ({ to }, t) => t(`${BASE}.runLinked`, { agent: to ?? "" }),
  run_state: ({ to }, t) => t(`${BASE}.runState`, { bucket: bucketText(to, t) }),
  attachment_added: ({ to }, t) => t(`${BASE}.attachmentAdded`, { file: to ?? "" }),
  attachment_removed: ({ from }, t) => t(`${BASE}.attachmentRemoved`, { file: from ?? "" }),
  imported: (_activity, t) => t(`${BASE}.imported`),
};

/**
 * The verb phrase of one event, everything after the actor's name:
 * "moved this from Todo to In progress".
 */
export function describeActivityEvent(activity: TicketActivity, t: TFunction): string {
  return activity.eventType ? EVENT_DESCRIBERS[activity.eventType](activity, t) : "";
}
