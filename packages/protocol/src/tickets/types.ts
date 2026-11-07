import { z } from "zod";

// Native tickets (the in-daemon replacement for the external itsaplan server).
// One board host — the Mission Control Commander host — owns every board,
// ticket, initiative and comment in a SQLite store. Other hosts only report
// the lifecycle of their own agents that are linked to a ticket.

export const TicketColumnStateTypeSchema = z.enum([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
export type TicketColumnStateType = z.infer<typeof TicketColumnStateTypeSchema>;

export const TicketPrioritySchema = z.enum(["urgent", "high", "medium", "low"]);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;

export const InitiativeStatusSchema = z.enum([
  "proposed",
  "planned",
  "active",
  "completed",
  "canceled",
]);
export type InitiativeStatus = z.infer<typeof InitiativeStatusSchema>;

/** Lifecycle bucket of a linked agent, mirrored from deriveLifecycleBucket. */
export const TicketRunBucketSchema = z.enum(["needs_you", "running", "ready", "done", "idle"]);
export type TicketRunBucket = z.infer<typeof TicketRunBucketSchema>;

/** Where a record came from before it lived here. Null for native records. */
export const TicketExternalRefSchema = z.object({
  system: z.literal("itsaplan"),
  id: z.number(),
  identifier: z.string().optional(),
});
export type TicketExternalRef = z.infer<typeof TicketExternalRefSchema>;

/** Who a ticket is waiting on. A single-user system: you, or the Commander. */
export const TicketAssigneeSchema = z.enum(["user", "commander"]);
export type TicketAssignee = z.infer<typeof TicketAssigneeSchema>;

export const TicketActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("commander") }),
  z.object({
    kind: z.literal("agent"),
    agentId: z.string(),
    serverId: z.string(),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal("system") }),
  // Authored in itsaplan before the import; `name` is the itsaplan display name.
  z.object({ kind: z.literal("imported"), name: z.string() }),
]);
export type TicketActor = z.infer<typeof TicketActorSchema>;

export const TicketColumnSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  name: z.string(),
  stateType: TicketColumnStateTypeSchema,
  position: z.number(),
});
export type TicketColumn = z.infer<typeof TicketColumnSchema>;

export const TicketBoardSchema = z.object({
  id: z.string(),
  // Upper-case ticket key prefix, unique across boards ("PASEO").
  key: z.string(),
  name: z.string(),
  // Paseo logical project key (projects.json `projectKey`). Null = a board
  // not tied to any project.
  projectKey: z.string().nullable(),
  columns: z.array(TicketColumnSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  externalRef: TicketExternalRefSchema.nullable(),
});
export type TicketBoard = z.infer<typeof TicketBoardSchema>;

export const TicketRunSchema = z.object({
  ticketId: z.string(),
  agentId: z.string(),
  serverId: z.string(),
  bucket: TicketRunBucketSchema,
  agentTitle: z.string().nullable(),
  agentName: z.string().nullable(),
  archived: z.boolean(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type TicketRun = z.infer<typeof TicketRunSchema>;

/** Board-card projection. Everything a card or list row renders. */
export const TicketSummarySchema = z.object({
  id: z.string(),
  boardId: z.string(),
  key: z.string(),
  title: z.string(),
  columnId: z.string(),
  position: z.number(),
  priority: TicketPrioritySchema.nullable(),
  type: z.string().nullable(),
  assignee: TicketAssigneeSchema.nullable(),
  parentId: z.string().nullable(),
  initiativeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  subtaskCount: z.number(),
  subtaskDoneCount: z.number(),
  // Blockers whose column is not completed/canceled.
  openBlockerCount: z.number(),
  commentCount: z.number(),
  attachmentCount: z.number(),
  // The most recently updated linked run, when any.
  latestRun: TicketRunSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type TicketSummary = z.infer<typeof TicketSummarySchema>;

export const TicketAttachmentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.string(),
});
export type TicketAttachment = z.infer<typeof TicketAttachmentSchema>;

export const TicketActivityEventTypeSchema = z.enum([
  "created",
  "moved",
  "renamed",
  "assigned",
  "priority_changed",
  "parent_changed",
  "initiative_changed",
  "blocker_added",
  "blocker_removed",
  "archived",
  "restored",
  "run_linked",
  "run_state",
  "attachment_added",
  "attachment_removed",
  "imported",
]);
export type TicketActivityEventType = z.infer<typeof TicketActivityEventTypeSchema>;

export const TicketActivitySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  kind: z.enum(["comment", "event"]),
  actor: TicketActorSchema,
  // Markdown for comments; null for events.
  body: z.string().nullable(),
  eventType: TicketActivityEventTypeSchema.nullable(),
  // Event detail, e.g. { from: "Todo", to: "In Progress" } for moved.
  from: z.string().nullable(),
  to: z.string().nullable(),
  replyToId: z.string().nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});
export type TicketActivity = z.infer<typeof TicketActivitySchema>;

export const TicketDetailSchema = TicketSummarySchema.extend({
  description: z.string(),
  startDate: z.string().nullable(),
  externalRef: TicketExternalRefSchema.nullable(),
  subtasks: z.array(TicketSummarySchema),
  blockedBy: z.array(TicketSummarySchema),
  blocks: z.array(TicketSummarySchema),
  attachments: z.array(TicketAttachmentSchema),
  runs: z.array(TicketRunSchema),
  // Oldest first.
  activity: z.array(TicketActivitySchema),
});
export type TicketDetail = z.infer<typeof TicketDetailSchema>;

export const InitiativeSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  title: z.string(),
  description: z.string(),
  status: InitiativeStatusSchema,
  priority: TicketPrioritySchema.nullable(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  position: z.number(),
  ticketCount: z.number(),
  doneTicketCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  externalRef: TicketExternalRefSchema.nullable(),
});
export type Initiative = z.infer<typeof InitiativeSchema>;

export const TicketImportReportSchema = z.object({
  boards: z.number(),
  tickets: z.number(),
  comments: z.number(),
  attachments: z.number(),
  initiatives: z.number(),
  links: z.number(),
  runs: z.number(),
  // Already-imported records updated in place (idempotent re-import).
  updated: z.number(),
  errors: z.array(z.string()),
});
export type TicketImportReport = z.infer<typeof TicketImportReportSchema>;
