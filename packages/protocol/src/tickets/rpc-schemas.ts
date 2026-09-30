import { z } from "zod";
import {
  InitiativeSchema,
  InitiativeStatusSchema,
  TicketActivitySchema,
  TicketAssigneeSchema,
  TicketBoardSchema,
  TicketColumnStateTypeSchema,
  TicketDetailSchema,
  TicketImportReportSchema,
  TicketPrioritySchema,
  TicketRunBucketSchema,
  TicketSummarySchema,
} from "./types.js";

// Every tickets.* request/response pair follows docs/rpc-namespacing.md:
// params at the top level of the request, results under `payload`, and
// `error` null on success. Only the board host (the Commander host) serves
// them; any other host answers `error` naming the board host.

function request<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...shape }),
  });
}

// ---------------------------------------------------------------- boards

export const TicketsBoardListRequestSchema = request("tickets.board.list.request", {});
export const TicketsBoardListResponseSchema = response("tickets.board.list.response", {
  boards: z.array(TicketBoardSchema),
});

/** Idempotent: returns the board for `projectKey` when one exists. */
export const TicketsBoardEnsureRequestSchema = request("tickets.board.ensure.request", {
  projectKey: z.string().nullable(),
  name: z.string(),
  // Preferred key prefix; the daemon derives one from `name` when absent and
  // suffixes on collision.
  key: z.string().optional(),
});
export const TicketsBoardEnsureResponseSchema = response("tickets.board.ensure.response", {
  board: TicketBoardSchema.nullable(),
});

export const TicketsBoardUpdateRequestSchema = request("tickets.board.update.request", {
  boardId: z.string(),
  name: z.string().optional(),
  archived: z.boolean().optional(),
});
export const TicketsBoardUpdateResponseSchema = response("tickets.board.update.response", {
  board: TicketBoardSchema.nullable(),
});

/** Create (no id) or update a column. `afterColumnId` null = first. */
export const TicketsColumnSaveRequestSchema = request("tickets.column.save.request", {
  boardId: z.string(),
  columnId: z.string().optional(),
  name: z.string(),
  stateType: TicketColumnStateTypeSchema,
  afterColumnId: z.string().nullable().optional(),
});
export const TicketsColumnSaveResponseSchema = response("tickets.column.save.response", {
  board: TicketBoardSchema.nullable(),
});

/** Refuses a column that still holds tickets unless `moveTicketsToColumnId` is set. */
export const TicketsColumnDeleteRequestSchema = request("tickets.column.delete.request", {
  columnId: z.string(),
  moveTicketsToColumnId: z.string().optional(),
});
export const TicketsColumnDeleteResponseSchema = response("tickets.column.delete.response", {
  board: TicketBoardSchema.nullable(),
});

// ---------------------------------------------------------------- tickets

/** boardId null/absent = every board (the all-projects view). */
export const TicketsTicketListRequestSchema = request("tickets.ticket.list.request", {
  boardId: z.string().nullable().optional(),
  initiativeId: z.string().optional(),
  includeArchived: z.boolean().optional(),
});
export const TicketsTicketListResponseSchema = response("tickets.ticket.list.response", {
  tickets: z.array(TicketSummarySchema),
  // Monotonic store revision at read time; tickets.changed carries the same counter.
  revision: z.number(),
});

/** Look up by id or by key ("PASEO-45"). */
export const TicketsTicketGetRequestSchema = request("tickets.ticket.get.request", {
  ticketId: z.string().optional(),
  key: z.string().optional(),
});
export const TicketsTicketGetResponseSchema = response("tickets.ticket.get.response", {
  ticket: TicketDetailSchema.nullable(),
});

export const TicketsTicketCreateRequestSchema = request("tickets.ticket.create.request", {
  boardId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  // Defaults to the board's first backlog column.
  columnId: z.string().optional(),
  priority: TicketPrioritySchema.nullable().optional(),
  // Ticket type ("Task"). Not `type`: that key is the message discriminator.
  ticketType: z.string().nullable().optional(),
  assignee: TicketAssigneeSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
  initiativeId: z.string().nullable().optional(),
  blockedByTicketIds: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
});
export const TicketsTicketCreateResponseSchema = response("tickets.ticket.create.response", {
  ticket: TicketDetailSchema.nullable(),
});

export const TicketsTicketUpdateRequestSchema = request("tickets.ticket.update.request", {
  ticketId: z.string(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: TicketPrioritySchema.nullable().optional(),
  ticketType: z.string().nullable().optional(),
  assignee: TicketAssigneeSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
  initiativeId: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});
export const TicketsTicketUpdateResponseSchema = response("tickets.ticket.update.response", {
  ticket: TicketDetailSchema.nullable(),
});

/** Move to a column (and/or reorder). `afterTicketId` null = top of the column. */
export const TicketsTicketMoveRequestSchema = request("tickets.ticket.move.request", {
  ticketId: z.string(),
  columnId: z.string(),
  afterTicketId: z.string().nullable().optional(),
});
export const TicketsTicketMoveResponseSchema = response("tickets.ticket.move.response", {
  ticket: TicketSummarySchema.nullable(),
});

export const TicketsTicketDeleteRequestSchema = request("tickets.ticket.delete.request", {
  ticketId: z.string(),
});
export const TicketsTicketDeleteResponseSchema = response("tickets.ticket.delete.response", {});

/** Start work on the ticket now through the Commander. */
export const TicketsTicketDispatchRequestSchema = request("tickets.ticket.dispatch.request", {
  ticketId: z.string(),
  // Extra instruction appended to the brief.
  note: z.string().optional(),
});
export const TicketsTicketDispatchResponseSchema = response("tickets.ticket.dispatch.response", {
  ticket: TicketSummarySchema.nullable(),
});

export const TicketsLinkSetRequestSchema = request("tickets.link.set.request", {
  ticketId: z.string(),
  blockedByTicketId: z.string(),
  linked: z.boolean(),
});
export const TicketsLinkSetResponseSchema = response("tickets.link.set.response", {
  ticket: TicketDetailSchema.nullable(),
});

// ---------------------------------------------------------------- comments

export const TicketsCommentAddRequestSchema = request("tickets.comment.add.request", {
  ticketId: z.string(),
  body: z.string().min(1),
  replyToId: z.string().nullable().optional(),
});
export const TicketsCommentAddResponseSchema = response("tickets.comment.add.response", {
  activity: TicketActivitySchema.nullable(),
});

export const TicketsCommentUpdateRequestSchema = request("tickets.comment.update.request", {
  activityId: z.string(),
  body: z.string().min(1),
});
export const TicketsCommentUpdateResponseSchema = response("tickets.comment.update.response", {
  activity: TicketActivitySchema.nullable(),
});

export const TicketsCommentDeleteRequestSchema = request("tickets.comment.delete.request", {
  activityId: z.string(),
});
export const TicketsCommentDeleteResponseSchema = response("tickets.comment.delete.response", {});

// ---------------------------------------------------------------- attachments

export const TicketsAttachmentAddRequestSchema = request("tickets.attachment.add.request", {
  ticketId: z.string(),
  fileName: z.string().min(1),
  mimeType: z.string(),
  // Capped by the daemon (20 MB decoded).
  dataBase64: z.string(),
});
export const TicketsAttachmentAddResponseSchema = response("tickets.attachment.add.response", {
  ticket: TicketDetailSchema.nullable(),
});

export const TicketsAttachmentReadRequestSchema = request("tickets.attachment.read.request", {
  attachmentId: z.string(),
});
export const TicketsAttachmentReadResponseSchema = response("tickets.attachment.read.response", {
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  dataBase64: z.string().nullable(),
});

export const TicketsAttachmentDeleteRequestSchema = request("tickets.attachment.delete.request", {
  attachmentId: z.string(),
});
export const TicketsAttachmentDeleteResponseSchema = response(
  "tickets.attachment.delete.response",
  { ticket: TicketDetailSchema.nullable() },
);

// ---------------------------------------------------------------- initiatives

export const TicketsInitiativeListRequestSchema = request("tickets.initiative.list.request", {
  boardId: z.string().nullable().optional(),
});
export const TicketsInitiativeListResponseSchema = response("tickets.initiative.list.response", {
  initiatives: z.array(InitiativeSchema),
});

/** Create (no id) or update. */
export const TicketsInitiativeSaveRequestSchema = request("tickets.initiative.save.request", {
  initiativeId: z.string().optional(),
  boardId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: InitiativeStatusSchema.optional(),
  priority: TicketPrioritySchema.nullable().optional(),
  startDate: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
});
export const TicketsInitiativeSaveResponseSchema = response("tickets.initiative.save.response", {
  initiative: InitiativeSchema.nullable(),
});

/** Unlinks its tickets; never deletes them. */
export const TicketsInitiativeDeleteRequestSchema = request("tickets.initiative.delete.request", {
  initiativeId: z.string(),
});
export const TicketsInitiativeDeleteResponseSchema = response(
  "tickets.initiative.delete.response",
  {},
);

// ---------------------------------------------------------------- import

/** Idempotent copy from the itsaplan server named in central config. */
export const TicketsImportItsaplanRequestSchema = request("tickets.import.itsaplan.request", {});
export const TicketsImportItsaplanResponseSchema = response("tickets.import.itsaplan.response", {
  report: TicketImportReportSchema.nullable(),
});

// ---------------------------------------------------------------- fleet

/**
 * Peer → board host: the current lifecycle of an agent on the sender that is
 * linked to a ticket. At-least-once and idempotent: the board host applies
 * forward-only column rules, so re-sending the same state is harmless. Peers
 * re-send every linked, unarchived agent when the board host comes online.
 */
export const TicketsRunReportRequestSchema = request("tickets.run.report.request", {
  serverId: z.string(),
  agentId: z.string(),
  // Native link (`paseo.ticket-id` label) or, for imported tickets, the
  // itsaplan issue id (`itsaplan.issue` label). At least one is set.
  ticketId: z.string().nullable(),
  itsaplanIssueId: z.number().nullable(),
  bucket: TicketRunBucketSchema,
  agentTitle: z.string().nullable(),
  agentName: z.string().nullable(),
  archived: z.boolean(),
  observedAt: z.string(),
});
export const TicketsRunReportResponseSchema = response("tickets.run.report.response", {
  applied: z.boolean(),
});

// ---------------------------------------------------------------- push

/**
 * Board host → client push after any committed change. Not a request/response
 * pair. Clients refetch what they show when a listed id matches; an empty
 * `boardIds` means "anything may have changed".
 */
export const TicketsChangedMessageSchema = z.object({
  type: z.literal("tickets.changed"),
  // Event-push delivery stamps the owning subscription (session event
  // subscriptions); absent on broadcast delivery and from older daemons.
  subscriptionId: z.string().optional(),
  revision: z.number(),
  boardIds: z.array(z.string()),
  ticketIds: z.array(z.string()),
  initiativeIds: z.array(z.string()),
});
export type TicketsChangedMessage = z.infer<typeof TicketsChangedMessageSchema>;

export const TICKETS_INBOUND_SCHEMAS = [
  TicketsBoardListRequestSchema,
  TicketsBoardEnsureRequestSchema,
  TicketsBoardUpdateRequestSchema,
  TicketsColumnSaveRequestSchema,
  TicketsColumnDeleteRequestSchema,
  TicketsTicketListRequestSchema,
  TicketsTicketGetRequestSchema,
  TicketsTicketCreateRequestSchema,
  TicketsTicketUpdateRequestSchema,
  TicketsTicketMoveRequestSchema,
  TicketsTicketDeleteRequestSchema,
  TicketsTicketDispatchRequestSchema,
  TicketsLinkSetRequestSchema,
  TicketsCommentAddRequestSchema,
  TicketsCommentUpdateRequestSchema,
  TicketsCommentDeleteRequestSchema,
  TicketsAttachmentAddRequestSchema,
  TicketsAttachmentReadRequestSchema,
  TicketsAttachmentDeleteRequestSchema,
  TicketsInitiativeListRequestSchema,
  TicketsInitiativeSaveRequestSchema,
  TicketsInitiativeDeleteRequestSchema,
  TicketsImportItsaplanRequestSchema,
  TicketsRunReportRequestSchema,
] as const;

export const TICKETS_OUTBOUND_SCHEMAS = [
  TicketsBoardListResponseSchema,
  TicketsBoardEnsureResponseSchema,
  TicketsBoardUpdateResponseSchema,
  TicketsColumnSaveResponseSchema,
  TicketsColumnDeleteResponseSchema,
  TicketsTicketListResponseSchema,
  TicketsTicketGetResponseSchema,
  TicketsTicketCreateResponseSchema,
  TicketsTicketUpdateResponseSchema,
  TicketsTicketMoveResponseSchema,
  TicketsTicketDeleteResponseSchema,
  TicketsTicketDispatchResponseSchema,
  TicketsLinkSetResponseSchema,
  TicketsCommentAddResponseSchema,
  TicketsCommentUpdateResponseSchema,
  TicketsCommentDeleteResponseSchema,
  TicketsAttachmentAddResponseSchema,
  TicketsAttachmentReadResponseSchema,
  TicketsAttachmentDeleteResponseSchema,
  TicketsInitiativeListResponseSchema,
  TicketsInitiativeSaveResponseSchema,
  TicketsInitiativeDeleteResponseSchema,
  TicketsImportItsaplanResponseSchema,
  TicketsRunReportResponseSchema,
  TicketsChangedMessageSchema,
] as const;
