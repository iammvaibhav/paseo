import { z } from "zod";
import type { DaemonClient, NotesRequestParams } from "@getpaseo/client/internal/daemon-client";
import type { NoteDetail } from "@getpaseo/protocol/notes/types";
import { ensureValidJson } from "../json-utils.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { NoteService } from "./service.js";

// Agent note tools. They read and write notes without the approval gate:
// each write is visible in the Notes screen and can be edited there.

export type NoteWriteParams = NotesRequestParams<"notes.upsert.request">;

/** Notes as the agent tools see them: sources come from the tool schema, not the wire. */
export interface NoteToolsBackend {
  listNotes(query?: string, tag?: string, projectKey?: string): Promise<NoteSummary[]>;
  getNoteBySlug(slug: string): Promise<NoteDetail | null>;
  writeNote(params: NoteWriteParams): Promise<{ note: NoteDetail; created: boolean }>;
}

export interface LocalNoteToolsBackendOptions {
  service: NoteService;
}
/** The notes host: straight to the note service. */
export function createLocalNoteToolsBackend(
  options: LocalNoteToolsBackendOptions,
): NoteToolsBackend {
  const { service } = options;
  return {
    async listNotes(query, tag, projectKey) {
      return service.listNotes({ query, tag, projectKey, limit: 100 }).notes;
    },
    async getNoteBySlug(slug) {
      return service.getNote({ slug });
    },
    async writeNote(params) {
      const created = params.noteId === undefined;
      const note = service.upsertNote(params);
      return { note, created };
    },
  };
}

export class NotesPeerRequestError extends Error {
  readonly requestType: string;

  constructor(requestType: string, message: string) {
    super(message);
    this.name = "NotesPeerRequestError";
    this.requestType = requestType;
  }
}

interface NotesPayload {
  error: string | null;
}

function unwrap<T extends NotesPayload>(requestType: string, payload: T): T {
  if (payload.error !== null) {
    throw new NotesPeerRequestError(requestType, payload.error);
  }
  return payload;
}

function requireResult<T>(requestType: string, value: T | null): T {
  if (value === null) {
    throw new NotesPeerRequestError(requestType, `${requestType} returned no result`);
  }
  return value;
}

/**
 * Any other host: through the notes-host peer connection. The notes host
 * attributes these writes to the peer session, not to the calling agent.
 */
export function createPeerNoteToolsBackend(getClient: () => DaemonClient): NoteToolsBackend {
  return {
    async listNotes(query, tag, projectKey) {
      const type = "notes.list.request";
      return unwrap(type, await getClient().notesRequest(type, { query, tag, projectKey })).notes;
    },
    async getNoteBySlug(slug) {
      const type = "notes.get.request";
      return unwrap(type, await getClient().notesRequest(type, { slug })).note;
    },
    async writeNote(params) {
      const type = "notes.upsert.request";
      const note = requireResult(
        type,
        unwrap(type, await getClient().notesRequest(type, params)).note,
      );
      return { note, created: params.noteId === undefined };
    },
  };
}

export class NoteToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteToolInputError";
  }
}

type NoteToolHandler = (
  input: unknown,
  context: PaseoToolExecutionContext,
) => Promise<PaseoToolResult>;

export interface RegisterNoteToolsOptions {
  registerTool: (
    name: string,
    config: Pick<PaseoToolConfig, "title" | "description" | "inputSchema" | "outputSchema">,
    handler: NoteToolHandler,
  ) => void;
  resolveBackend: () => NoteToolsBackend;
}

const LIST_LIMIT = 100;

const NoteSlugSchema = z
  .string()
  .trim()
  .min(1)
  .describe("Note slug from note_list, e.g. \"deploy-checklist\".");

const NoteListInputSchema = z.object({
  query: z.string().trim().min(1).optional().describe("Substring match over slug, title and body."),
  tag: z.string().trim().min(1).optional().describe("Exact tag match."),
  projectKey: z.string().trim().min(1).optional().describe("Notes saved from this project."),
});

const NoteReadInputSchema = z.object({ slug: NoteSlugSchema });

const NoteWriteInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Slug of the note to update. Omit to create a new note."),
  title: z.string().trim().min(1).max(200).optional().describe("Note title."),
  body: z.string().max(1_000_000).describe("Markdown body."),
  tags: z.array(z.string()).max(20).optional().describe("Tags; normalized lowercase."),
  sourceCwd: z.string().trim().min(1).optional().describe("Project directory the note belongs to."),
  sourceProjectKey: z.string().trim().min(1).optional().describe("Paseo project key the note belongs to."),
});

function toolResult(data: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(data) };
}

function describeNote(note: NoteSummary): Record<string, unknown> {
  return {
    slug: note.slug,
    title: note.title,
    tags: note.tags,
    updatedAt: note.updatedAt,
    preview: note.preview,
  };
}

export function registerNoteTools(options: RegisterNoteToolsOptions): void {
  const { registerTool, resolveBackend } = options;

  registerTool(
    "note_list",
    {
      title: "List notes",
      description:
        `List saved notes with slug, title, tags and preview. Filter by query (matches slug, title, body), ` +
        `tag, or projectKey. At most ${LIST_LIMIT} notes. Read-only; never approval-gated.`,
      inputSchema: NoteListInputSchema.shape,
    },
    async (raw) => {
      const input = NoteListInputSchema.parse(raw);
      const backend = resolveBackend();
      const notes = await backend.listNotes(input.query, input.tag, input.projectKey);
      return toolResult({ ok: true, total: notes.length, notes: notes.map(describeNote) });
    },
  );

  registerTool(
    "note_read",
    {
      title: "Read a note",
      description: "Read one note by slug: full markdown body, tags and source. Read-only; never approval-gated.",
      inputSchema: NoteReadInputSchema.shape,
    },
    async (raw) => {
      const input = NoteReadInputSchema.parse(raw);
      const backend = resolveBackend();
      const note = await backend.getNoteBySlug(input.slug);
      if (!note) {
        throw new NoteToolInputError(`Unknown note slug "${input.slug}".`);
      }
      return toolResult({
        ok: true,
        note: {
          slug: note.slug,
          title: note.title,
          body: note.body,
          tags: note.tags,
          updatedAt: note.updatedAt,
        },
      });
    },
  );

  registerTool(
    "note_write",
    {
      title: "Write a note",
      description:
        "Create a note (omit slug) or update one (pass its slug). The server derives " +
        "the title from the body when title is omitted. Never approval-gated.",
      inputSchema: NoteWriteInputSchema.shape,
    },
    async (raw) => {
      const input = NoteWriteInputSchema.parse(raw);
      const backend = resolveBackend();
      if (input.slug === undefined) {
        const { note } = await backend.writeNote({
          title: input.title,
          body: input.body,
          tags: input.tags,
          sourceCwd: input.sourceCwd,
          sourceProjectKey: input.sourceProjectKey,
        });
        return toolResult({ ok: true, slug: note.slug, created: true });
      }
      const existing = await backend.getNoteBySlug(input.slug);
      if (!existing) {
        throw new NoteToolInputError(`Unknown note slug "${input.slug}".`);
      }
      const { note } = await backend.writeNote({
        noteId: existing.id,
        title: input.title,
        body: input.body,
        tags: input.tags,
        sourceCwd: input.sourceCwd,
        sourceProjectKey: input.sourceProjectKey,
      });
      return toolResult({ ok: true, slug: note.slug, created: false });
    },
  );
}
