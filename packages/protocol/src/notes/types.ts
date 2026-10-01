import { z } from "zod";

// Native notes (monocode-inspired scratchpad). One notes host — the Mission
// Control Commander host, same designation rule as the tickets board host —
// owns every note in a SQLite store. Other hosts answer notes.* with an error
// naming the notes host. Agents read/write through note_* MCP tools.

export const NoteSchema = z.object({
  id: z.string(),
  // Unique URL/mention slug: @note/<slug>. Derived from the title, suffixed on collision.
  slug: z.string(),
  title: z.string(),
  // Markdown body.
  body: z.string(),
  // Normalized lowercase tags.
  tags: z.array(z.string()),
  sourceAgentId: z.string().optional(),
  // serverId of the host that owned the source agent.
  sourceHost: z.string().optional(),
  sourceCwd: z.string().optional(),
  // Paseo logical project key (projects.json `projectKey`).
  sourceProjectKey: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof NoteSchema>;

/** List projection: everything a list row renders, plus a body preview. */
export const NoteSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  sourceAgentId: z.string().optional(),
  sourceHost: z.string().optional(),
  sourceCwd: z.string().optional(),
  sourceProjectKey: z.string().optional(),
  preview: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NoteSummary = z.infer<typeof NoteSummarySchema>;

export const NoteImageSchema = z.object({
  id: z.string(),
  noteId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.string(),
});
export type NoteImage = z.infer<typeof NoteImageSchema>;

export const NoteDetailSchema = NoteSchema.extend({
  images: z.array(NoteImageSchema),
});
export type NoteDetail = z.infer<typeof NoteDetailSchema>;
