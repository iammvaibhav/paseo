import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type {
  Note,
  NoteDetail,
  NoteImage,
  NoteSummary,
} from "@getpaseo/protocol/notes/types";
import { tryLoadNodeSqlite, type SqliteDatabase } from "../search/sqlite.js";

export type NotesIdPrefix = "nte" | "nim";

export function newNoteId(prefix: NotesIdPrefix): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SCHEMA_VERSION = "1";

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_agent_id TEXT,
  source_host TEXT,
  source_cwd TEXT,
  source_project_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes (updated_at DESC, id);
CREATE INDEX IF NOT EXISTS notes_project_idx ON notes (source_project_key);
CREATE TABLE IF NOT EXISTS note_images (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_images_note ON note_images (note_id);
`;

export type SqlRow = Record<string, unknown>;

export class NoteStoreRowError extends Error {
  constructor(column: string, value: unknown) {
    super(`Note row has invalid ${column}: ${JSON.stringify(value)}`);
    this.name = "NoteStoreRowError";
  }
}

export function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new NoteStoreRowError(column, value);
  }
  return value;
}

export function textOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new NoteStoreRowError(column, value);
  }
  return value;
}

export function num(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new NoteStoreRowError(column, value);
  }
  return value;
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

export function toNote(row: SqlRow): Note {
  return {
    id: text(row, "id"),
    slug: text(row, "slug"),
    title: text(row, "title"),
    body: text(row, "body"),
    tags: parseTags(text(row, "tags_json")),
    ...(textOrNull(row, "source_agent_id")
      ? { sourceAgentId: textOrNull(row, "source_agent_id") as string }
      : {}),
    ...(textOrNull(row, "source_host")
      ? { sourceHost: textOrNull(row, "source_host") as string }
      : {}),
    ...(textOrNull(row, "source_cwd")
      ? { sourceCwd: textOrNull(row, "source_cwd") as string }
      : {}),
    ...(textOrNull(row, "source_project_key")
      ? { sourceProjectKey: textOrNull(row, "source_project_key") as string }
      : {}),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

/** First prose lines of the body, skipping headings and fences. */
export function notePreview(body: string, maxLength = 160): string {
  let inFence = false;
  const parts: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") {
      continue;
    }
    parts.push(trimmed.replace(/^[-*+]\s+/, ""));
    if (parts.join(" ").length >= maxLength) {
      break;
    }
  }
  const preview = parts.join(" ");
  return preview.length > maxLength ? `${preview.slice(0, maxLength - 1)}…` : preview;
}

export function toSummary(row: SqlRow): NoteSummary {
  const note = toNote(row);
  return {
    id: note.id,
    slug: note.slug,
    title: note.title,
    tags: note.tags,
    ...(note.sourceAgentId ? { sourceAgentId: note.sourceAgentId } : {}),
    ...(note.sourceHost ? { sourceHost: note.sourceHost } : {}),
    ...(note.sourceCwd ? { sourceCwd: note.sourceCwd } : {}),
    ...(note.sourceProjectKey ? { sourceProjectKey: note.sourceProjectKey } : {}),
    preview: notePreview(note.body),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export function toImage(row: SqlRow): NoteImage {
  return {
    id: text(row, "id"),
    noteId: text(row, "note_id"),
    fileName: text(row, "file_name"),
    mimeType: text(row, "mime_type"),
    size: num(row, "size"),
    createdAt: text(row, "created_at"),
  };
}

export interface OpenNoteStoreOptions {
  directory: string;
  logger: Logger;
}

/**
 * SQLite store of native notes. Owns the schema, the revision counter and
 * the row→wire projections. Writes go through withTransaction; NoteService
 * holds the business rules.
 */
export class NoteStore {
  readonly assetsDirectory: string;
  private readonly db: SqliteDatabase;
  private inTransaction = false;

  private constructor(db: SqliteDatabase, directory: string) {
    this.db = db;
    this.assetsDirectory = path.join(directory, "assets");
  }

  /** Null when node:sqlite is missing or the database cannot be opened: the feature is off. */
  static async open(options: OpenNoteStoreOptions): Promise<NoteStore | null> {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      options.logger.info("node:sqlite unavailable; native notes are off");
      return null;
    }
    await mkdir(path.join(options.directory, "assets"), { recursive: true });
    const dbPath = path.join(options.directory, "notes.db");
    // A damaged file keeps the user's data on disk: turn the feature off
    // instead of failing the daemon boot, and never rebuild over it.
    try {
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      db.exec(SCHEMA_DDL);
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0')").run();
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        SCHEMA_VERSION,
      );
      return new NoteStore(db, options.directory);
    } catch (error) {
      options.logger.error({ err: error, dbPath }, "Notes database unusable; native notes are off");
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one IMMEDIATE transaction. Not re-entrant. */
  withTransaction<T>(fn: (db: SqliteDatabase) => T): T {
    if (this.inTransaction) {
      throw new Error("NoteStore.withTransaction is not re-entrant");
    }
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn(this.db);
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Call inside withTransaction so the counter moves with the change it names. */
  bumpRevision(): number {
    this.db
      .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'")
      .run();
    return this.getRevision();
  }

  getRevision(): number {
    const row = this.db
      .prepare("SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'")
      .get();
    if (!row) {
      throw new NoteStoreRowError("meta.revision", undefined);
    }
    return num(row, "revision");
  }

  /** Absolute path of an image file from its `storage_path` (the image id). */
  imagePath(storagePath: string): string {
    return path.join(this.assetsDirectory, storagePath);
  }

  listSummaries(filter: { tag?: string; projectKey?: string; limit: number }): NoteSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.tag !== undefined) {
      clauses.push("tags_json LIKE ?");
      params.push(`%"${filter.tag.replace(/"/g, "")}"%`);
    }
    if (filter.projectKey !== undefined) {
      clauses.push("source_project_key = ?");
      params.push(filter.projectKey);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC, id LIMIT ?`)
      .all(...params, filter.limit)
      .map(toSummary);
  }

  searchSummaries(
    query: string,
    filter: { tag?: string; projectKey?: string; limit: number },
  ): NoteSummary[] {
    const clauses: string[] = ["(slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"];
    const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const params: unknown[] = [like, like, like];
    if (filter.tag !== undefined) {
      clauses.push("tags_json LIKE ?");
      params.push(`%"${filter.tag.replace(/"/g, "")}"%`);
    }
    if (filter.projectKey !== undefined) {
      clauses.push("source_project_key = ?");
      params.push(filter.projectKey);
    }
    return this.db
      .prepare(
        `SELECT * FROM notes WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(...params, filter.limit)
      .map(toSummary);
  }

  getDetail(noteId: string): NoteDetail | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
    if (!row) {
      return null;
    }
    const note = toNote(row);
    const images = this.db
      .prepare("SELECT * FROM note_images WHERE note_id = ? ORDER BY created_at, rowid")
      .all(noteId)
      .map(toImage);
    return { ...note, images };
  }

  getNoteRow(noteId: string): SqlRow | null {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) ?? null;
  }

  findNoteIdBySlug(slug: string): string | null {
    const row = this.db.prepare("SELECT id FROM notes WHERE slug = ?").get(slug);
    return row ? text(row, "id") : null;
  }

  slugTaken(slug: string, exceptNoteId?: string): boolean {
    const row =
      exceptNoteId === undefined
        ? this.db.prepare("SELECT id FROM notes WHERE slug = ?").get(slug)
        : this.db
            .prepare("SELECT id FROM notes WHERE slug = ? AND id != ?")
            .get(slug, exceptNoteId);
    return row !== undefined;
  }

  getImageFile(imageId: string): { fileName: string; mimeType: string; storagePath: string } | null {
    const row = this.db.prepare("SELECT * FROM note_images WHERE id = ?").get(imageId);
    if (!row) {
      return null;
    }
    return {
      fileName: text(row, "file_name"),
      mimeType: text(row, "mime_type"),
      storagePath: text(row, "storage_path"),
    };
  }

  getImageRow(imageId: string): SqlRow | null {
    return this.db.prepare("SELECT * FROM note_images WHERE id = ?").get(imageId) ?? null;
  }
}
