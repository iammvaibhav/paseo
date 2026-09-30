import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import type { NoteDetail, NoteImage, NoteSummary } from "@getpaseo/protocol/notes/types";
import { DEFAULT_LIST_LIMIT } from "@getpaseo/protocol/notes/rpc-schemas";
import { newNoteId, num, text, textOrNull, type NoteStore, type SqlRow } from "./store.js";
import type { SqliteDatabase } from "../search/sqlite.js";

type RequestFields<T extends SessionInboundMessage["type"]> = Omit<
  Extract<SessionInboundMessage, { type: T }>,
  "type" | "requestId"
>;

export type ListNotesInput = RequestFields<"notes.list.request">;
export type GetNoteInput = RequestFields<"notes.get.request">;
export type UpsertNoteInput = RequestFields<"notes.upsert.request">;

export interface NotesChange {
  revision: number;
  noteIds: string[];
}

export type NotesErrorCode = "not_found" | "invalid" | "conflict" | "too_large";

export class NotesError extends Error {
  readonly code: NotesErrorCode;

  constructor(code: NotesErrorCode, message: string) {
    super(message);
    this.name = "NotesError";
    this.code = code;
  }
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TITLE_MAX = 200;
const BODY_MAX = 1_000_000;
const TAG_MAX = 48;
const TAGS_MAX = 20;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export interface ImageUpload {
  fileName: string;
  mimeType: string;
  dataBase64: Buffer;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const input of tags) {
    const tag = input
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, TAG_MAX)
      .replace(/-+$/g, "");
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length === TAGS_MAX) {
      break;
    }
  }
  return normalized;
}

function unwrapMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** First markdown heading, or the first non-empty prose line. */
export function deriveNoteTitle(body: string): string {
  const heading = body.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  if (heading?.[1]) {
    const title = unwrapMarkdown(heading[1]).slice(0, TITLE_MAX);
    if (title) {
      return title;
    }
  }
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") {
      continue;
    }
    const title = unwrapMarkdown(trimmed).slice(0, TITLE_MAX);
    if (title) {
      return title;
    }
  }
  return "Untitled";
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "note";
}

export interface NoteServiceOptions {
  store: NoteStore;
  logger: Logger;
}

/**
 * Business rules of native notes over NoteStore. Every mutation runs in one
 * transaction, bumps the revision once and notifies onChange after commit.
 */
export class NoteService {
  private readonly store: NoteStore;
  private readonly logger: Logger;
  private readonly changeListeners = new Set<(change: NotesChange) => void>();

  constructor(options: NoteServiceOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ module: "notes" });
  }

  onChange(listener: (change: NotesChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private commit<T>(fn: (db: SqliteDatabase, mutation: { noteIds: string[] }) => T): T {
    const mutation = { noteIds: [] as string[] };
    const value = this.store.withTransaction((db) => {
      const result = fn(db, mutation);
      const revision = this.store.bumpRevision();
      return { result, revision };
    });
    for (const listener of this.changeListeners) {
      listener({ revision: value.revision, noteIds: mutation.noteIds });
    }
    return value.result;
  }

  private uniqueSlug(db: SqliteDatabase, title: string, exceptNoteId?: string): string {
    const base = slugify(title);
    let candidate = base;
    let counter = 2;
    while (this.slugTaken(db, candidate, exceptNoteId)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  private slugTaken(db: SqliteDatabase, slug: string, exceptNoteId?: string): boolean {
    const row =
      exceptNoteId === undefined
        ? db.prepare("SELECT id FROM notes WHERE slug = ?").get(slug)
        : db.prepare("SELECT id FROM notes WHERE slug = ? AND id != ?").get(slug, exceptNoteId);
    return row !== undefined;
  }

  private requireDetail(noteId: string): NoteDetail {
    const detail = this.store.getDetail(noteId);
    if (!detail) {
      throw new NotesError("not_found", `Note ${noteId} not found`);
    }
    return detail;
  }

  private detailOf(db: SqliteDatabase, noteId: string): NoteDetail {
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
    if (!row) {
      throw new NotesError("not_found", `Note ${noteId} not found`);
    }
    const images = db
      .prepare("SELECT * FROM note_images WHERE note_id = ? ORDER BY created_at, rowid")
      .all(noteId)
      .map((imageRow) => ({
        id: text(imageRow, "id"),
        noteId: text(imageRow, "note_id"),
        fileName: text(imageRow, "file_name"),
        mimeType: text(imageRow, "mime_type"),
        size: num(imageRow, "size"),
        createdAt: text(imageRow, "created_at"),
      }));
    const sourceAgentId = textOrNull(row, "source_agent_id");
    const sourceHost = textOrNull(row, "source_host");
    const sourceCwd = textOrNull(row, "source_cwd");
    const sourceProjectKey = textOrNull(row, "source_project_key");
    return {
      id: text(row, "id"),
      slug: text(row, "slug"),
      title: text(row, "title"),
      body: text(row, "body"),
      tags: JSON.parse(text(row, "tags_json")) as string[],
      ...(sourceAgentId ? { sourceAgentId } : {}),
      ...(sourceHost ? { sourceHost } : {}),
      ...(sourceCwd ? { sourceCwd } : {}),
      ...(sourceProjectKey ? { sourceProjectKey } : {}),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      images,
    };
  }

  listNotes(input: ListNotesInput): { notes: NoteSummary[]; revision: number } {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    const tag = input.tag?.trim().toLowerCase() || undefined;
    const projectKey = input.projectKey?.trim() || undefined;
    const filter = { tag, projectKey, limit };
    const notes =
      input.query?.trim() !== undefined && input.query?.trim() !== ""
        ? this.store.searchSummaries(input.query.trim(), filter)
        : this.store.listSummaries(filter);
    return { notes, revision: this.store.getRevision() };
  }

  getNote(input: GetNoteInput): NoteDetail | null {
    if (input.noteId) {
      return this.store.getDetail(input.noteId);
    }
    if (input.slug) {
      const noteId = this.store.findNoteIdBySlug(input.slug);
      return noteId ? this.store.getDetail(noteId) : null;
    }
    throw new NotesError("invalid", "notes.get requires noteId or slug");
  }

  upsertNote(input: UpsertNoteInput): NoteDetail {
    if (input.body !== undefined && input.body.length > BODY_MAX) {
      throw new NotesError("too_large", `Note body exceeds ${BODY_MAX} characters`);
    }
    if (input.title !== undefined && input.title.length > TITLE_MAX) {
      throw new NotesError("invalid", `Note title exceeds ${TITLE_MAX} characters`);
    }
    if (input.noteId === undefined) {
      return this.createNote(input);
    }
    return this.updateNote(input.noteId, input);
  }

  private createNote(input: UpsertNoteInput): NoteDetail {
    const body = input.body ?? "";
    const rawTitle = input.title?.trim() || "";
    const title = rawTitle === "" ? deriveNoteTitle(body) : rawTitle.slice(0, TITLE_MAX);
    const tags = normalizeTags(input.tags ?? []);
    const createdAt = nowIso();
    const noteId = newNoteId("nte");
    return this.commit((db, mutation) => {
      const slug = this.uniqueSlug(db, title);
      db.prepare(
        `INSERT INTO notes (id, slug, title, body, tags_json, source_agent_id,
          source_host, source_cwd, source_project_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        noteId,
        slug,
        title,
        body,
        JSON.stringify(tags),
        input.sourceAgentId ?? null,
        input.sourceHost ?? null,
        input.sourceCwd ?? null,
        input.sourceProjectKey ?? null,
        createdAt,
        createdAt,
      );
      mutation.noteIds.push(noteId);
      return this.detailOf(db, noteId);
    });
  }

  private updateNote(noteId: string, input: UpsertNoteInput): NoteDetail {
    return this.commit((db, mutation) => {
      const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
      if (!row) {
        throw new NotesError("not_found", `Note ${noteId} not found`);
      }
      const nextBody = input.body ?? text(row, "body");
      if (nextBody.length > BODY_MAX) {
        throw new NotesError("too_large", `Note body exceeds ${BODY_MAX} characters`);
      }
      const rawTitle = input.title?.trim() ?? text(row, "title");
      const nextTitle = rawTitle === "" ? deriveNoteTitle(nextBody) : rawTitle.slice(0, TITLE_MAX);
      const nextTags =
        input.tags === undefined ? JSON.parse(text(row, "tags_json")) : normalizeTags(input.tags);
      const assignments: string[] = [
        "title = ?",
        "body = ?",
        "tags_json = ?",
        "updated_at = ?",
      ];
      const params: unknown[] = [nextTitle, nextBody, JSON.stringify(nextTags), nowIso()];
      for (const [column, value] of [
        ["source_agent_id", input.sourceAgentId],
        ["source_host", input.sourceHost],
        ["source_cwd", input.sourceCwd],
        ["source_project_key", input.sourceProjectKey],
      ] as const) {
        if (value !== undefined) {
          assignments.push(`${column} = ?`);
          params.push(value);
        }
      }
      params.push(noteId);
      db.prepare(`UPDATE notes SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
      mutation.noteIds.push(noteId);
      return this.detailOf(db, noteId);
    });
  }

  deleteNote(noteId: string): { images: Array<{ storagePath: string }> } {
    const removed = this.commit((db, mutation) => {
      const images = db
        .prepare("SELECT storage_path FROM note_images WHERE note_id = ?")
        .all(noteId)
        .map((row) => ({ storagePath: text(row as SqlRow, "storage_path") }));
      db.prepare("DELETE FROM note_images WHERE note_id = ?").run(noteId);
      db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
      mutation.noteIds.push(noteId);
      return { images };
    });
    return removed;
  }

  async removeImageFiles(storagePaths: string[]): Promise<void> {
    for (const storagePath of storagePaths) {
      try {
        await rm(this.store.imagePath(storagePath), { force: true });
      } catch (error) {
        this.logger.warn({ err: error, storagePath }, "notes.image_file_delete_failed");
      }
    }
  }

  addImage(noteId: string, upload: ImageUpload): NoteDetail {
    if (upload.dataBase64.length > MAX_IMAGE_BYTES) {
      throw new NotesError("too_large", "Image exceeds 20 MB");
    }
    const extension = path.extname(upload.fileName).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new NotesError("invalid", `Image extension .${extension} is not supported`);
    }
    const imageId = newNoteId("nim");
    const createdAt = nowIso();
    const detail = this.commit((db, mutation) => {
      if (!db.prepare("SELECT id FROM notes WHERE id = ?").get(noteId)) {
        throw new NotesError("not_found", `Note ${noteId} not found`);
      }
      db.prepare(
        `INSERT INTO note_images (id, note_id, file_name, mime_type, size, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        imageId,
        noteId,
        upload.fileName,
        upload.mimeType,
        upload.dataBase64.length,
        imageId,
        createdAt,
      );
      mutation.noteIds.push(noteId);
      return this.detailOf(db, noteId);
    });
    return detail;
  }

  async writeImageFile(storagePath: string, bytes: Buffer): Promise<void> {
    await mkdir(this.store.assetsDirectory, { recursive: true });
    await writeFile(this.store.imagePath(storagePath), bytes);
  }

  readImage(imageId: string): { image: NoteImage; bytes: Promise<Buffer> } {
    const file = this.store.getImageFile(imageId);
    if (!file) {
      throw new NotesError("not_found", `Image ${imageId} not found`);
    }
    const row = this.store.getImageRow(imageId);
    if (!row) {
      throw new NotesError("not_found", `Image ${imageId} not found`);
    }
    return {
      image: {
        id: imageId,
        noteId: text(row, "note_id"),
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: num(row, "size"),
        createdAt: text(row, "created_at"),
      },
      bytes: readFile(this.store.imagePath(file.storagePath)),
    };
  }

  deleteImage(imageId: string): { note: NoteDetail | null; storagePath: string | null } {
    const result = this.commit((db, mutation) => {
      const row = db.prepare("SELECT * FROM note_images WHERE id = ?").get(imageId);
      if (!row) {
        return { note: null, storagePath: null as string | null };
      }
      const noteId = text(row as SqlRow, "note_id");
      const storagePath = text(row as SqlRow, "storage_path");
      db.prepare("DELETE FROM note_images WHERE id = ?").run(imageId);
      mutation.noteIds.push(noteId);
      const noteExists = db.prepare("SELECT id FROM notes WHERE id = ?").get(noteId);
      return {
        note: noteExists ? this.detailOf(db, noteId) : null,
        storagePath,
      };
    });
    return result;
  }
}
