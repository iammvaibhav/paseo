import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  DocThreadAnchorSchema,
  DocThreadMessageSchema,
  DocThreadStatusSchema,
  type DocThread,
  type DocThreadAnchor,
  type DocThreadMessage,
} from "@getpaseo/protocol/doc-threads/types";
import { tryLoadNodeSqlite, type SqliteDatabase } from "../search/sqlite.js";

export function newDocThreadId(): string {
  return `dth_${randomBytes(8).toString("hex")}`;
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  path TEXT NOT NULL,
  quote TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_threads_agent ON doc_threads (agent_id, workspace_id, path, updated_at);
CREATE INDEX IF NOT EXISTS doc_threads_lookup ON doc_threads (id);
CREATE TABLE IF NOT EXISTS doc_thread_messages (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES doc_threads(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_thread_messages_thread ON doc_thread_messages (thread_id, rowid);
`;

export type DocThreadRow = Record<string, unknown>;

function text(row: DocThreadRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Unexpected value in doc_threads store column ${column}: ${String(value)}`);
  }
  return value;
}

function num(row: DocThreadRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Unexpected value in doc_threads store column ${column}: ${String(value)}`);
}

export function toDocThreadAnchor(row: DocThreadRow): DocThreadAnchor {
  return DocThreadAnchorSchema.parse({
    quote: text(row, "quote"),
    startLine: num(row, "start_line"),
    endLine: num(row, "end_line"),
    before: text(row, "before_text"),
    after: text(row, "after_text"),
  });
}

export function toDocThreadMessage(row: DocThreadRow): DocThreadMessage {
  return DocThreadMessageSchema.parse({
    author: text(row, "author"),
    body: text(row, "body"),
    ts: text(row, "ts"),
  });
}
export type DocThreadRecord = DocThread & {
  workspaceId: string;
  cwd: string;
};

export interface OpenDocThreadStoreOptions {
  /** $PASEO_HOME in the daemon; a temp directory in tests. */
  directory: string;
  logger: Logger;
}

/**
 * SQLite store for doc threads. Owns the schema and the row→wire
 * projections. Keyed by (agentId, workspace, path); the agent's host owns
 * the rows. Null when node:sqlite is missing: the feature is off.
 */
export class DocThreadStore {
  private readonly db: SqliteDatabase;

  private constructor(db: SqliteDatabase) {
    this.db = db;
  }

  static async open(options: OpenDocThreadStoreOptions): Promise<DocThreadStore | null> {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      options.logger.info("node:sqlite unavailable; doc threads are off");
      return null;
    }
    await mkdir(options.directory, { recursive: true });
    const dbPath = path.join(options.directory, "doc-threads.db");
    try {
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      db.exec(SCHEMA_DDL);
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
      return new DocThreadStore(db);
    } catch (error) {
      options.logger.error(
        { err: error, dbPath },
        "Doc threads database unusable; doc threads are off",
      );
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one IMMEDIATE transaction. Not re-entrant. */
  withTransaction<T>(fn: (db: SqliteDatabase) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The rollback itself failed; surface the original error.
      }
      throw error;
    }
  }

  insertThread(input: {
    id: string;
    agentId: string;
    workspaceId: string;
    cwd: string;
    path: string;
    anchor: DocThreadAnchor;
    status: "open" | "resolved";
    createdAt: string;
    updatedAt: string;
    firstMessage: DocThreadMessage;
  }): void {
    this.withTransaction((db) => {
      db.prepare(
        `INSERT INTO doc_threads
           (id, agent_id, workspace_id, cwd, path, quote, start_line, end_line,
            before_text, after_text, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.agentId,
        input.workspaceId,
        input.cwd,
        input.path,
        input.anchor.quote,
        input.anchor.startLine,
        input.anchor.endLine,
        input.anchor.before ?? "",
        input.anchor.after ?? "",
        input.status,
        input.createdAt,
        input.updatedAt,
      );
      db.prepare(
        `INSERT INTO doc_thread_messages (thread_id, author, body, ts) VALUES (?, ?, ?, ?)`,
      ).run(input.id, input.firstMessage.author, input.firstMessage.body, input.firstMessage.ts);
    });
  }

  appendMessage(input: { threadId: string; message: DocThreadMessage; updatedAt: string }): void {
    this.withTransaction((db) => {
      db.prepare(
        `INSERT INTO doc_thread_messages (thread_id, author, body, ts) VALUES (?, ?, ?, ?)`,
      ).run(input.threadId, input.message.author, input.message.body, input.message.ts);
      db.prepare(`UPDATE doc_threads SET updated_at = ? WHERE id = ?`).run(
        input.updatedAt,
        input.threadId,
      );
    });
  }

  setStatus(threadId: string, status: "open" | "resolved", updatedAt: string): void {
    this.db
      .prepare(`UPDATE doc_threads SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, updatedAt, threadId);
  }

  getThread(threadId: string): DocThread | null {
    const record = this.getThreadRecord(threadId);
    if (!record) return null;
    const { workspaceId: _workspaceId, cwd: _cwd, ...wire } = record;
    return wire;
  }

  getThreadRecord(threadId: string): DocThreadRecord | null {
    const row = this.db.prepare(`SELECT * FROM doc_threads WHERE id = ?`).get(threadId);
    if (!row) return null;
    return this.hydrate(row);
  }

  listThreadRecords(filter: {
    agentId: string;
    workspaceId: string;
    path?: string;
  }): DocThreadRecord[] {
    const rows = filter.path
      ? this.db
          .prepare(
            `SELECT * FROM doc_threads
             WHERE agent_id = ? AND workspace_id = ? AND path = ?
             ORDER BY updated_at ASC, id ASC`,
          )
          .all(filter.agentId, filter.workspaceId, filter.path)
      : this.db
          .prepare(
            `SELECT * FROM doc_threads
             WHERE agent_id = ? AND workspace_id = ?
             ORDER BY updated_at ASC, id ASC`,
          )
          .all(filter.agentId, filter.workspaceId);
    return rows.map((row) => this.hydrate(row));
  }

  private hydrate(row: DocThreadRow): DocThreadRecord {
    const threadId = text(row, "id");
    const messageRows = this.db
      .prepare(
        `SELECT author, body, ts FROM doc_thread_messages WHERE thread_id = ? ORDER BY rowid ASC`,
      )
      .all(threadId);
    return {
      id: threadId,
      agentId: text(row, "agent_id"),
      workspaceId: text(row, "workspace_id"),
      cwd: text(row, "cwd"),
      path: text(row, "path"),
      anchor: toDocThreadAnchor(row),
      messages: messageRows.map(toDocThreadMessage),
      status: DocThreadStatusSchema.parse(text(row, "status")),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }
}
