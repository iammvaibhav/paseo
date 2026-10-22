import { z } from "zod";

// Threaded file comments (doc threads). Threads live on the agent's host —
// the host that owns the agent — keyed by (agentId, path). The daemon owns
// the data; clients hold no authoritative state.

/** Who wrote a thread message. */
export const DocThreadAuthorSchema = z.enum(["user", "agent"]);
export type DocThreadAuthor = z.infer<typeof DocThreadAuthorSchema>;

/** Thread lifecycle. */
export const DocThreadStatusSchema = z.enum(["open", "resolved"]);
export type DocThreadStatus = z.infer<typeof DocThreadStatusSchema>;

/**
 * Text-range anchor. `quote` is the selected text verbatim; `before`/`after`
 * carry up to 200 chars of surrounding file text so clients can re-anchor
 * after edits.
 */
export const DocThreadAnchorSchema = z
  .object({
    quote: z.string().min(1).max(20000),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    before: z.string().max(2000).optional(),
    after: z.string().max(2000).optional(),
  })
  .refine((anchor) => anchor.endLine >= anchor.startLine, {
    message: "endLine must be >= startLine",
  });
export type DocThreadAnchor = z.infer<typeof DocThreadAnchorSchema>;

export const DocThreadMessageSchema = z.object({
  author: DocThreadAuthorSchema,
  body: z.string().min(1).max(50000),
  ts: z.string(),
});
export type DocThreadMessage = z.infer<typeof DocThreadMessageSchema>;

export const DocThreadSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** Workspace-relative path, same convention as file_explorer paths. */
  path: z.string(),
  anchor: DocThreadAnchorSchema,
  messages: z.array(DocThreadMessageSchema),
  status: DocThreadStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocThread = z.infer<typeof DocThreadSchema>;
