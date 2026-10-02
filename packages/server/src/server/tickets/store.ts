import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  InitiativeStatusSchema,
  TicketActivityEventTypeSchema,
  TicketActorSchema,
  TicketAssigneeSchema,
  TicketColumnStateTypeSchema,
  TicketPrioritySchema,
  TicketRunBucketSchema,
  type Initiative,
  type TicketActivity,
  type TicketAttachment,
  type TicketBoard,
  type TicketColumn,
  type TicketDetail,
  type TicketExternalRef,
  type TicketRun,
  type TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { tryLoadNodeSqlite, type SqliteDatabase } from "../search/sqlite.js";

export type TicketsIdPrefix = "brd" | "col" | "tkt" | "act" | "att" | "ini";

export function newId(prefix: TicketsIdPrefix): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SCHEMA_VERSION = "1";

// attachments.external_id is TEXT: itsaplan attachment ids are strings.
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  project_key TEXT,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  external_system TEXT,
  external_id INTEGER,
  external_identifier TEXT,
  UNIQUE (external_system, external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS boards_project_key ON boards (project_key)
  WHERE project_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state_type TEXT NOT NULL,
  position REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS columns_board ON columns (board_id, position);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_id TEXT NOT NULL,
  position REAL NOT NULL,
  priority TEXT,
  type TEXT,
  assignee TEXT,
  parent_id TEXT,
  initiative_id TEXT,
  start_date TEXT,
  due_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  external_system TEXT,
  external_id INTEGER,
  external_identifier TEXT,
  UNIQUE (external_system, external_id)
);
CREATE INDEX IF NOT EXISTS tickets_board_column ON tickets (board_id, column_id, position);
CREATE INDEX IF NOT EXISTS tickets_column ON tickets (column_id, position);
CREATE INDEX IF NOT EXISTS tickets_parent ON tickets (parent_id);
CREATE INDEX IF NOT EXISTS tickets_initiative ON tickets (initiative_id);
CREATE TABLE IF NOT EXISTS ticket_links (
  ticket_id TEXT NOT NULL,
  blocked_by_ticket_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, blocked_by_ticket_id)
);
CREATE INDEX IF NOT EXISTS ticket_links_blocker ON ticket_links (blocked_by_ticket_id);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  body TEXT,
  event_type TEXT,
  from_value TEXT,
  to_value TEXT,
  reply_to_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  external_system TEXT,
  external_id INTEGER,
  UNIQUE (external_system, external_id)
);
CREATE INDEX IF NOT EXISTS activity_ticket ON activity (ticket_id, kind, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  external_system TEXT,
  external_id TEXT,
  UNIQUE (external_system, external_id)
);
CREATE INDEX IF NOT EXISTS attachments_ticket ON attachments (ticket_id);
CREATE TABLE IF NOT EXISTS initiatives (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT,
  start_date TEXT,
  target_date TEXT,
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_system TEXT,
  external_id INTEGER,
  UNIQUE (external_system, external_id)
);
CREATE INDEX IF NOT EXISTS initiatives_board ON initiatives (board_id, position);
CREATE TABLE IF NOT EXISTS runs (
  ticket_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  agent_title TEXT,
  agent_name TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, agent_id)
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent_id);
CREATE INDEX IF NOT EXISTS runs_ticket_updated ON runs (ticket_id, updated_at);
`;

// Column state types that count as "done" for sub-task, blocker and initiative progress.
const DONE_STATE_TYPES_SQL = "('completed', 'canceled')";

// One statement per list: every count is a correlated subquery on an
// indexed column, and the latest run joins through its rowid.
const SUMMARY_SELECT = `
SELECT
  t.id, t.board_id, t.key, t.title, t.column_id, t.position, t.priority, t.type,
  t.assignee, t.parent_id, t.initiative_id, t.due_date, t.created_at, t.updated_at,
  t.archived_at,
  (SELECT COUNT(*) FROM tickets c
     WHERE c.parent_id = t.id AND c.archived_at IS NULL) AS subtask_count,
  (SELECT COUNT(*) FROM tickets c JOIN columns cc ON cc.id = c.column_id
     WHERE c.parent_id = t.id AND c.archived_at IS NULL
       AND cc.state_type IN ${DONE_STATE_TYPES_SQL}) AS subtask_done_count,
  (SELECT COUNT(*) FROM ticket_links l
     JOIN tickets b ON b.id = l.blocked_by_ticket_id
     JOIN columns bc ON bc.id = b.column_id
     WHERE l.ticket_id = t.id AND b.archived_at IS NULL
       AND bc.state_type NOT IN ${DONE_STATE_TYPES_SQL}) AS open_blocker_count,
  (SELECT COUNT(*) FROM activity a
     WHERE a.ticket_id = t.id AND a.kind = 'comment') AS comment_count,
  (SELECT COUNT(*) FROM attachments f WHERE f.ticket_id = t.id) AS attachment_count,
  r.agent_id AS run_agent_id, r.server_id AS run_server_id, r.bucket AS run_bucket,
  r.agent_title AS run_agent_title, r.agent_name AS run_agent_name,
  r.archived AS run_archived, r.started_at AS run_started_at, r.updated_at AS run_updated_at
FROM tickets t
LEFT JOIN runs r ON r.rowid = (
  SELECT r2.rowid FROM runs r2 WHERE r2.ticket_id = t.id
  ORDER BY r2.updated_at DESC, r2.rowid DESC LIMIT 1
)`;

const SUMMARY_ORDER = "ORDER BY t.position, t.created_at, t.id";

const INITIATIVE_SELECT = `
SELECT
  i.*,
  (SELECT COUNT(*) FROM tickets t
     WHERE t.initiative_id = i.id AND t.archived_at IS NULL) AS ticket_count,
  (SELECT COUNT(*) FROM tickets t JOIN columns c ON c.id = t.column_id
     WHERE t.initiative_id = i.id AND t.archived_at IS NULL
       AND c.state_type IN ${DONE_STATE_TYPES_SQL}) AS done_ticket_count
FROM initiatives i`;

export type SqlRow = Record<string, unknown>;

export class TicketStoreRowError extends Error {
  constructor(
    readonly column: string,
    readonly value: unknown,
  ) {
    super(`Unexpected value in tickets store column ${column}: ${String(value)}`);
    this.name = "TicketStoreRowError";
  }
}

export function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TicketStoreRowError(column, value);
  }
  return value;
}

export function textOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TicketStoreRowError(column, value);
  }
  return value;
}

export function num(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new TicketStoreRowError(column, value);
}

function toExternalRef(
  row: SqlRow,
  options: { withIdentifier: boolean },
): TicketExternalRef | null {
  if (row.external_system !== "itsaplan") {
    return null;
  }
  const id = num(row, "external_id");
  const identifier = options.withIdentifier ? textOrNull(row, "external_identifier") : null;
  return identifier === null ? { system: "itsaplan", id } : { system: "itsaplan", id, identifier };
}

export function toColumn(row: SqlRow): TicketColumn {
  return {
    id: text(row, "id"),
    boardId: text(row, "board_id"),
    name: text(row, "name"),
    stateType: TicketColumnStateTypeSchema.parse(row.state_type),
    position: num(row, "position"),
  };
}

export function toBoard(row: SqlRow, columns: TicketColumn[]): TicketBoard {
  return {
    id: text(row, "id"),
    key: text(row, "key"),
    name: text(row, "name"),
    projectKey: textOrNull(row, "project_key"),
    columns,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    archivedAt: textOrNull(row, "archived_at"),
    externalRef: toExternalRef(row, { withIdentifier: true }),
  };
}

export function toRun(row: SqlRow, prefix: "" | "run_" = ""): TicketRun {
  return {
    ticketId: prefix === "" ? text(row, "ticket_id") : text(row, "id"),
    agentId: text(row, `${prefix}agent_id`),
    serverId: text(row, `${prefix}server_id`),
    bucket: TicketRunBucketSchema.parse(row[`${prefix}bucket`]),
    agentTitle: textOrNull(row, `${prefix}agent_title`),
    agentName: textOrNull(row, `${prefix}agent_name`),
    archived: num(row, `${prefix}archived`) !== 0,
    startedAt: text(row, `${prefix}started_at`),
    updatedAt: text(row, `${prefix}updated_at`),
  };
}

/** Maps a SUMMARY_SELECT row. */
export function toSummary(row: SqlRow): TicketSummary {
  const latestRun = row.run_agent_id === null ? null : toRun(row, "run_");
  return {
    id: text(row, "id"),
    boardId: text(row, "board_id"),
    key: text(row, "key"),
    title: text(row, "title"),
    columnId: text(row, "column_id"),
    position: num(row, "position"),
    priority: TicketPrioritySchema.nullable().parse(row.priority),
    type: textOrNull(row, "type"),
    assignee: TicketAssigneeSchema.nullable().parse(row.assignee),
    parentId: textOrNull(row, "parent_id"),
    initiativeId: textOrNull(row, "initiative_id"),
    dueDate: textOrNull(row, "due_date"),
    subtaskCount: num(row, "subtask_count"),
    subtaskDoneCount: num(row, "subtask_done_count"),
    openBlockerCount: num(row, "open_blocker_count"),
    commentCount: num(row, "comment_count"),
    attachmentCount: num(row, "attachment_count"),
    latestRun,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    archivedAt: textOrNull(row, "archived_at"),
  };
}

export function toActivity(row: SqlRow): TicketActivity {
  const kind = row.kind === "comment" ? "comment" : "event";
  return {
    id: text(row, "id"),
    ticketId: text(row, "ticket_id"),
    kind,
    actor: TicketActorSchema.parse(JSON.parse(text(row, "actor_json"))),
    body: textOrNull(row, "body"),
    eventType: TicketActivityEventTypeSchema.nullable().parse(row.event_type),
    from: textOrNull(row, "from_value"),
    to: textOrNull(row, "to_value"),
    replyToId: textOrNull(row, "reply_to_id"),
    createdAt: text(row, "created_at"),
    editedAt: textOrNull(row, "edited_at"),
  };
}

export function toAttachment(row: SqlRow): TicketAttachment {
  return {
    id: text(row, "id"),
    ticketId: text(row, "ticket_id"),
    fileName: text(row, "file_name"),
    mimeType: text(row, "mime_type"),
    size: num(row, "size"),
    createdAt: text(row, "created_at"),
  };
}

/** Maps an INITIATIVE_SELECT row. */
export function toInitiative(row: SqlRow): Initiative {
  return {
    id: text(row, "id"),
    boardId: text(row, "board_id"),
    title: text(row, "title"),
    description: text(row, "description"),
    status: InitiativeStatusSchema.parse(row.status),
    priority: TicketPrioritySchema.nullable().parse(row.priority),
    startDate: textOrNull(row, "start_date"),
    targetDate: textOrNull(row, "target_date"),
    position: num(row, "position"),
    ticketCount: num(row, "ticket_count"),
    doneTicketCount: num(row, "done_ticket_count"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    externalRef: toExternalRef(row, { withIdentifier: false }),
  };
}

export interface TicketDetailParts {
  summary: TicketSummary;
  // The tickets row itself (description, start date, external ref).
  row: SqlRow;
  subtasks: TicketSummary[];
  blockedBy: TicketSummary[];
  blocks: TicketSummary[];
  attachments: TicketAttachment[];
  runs: TicketRun[];
  activity: TicketActivity[];
}

export function toDetail(parts: TicketDetailParts): TicketDetail {
  return {
    ...parts.summary,
    description: text(parts.row, "description"),
    startDate: textOrNull(parts.row, "start_date"),
    externalRef: toExternalRef(parts.row, { withIdentifier: true }),
    subtasks: parts.subtasks,
    blockedBy: parts.blockedBy,
    blocks: parts.blocks,
    attachments: parts.attachments,
    runs: parts.runs,
    activity: parts.activity,
  };
}

export interface AttachmentFile {
  fileName: string;
  mimeType: string;
  // File name inside attachmentsDirectory.
  storagePath: string;
}

export interface TicketSummaryFilter {
  boardId: string | null;
  initiativeId: string | null;
  includeArchived: boolean;
}

export interface OpenTicketStoreOptions {
  // $PASEO_HOME/tickets in the daemon; a temp directory in tests.
  directory: string;
  logger: Logger;
}

/**
 * SQLite store of the native tickets feature. Owns the schema, the revision
 * counter and the row→wire projections. Writes go through withTransaction;
 * TicketService holds the business rules.
 */
export class TicketStore {
  readonly attachmentsDirectory: string;
  private readonly db: SqliteDatabase;
  private inTransaction = false;

  private constructor(db: SqliteDatabase, directory: string) {
    this.db = db;
    this.attachmentsDirectory = path.join(directory, "attachments");
  }

  /** Null when node:sqlite is missing or the database cannot be opened: the feature is off. */
  static async open(options: OpenTicketStoreOptions): Promise<TicketStore | null> {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      options.logger.info("node:sqlite unavailable; native tickets are off");
      return null;
    }
    await mkdir(path.join(options.directory, "attachments"), { recursive: true });
    const dbPath = path.join(options.directory, "tickets.db");
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
      return new TicketStore(db, options.directory);
    } catch (error) {
      options.logger.error(
        { err: error, dbPath },
        "Tickets database unusable; native tickets are off",
      );
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one IMMEDIATE transaction. Not re-entrant. */
  withTransaction<T>(fn: (db: SqliteDatabase) => T): T {
    if (this.inTransaction) {
      throw new Error("TicketStore.withTransaction is not re-entrant");
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
      throw new TicketStoreRowError("meta.revision", undefined);
    }
    return num(row, "revision");
  }

  /** Absolute path of an attachment file from its `storage_path` (the attachment id). */
  attachmentPath(storagePath: string): string {
    return path.join(this.attachmentsDirectory, storagePath);
  }

  listBoards(): TicketBoard[] {
    const columnsByBoard = new Map<string, TicketColumn[]>();
    const columnRows = this.db.prepare("SELECT * FROM columns ORDER BY board_id, position").all();
    for (const columnRow of columnRows) {
      const column = toColumn(columnRow);
      const list = columnsByBoard.get(column.boardId) ?? [];
      list.push(column);
      columnsByBoard.set(column.boardId, list);
    }
    const boardRows = this.db
      .prepare("SELECT * FROM boards ORDER BY name COLLATE NOCASE, id")
      .all();
    return boardRows.map((row) => toBoard(row, columnsByBoard.get(text(row, "id")) ?? []));
  }

  getBoard(boardId: string): TicketBoard | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
    return row ? toBoard(row, this.listColumns(boardId)) : null;
  }

  listColumns(boardId: string): TicketColumn[] {
    return this.db
      .prepare("SELECT * FROM columns WHERE board_id = ? ORDER BY position, id")
      .all(boardId)
      .map(toColumn);
  }

  getColumn(columnId: string): TicketColumn | null {
    const row = this.db.prepare("SELECT * FROM columns WHERE id = ?").get(columnId);
    return row ? toColumn(row) : null;
  }

  listSummaries(filter: TicketSummaryFilter): TicketSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.boardId !== null) {
      clauses.push("t.board_id = ?");
      params.push(filter.boardId);
    }
    if (filter.initiativeId !== null) {
      clauses.push("t.initiative_id = ?");
      params.push(filter.initiativeId);
    }
    if (!filter.includeArchived) {
      clauses.push("t.archived_at IS NULL");
      clauses.push("t.board_id IN (SELECT id FROM boards WHERE archived_at IS NULL)");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`${SUMMARY_SELECT} ${where} ${SUMMARY_ORDER}`)
      .all(...params)
      .map(toSummary);
  }

  getSummary(ticketId: string): TicketSummary | null {
    const row = this.db.prepare(`${SUMMARY_SELECT} WHERE t.id = ?`).get(ticketId);
    return row ? toSummary(row) : null;
  }

  findTicketIdByKey(key: string): string | null {
    const row = this.db.prepare("SELECT id FROM tickets WHERE key = ?").get(key);
    return row ? text(row, "id") : null;
  }

  findTicketIdByExternalId(system: "itsaplan", externalId: number): string | null {
    const row = this.db
      .prepare("SELECT id FROM tickets WHERE external_system = ? AND external_id = ?")
      .get(system, externalId);
    return row ? text(row, "id") : null;
  }

  getAttachmentFile(attachmentId: string): AttachmentFile | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
    if (!row) {
      return null;
    }
    return {
      fileName: text(row, "file_name"),
      mimeType: text(row, "mime_type"),
      storagePath: text(row, "storage_path"),
    };
  }

  getDetail(ticketId: string): TicketDetail | null {
    const summary = this.getSummary(ticketId);
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
    if (!summary || !row) {
      return null;
    }
    const subtasks = this.db
      .prepare(
        `${SUMMARY_SELECT} WHERE t.parent_id = ? AND t.archived_at IS NULL ORDER BY t.created_at, t.id`,
      )
      .all(ticketId)
      .map(toSummary);
    const blockedBy = this.db
      .prepare(
        `${SUMMARY_SELECT} WHERE t.id IN (SELECT blocked_by_ticket_id FROM ticket_links WHERE ticket_id = ?) ORDER BY t.key`,
      )
      .all(ticketId)
      .map(toSummary);
    const blocks = this.db
      .prepare(
        `${SUMMARY_SELECT} WHERE t.id IN (SELECT ticket_id FROM ticket_links WHERE blocked_by_ticket_id = ?) ORDER BY t.key`,
      )
      .all(ticketId)
      .map(toSummary);
    const attachments = this.db
      .prepare("SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at, rowid")
      .all(ticketId)
      .map(toAttachment);
    const runs = this.db
      .prepare("SELECT * FROM runs WHERE ticket_id = ? ORDER BY updated_at DESC, rowid DESC")
      .all(ticketId)
      .map((runRow) => toRun(runRow));
    const activity = this.db
      .prepare("SELECT * FROM activity WHERE ticket_id = ? ORDER BY created_at, rowid")
      .all(ticketId)
      .map(toActivity);
    return toDetail({ summary, row, subtasks, blockedBy, blocks, attachments, runs, activity });
  }

  getActivity(activityId: string): TicketActivity | null {
    const row = this.db.prepare("SELECT * FROM activity WHERE id = ?").get(activityId);
    return row ? toActivity(row) : null;
  }

  listInitiatives(boardId: string | null): Initiative[] {
    const statement =
      boardId === null
        ? this.db.prepare(`${INITIATIVE_SELECT} ORDER BY i.position, i.created_at`)
        : this.db.prepare(
            `${INITIATIVE_SELECT} WHERE i.board_id = ? ORDER BY i.position, i.created_at`,
          );
    const rows = boardId === null ? statement.all() : statement.all(boardId);
    return rows.map(toInitiative);
  }

  getInitiative(initiativeId: string): Initiative | null {
    const row = this.db.prepare(`${INITIATIVE_SELECT} WHERE i.id = ?`).get(initiativeId);
    return row ? toInitiative(row) : null;
  }
}
