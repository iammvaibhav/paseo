import { z } from "zod";
import { NoteDetailSchema, NoteSummarySchema } from "./types.js";

// Every notes.* request/response pair follows docs/rpc-namespacing.md:
// params at the top level of the request, results under `payload`, and
// `error` null on success. Only the notes host (the Commander host) serves
// them; any other host answers `error` naming the notes host.

function request<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...shape }),
  });
}

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

export const NotesListRequestSchema = request("notes.list.request", {
  // Substring match over slug, title and body (case-insensitive).
  query: z.string().optional(),
  tag: z.string().optional(),
  projectKey: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
});
export const NotesListResponseSchema = response("notes.list.response", {
  notes: z.array(NoteSummarySchema),
  // Monotonic store revision at read time; notes.changed carries the same counter.
  revision: z.number(),
});

/** Look up by id or by slug. One of the two is required. */
export const NotesGetRequestSchema = request("notes.get.request", {
  noteId: z.string().optional(),
  slug: z.string().optional(),
});
export const NotesGetResponseSchema = response("notes.get.response", {
  note: NoteDetailSchema.nullable(),
});

/**
 * Create (no noteId) or update. Absent fields keep their stored value on
 * update. An empty title falls back to a body-derived title.
 */
export const NotesUpsertRequestSchema = request("notes.upsert.request", {
  noteId: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sourceAgentId: z.string().optional(),
  sourceHost: z.string().optional(),
  sourceCwd: z.string().optional(),
  sourceProjectKey: z.string().optional(),
});
export const NotesUpsertResponseSchema = response("notes.upsert.response", {
  note: NoteDetailSchema.nullable(),
});

export const NotesDeleteRequestSchema = request("notes.delete.request", {
  noteId: z.string(),
});
export const NotesDeleteResponseSchema = response("notes.delete.response", {});

// ---------------------------------------------------------------- images

export const NotesImageAddRequestSchema = request("notes.image.add.request", {
  noteId: z.string(),
  fileName: z.string().min(1),
  mimeType: z.string(),
  // Capped by the daemon (20 MB decoded).
  dataBase64: z.string(),
});
export const NotesImageAddResponseSchema = response("notes.image.add.response", {
  note: NoteDetailSchema.nullable(),
});

export const NotesImageReadRequestSchema = request("notes.image.read.request", {
  imageId: z.string(),
});
export const NotesImageReadResponseSchema = response("notes.image.read.response", {
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  dataBase64: z.string().nullable(),
});

export const NotesImageDeleteRequestSchema = request("notes.image.delete.request", {
  imageId: z.string(),
});
export const NotesImageDeleteResponseSchema = response("notes.image.delete.response", {
  note: NoteDetailSchema.nullable(),
});

// ---------------------------------------------------------------- push

/**
 * Notes host → client push after any committed change. Not a request/response
 * pair. Clients refetch what they show when a listed id matches; an empty
 * `noteIds` means "anything may have changed".
 */
export const NotesChangedMessageSchema = z.object({
  type: z.literal("notes.changed"),
  // Event-push delivery stamps the owning subscription (session event
  // subscriptions); absent on broadcast delivery and from older daemons.
  subscriptionId: z.string().optional(),
  revision: z.number(),
  noteIds: z.array(z.string()),
});
export type NotesChangedMessage = z.infer<typeof NotesChangedMessageSchema>;

export const NOTES_INBOUND_SCHEMAS = [
  NotesListRequestSchema,
  NotesGetRequestSchema,
  NotesUpsertRequestSchema,
  NotesDeleteRequestSchema,
  NotesImageAddRequestSchema,
  NotesImageReadRequestSchema,
  NotesImageDeleteRequestSchema,
] as const;

export const NOTES_OUTBOUND_SCHEMAS = [
  NotesListResponseSchema,
  NotesGetResponseSchema,
  NotesUpsertResponseSchema,
  NotesDeleteResponseSchema,
  NotesImageAddResponseSchema,
  NotesImageReadResponseSchema,
  NotesImageDeleteResponseSchema,
  NotesChangedMessageSchema,
] as const;

export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT };
