import { z } from "zod";
import { DocThreadAnchorSchema, DocThreadSchema } from "./types.js";

// Every doc_threads.* request/response pair follows docs/rpc-namespacing.md:
// params at the top level of the request, results under `payload`, and
// `error` null on success. `cwd` addresses the workspace (same convention as
// file_explorer_request). Threads live on the agent's host: the daemon serves
// them for agents it owns and errors otherwise.

function request<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...shape }),
  });
}

/** `path` optional: omitted lists every thread for the agent in this workspace. */
export const DocThreadsListRequestSchema = request("doc_threads.list.request", {
  cwd: z.string(),
  agentId: z.string(),
  path: z.string().optional(),
});
export const DocThreadsListResponseSchema = response("doc_threads.list.response", {
  threads: z.array(DocThreadSchema),
});

/** Creates the thread with the first user message. Does NOT send to the agent. */
export const DocThreadsCreateRequestSchema = request("doc_threads.create.request", {
  cwd: z.string(),
  agentId: z.string(),
  path: z.string().min(1),
  anchor: DocThreadAnchorSchema,
  body: z.string().trim().min(1).max(50000),
});
export const DocThreadsCreateResponseSchema = response("doc_threads.create.response", {
  thread: DocThreadSchema.nullable(),
});

/** Appends a user message. Does NOT send to the agent; see send_all. */
export const DocThreadsReplyRequestSchema = request("doc_threads.reply.request", {
  cwd: z.string(),
  threadId: z.string(),
  body: z.string().trim().min(1).max(50000),
});
export const DocThreadsReplyResponseSchema = response("doc_threads.reply.response", {
  thread: DocThreadSchema.nullable(),
});

export const DocThreadsResolveRequestSchema = request("doc_threads.resolve.request", {
  cwd: z.string(),
  threadId: z.string(),
  resolved: z.boolean(),
});
export const DocThreadsResolveResponseSchema = response("doc_threads.resolve.response", {
  thread: DocThreadSchema.nullable(),
});

/**
 * Delivers the given open threads to the agent as ONE prompt (file path,
 * anchor quote + line range, full thread history each). Queued like a normal
 * send when the agent is running.
 */
export const DocThreadsSendAllRequestSchema = request("doc_threads.send_all.request", {
  cwd: z.string(),
  agentId: z.string(),
  threadIds: z.array(z.string()).min(1).max(50),
});
export const DocThreadsSendAllResponseSchema = response("doc_threads.send_all.response", {
  sent: z.boolean(),
});

/** Push: emitted when any thread mutates. Clients refetch doc_threads.list. */
export const DocThreadsChangedMessageSchema = z.object({
  type: z.literal("doc_threads.changed"),
  // Event-push delivery stamps the owning subscription (session event
  // subscriptions); absent on broadcast delivery and from older daemons.
  subscriptionId: z.string().optional(),
  agentId: z.string(),
  // Omitted when several paths changed; the client refetches every open path.
  path: z.string().optional(),
  threadIds: z.array(z.string()),
});
export type DocThreadsChangedMessage = z.infer<typeof DocThreadsChangedMessageSchema>;

export const DOC_THREADS_INBOUND_SCHEMAS = [
  DocThreadsListRequestSchema,
  DocThreadsCreateRequestSchema,
  DocThreadsReplyRequestSchema,
  DocThreadsResolveRequestSchema,
  DocThreadsSendAllRequestSchema,
] as const;

export const DOC_THREADS_OUTBOUND_SCHEMAS = [
  DocThreadsListResponseSchema,
  DocThreadsCreateResponseSchema,
  DocThreadsReplyResponseSchema,
  DocThreadsResolveResponseSchema,
  DocThreadsSendAllResponseSchema,
  DocThreadsChangedMessageSchema,
] as const;
