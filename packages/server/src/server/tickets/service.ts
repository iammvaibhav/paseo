import { readFile, rm, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  TicketRunBucketSchema,
  type Initiative,
  type TicketActivity,
  type TicketActivityEventType,
  type TicketActor,
  type TicketBoard,
  type TicketColumn,
  type TicketColumnStateType,
  type TicketDetail,
  type TicketRunBucket,
  type TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import type { SessionInboundMessage } from "../messages.js";
import type { SqliteDatabase } from "../search/sqlite.js";
import { newId, num, text, textOrNull, toColumn, type SqlRow, type TicketStore } from "./store.js";

type RequestFields<T extends SessionInboundMessage["type"]> = Omit<
  Extract<SessionInboundMessage, { type: T }>,
  "type" | "requestId"
>;

export type EnsureBoardInput = RequestFields<"tickets.board.ensure.request">;
export type UpdateBoardInput = Omit<RequestFields<"tickets.board.update.request">, "boardId">;
export type SaveColumnInput = RequestFields<"tickets.column.save.request">;
export type ListTicketsInput = RequestFields<"tickets.ticket.list.request">;
export type TicketRef = RequestFields<"tickets.ticket.get.request">;
export type CreateTicketInput = RequestFields<"tickets.ticket.create.request">;
export type UpdateTicketPatch = Omit<RequestFields<"tickets.ticket.update.request">, "ticketId">;
export type SaveInitiativeInput = RequestFields<"tickets.initiative.save.request">;

export interface TicketsChange {
  revision: number;
  boardIds: string[];
  ticketIds: string[];
  initiativeIds: string[];
}

export interface TicketMovedEvent {
  ticket: TicketSummary;
  from: TicketColumn | null;
  to: TicketColumn;
  actor: TicketActor;
}

export interface TicketCommentAddedEvent {
  activity: TicketActivity;
  ticket: TicketSummary;
}

export interface TicketCreatedEvent {
  ticket: TicketSummary;
  actor: TicketActor;
}

export interface TicketListResult {
  tickets: TicketSummary[];
  revision: number;
}

export interface TicketEventInput {
  eventType: TicketActivityEventType;
  from?: string | null;
  to?: string | null;
}

export interface AttachmentUpload {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export type AttachmentContent = AttachmentUpload;

export interface UpsertRunInput {
  ticketId: string;
  agentId: string;
  serverId: string;
  bucket: TicketRunBucket;
  agentTitle: string | null;
  agentName: string | null;
  archived: boolean;
  observedAt: string;
}

export interface UpsertRunResult {
  ticket: TicketSummary;
  previousBucket: TicketRunBucket | null;
  // False when the report was older than the stored run or changed nothing.
  changed: boolean;
}

export type TicketsErrorCode = "not_found" | "invalid" | "conflict" | "too_large";

export class TicketsError extends Error {
  constructor(
    readonly code: TicketsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TicketsError";
  }
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface DefaultColumn {
  name: string;
  stateType: TicketColumnStateType;
}

export const DEFAULT_COLUMNS: readonly DefaultColumn[] = [
  { name: "Backlog", stateType: "backlog" },
  { name: "Todo", stateType: "unstarted" },
  { name: "In Progress", stateType: "started" },
  { name: "Ready to review", stateType: "started" },
  { name: "Done", stateType: "completed" },
  { name: "Canceled", stateType: "canceled" },
];

const BOARD_KEY_MAX_LENGTH = 10;
const SYSTEM_ACTOR: TicketActor = { kind: "system" };

type TicketsTable = "boards" | "columns" | "tickets" | "activity" | "attachments" | "initiatives";

const NOUN_BY_TABLE: Record<TicketsTable, string> = {
  boards: "Board",
  columns: "Column",
  tickets: "Ticket",
  activity: "Comment",
  attachments: "Attachment",
  initiatives: "Initiative",
};

// What one committed mutation touched, and the domain events to fire after it.
interface Mutation {
  boardIds: Set<string>;
  ticketIds: Set<string>;
  initiativeIds: Set<string>;
  events: Array<() => void>;
}

interface Positioned {
  id: string;
  position: number;
}

interface Slot {
  previous: number | null;
  next: number | null;
}

interface ActivityInsert {
  ticketId: string;
  actor: TicketActor;
  kind: "comment" | "event";
  body: string | null;
  eventType: TicketActivityEventType | null;
  from: string | null;
  to: string | null;
  replyToId: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireRow(db: SqliteDatabase, table: TicketsTable, id: string): SqlRow {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) {
    throw new TicketsError("not_found", `${NOUN_BY_TABLE[table]} ${id} not found`);
  }
  return row;
}

/** Reads the `value` column of a one-row aggregate. */
function selectNumber(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params);
  if (!row) {
    throw new Error(`Aggregate returned no row: ${sql}`);
  }
  return num(row, "value");
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TicketsError("invalid", `${field} must not be empty`);
  }
  return trimmed;
}

function insertActivity(db: SqliteDatabase, input: ActivityInsert): string {
  const id = newId("act");
  db.prepare(
    `INSERT INTO activity (id, ticket_id, kind, actor_json, body, event_type, from_value, to_value, reply_to_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ticketId,
    input.kind,
    JSON.stringify(input.actor),
    input.body,
    input.eventType,
    input.from,
    input.to,
    input.replyToId,
    nowIso(),
  );
  return id;
}

function insertEvent(
  db: SqliteDatabase,
  ticketId: string,
  actor: TicketActor,
  event: TicketEventInput,
): string {
  return insertActivity(db, {
    ticketId,
    actor,
    kind: "event",
    body: null,
    eventType: event.eventType,
    from: event.from ?? null,
    to: event.to ?? null,
    replyToId: null,
  });
}

/** The gap `afterId` points at: null = before the first item, undefined = after the last. */
function slotAfter(ordered: Positioned[], afterId: string | null | undefined): Slot {
  if (afterId === null) {
    return { previous: null, next: ordered[0]?.position ?? null };
  }
  if (afterId === undefined) {
    return { previous: ordered[ordered.length - 1]?.position ?? null, next: null };
  }
  const index = ordered.findIndex((item) => item.id === afterId);
  if (index === -1) {
    throw new TicketsError("invalid", `${afterId} is not a neighbour in the target list`);
  }
  return { previous: ordered[index].position, next: ordered[index + 1]?.position ?? null };
}

function positionInSlot(slot: Slot): number {
  if (slot.previous === null) {
    return slot.next === null ? 1 : slot.next - 1;
  }
  if (slot.next === null) {
    return slot.previous + 1;
  }
  return (slot.previous + slot.next) / 2;
}

/**
 * Fractional index right after `afterId`. When the gap is too small for a
 * REAL midpoint, renumbers the list 1..n first.
 */
function placeAfter(
  db: SqliteDatabase,
  table: "tickets" | "columns" | "initiatives",
  ordered: Positioned[],
  afterId: string | null | undefined,
): number {
  const slot = slotAfter(ordered, afterId);
  const position = positionInSlot(slot);
  const isSqueezed =
    slot.previous !== null &&
    slot.next !== null &&
    (position <= slot.previous || position >= slot.next);
  if (!isSqueezed) {
    return position;
  }
  const renumbered = ordered.map((item, index) => ({ id: item.id, position: index + 1 }));
  const update = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
  for (const item of renumbered) {
    update.run(item.position, item.id);
  }
  return positionInSlot(slotAfter(renumbered, afterId));
}

function toPositioned(row: SqlRow): Positioned {
  return { id: text(row, "id"), position: num(row, "position") };
}

function orderedColumnTickets(
  db: SqliteDatabase,
  columnId: string,
  excludeTicketId: string,
): Positioned[] {
  return db
    .prepare(
      `SELECT id, position FROM tickets
       WHERE column_id = ? AND id != ? AND archived_at IS NULL
       ORDER BY position, created_at, id`,
    )
    .all(columnId, excludeTicketId)
    .map(toPositioned);
}

function boardKeyBase(source: string): string {
  const cleaned = source
    .normalize("NFD")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, BOARD_KEY_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : "BOARD";
}

function uniqueBoardKey(db: SqliteDatabase, base: string): string {
  const exists = db.prepare("SELECT 1 FROM boards WHERE key = ?");
  if (!exists.get(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tail = String(suffix);
    const candidate = `${base.slice(0, BOARD_KEY_MAX_LENGTH - tail.length)}${tail}`;
    if (!exists.get(candidate)) {
      return candidate;
    }
  }
}

/**
 * Next `<BOARDKEY>-<n>` from the board's monotonic sequence. Skips numbers an
 * imported ticket already holds.
 */
function claimTicketKey(db: SqliteDatabase, board: SqlRow): TicketIdentity {
  const keyTaken = db.prepare("SELECT 1 FROM tickets WHERE key = ?");
  const boardKey = text(board, "key");
  let sequence = num(board, "next_sequence");
  while (keyTaken.get(`${boardKey}-${sequence}`)) {
    sequence += 1;
  }
  db.prepare("UPDATE boards SET next_sequence = ? WHERE id = ?").run(
    sequence + 1,
    text(board, "id"),
  );
  return { sequence, key: `${boardKey}-${sequence}` };
}

interface TicketIdentity {
  sequence: number;
  key: string;
}

// Column assignments and activity events one updateTicket call collects.
interface TicketUpdate {
  assignments: string[];
  values: unknown[];
  events: TicketEventInput[];
}

interface FieldChange<T> {
  row: SqlRow;
  // Undefined = the patch leaves the field alone.
  value: T | undefined;
  update: TicketUpdate;
  mutation: Mutation;
}

function assign(update: TicketUpdate, column: string, value: unknown): void {
  update.assignments.push(`${column} = ?`);
  update.values.push(value);
}

const PLAIN_TICKET_FIELDS = [
  { field: "description", column: "description" },
  { field: "ticketType", column: "type" },
  { field: "startDate", column: "start_date" },
  { field: "dueDate", column: "due_date" },
] as const;

const EVENTED_TICKET_FIELDS = [
  { field: "title", column: "title", eventType: "renamed" },
  { field: "priority", column: "priority", eventType: "priority_changed" },
  { field: "assignee", column: "assignee", eventType: "assigned" },
] as const;

/** Tickets whose summary counts depend on `ticketId` (its parent, the tickets it blocks). */
function dependentTicketIds(db: SqliteDatabase, ticketRow: SqlRow): string[] {
  const blocked = db
    .prepare("SELECT ticket_id FROM ticket_links WHERE blocked_by_ticket_id = ?")
    .all(text(ticketRow, "id"))
    .map((row) => text(row, "ticket_id"));
  const parentId = textOrNull(ticketRow, "parent_id");
  return parentId === null ? blocked : [...blocked, parentId];
}

function insertInitiative(db: SqliteDatabase, input: SaveInitiativeInput, title: string): string {
  const initiativeId = newId("ini");
  const ordered = db
    .prepare(
      "SELECT id, position FROM initiatives WHERE board_id = ? ORDER BY position, created_at",
    )
    .all(input.boardId)
    .map(toPositioned);
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO initiatives (id, board_id, title, description, status, priority, start_date,
       target_date, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    initiativeId,
    input.boardId,
    title,
    input.description ?? "",
    input.status ?? "proposed",
    input.priority ?? null,
    input.startDate ?? null,
    input.targetDate ?? null,
    placeAfter(db, "initiatives", ordered, undefined),
    createdAt,
    createdAt,
  );
  return initiativeId;
}

interface InitiativeUpdateInput extends SaveInitiativeInput {
  initiativeId: string;
}

/** Absent fields keep their stored value. */
function updateInitiative(db: SqliteDatabase, input: InitiativeUpdateInput, title: string): string {
  const row = requireRow(db, "initiatives", input.initiativeId);
  if (text(row, "board_id") !== input.boardId) {
    throw new TicketsError("invalid", "An initiative stays on its board");
  }
  const priority = input.priority === undefined ? row.priority : input.priority;
  const startDate = input.startDate === undefined ? row.start_date : input.startDate;
  const targetDate = input.targetDate === undefined ? row.target_date : input.targetDate;
  db.prepare(
    `UPDATE initiatives SET title = ?, description = ?, status = ?, priority = ?, start_date = ?,
       target_date = ?, updated_at = ? WHERE id = ?`,
  ).run(
    title,
    input.description ?? text(row, "description"),
    input.status ?? text(row, "status"),
    priority,
    startDate,
    targetDate,
    nowIso(),
    input.initiativeId,
  );
  return input.initiativeId;
}

/** False when the stored run is newer than the report or already says the same. */
function isRunReportNews(existing: SqlRow, input: UpsertRunInput): boolean {
  if (Date.parse(input.observedAt) < Date.parse(text(existing, "updated_at"))) {
    return false;
  }
  const isSame =
    existing.bucket === input.bucket &&
    existing.server_id === input.serverId &&
    existing.agent_title === input.agentTitle &&
    existing.agent_name === input.agentName &&
    (num(existing, "archived") !== 0) === input.archived;
  return !isSame;
}

/** Inserts or updates the run row and writes run_linked / run_state. */
function writeRun(
  db: SqliteDatabase,
  input: UpsertRunInput,
  previousBucket: TicketRunBucket | null,
): void {
  const actor: TicketActor =
    input.agentName === null
      ? { kind: "agent", agentId: input.agentId, serverId: input.serverId }
      : { kind: "agent", agentId: input.agentId, serverId: input.serverId, name: input.agentName };
  const archived = input.archived ? 1 : 0;
  if (previousBucket === null) {
    db.prepare(
      `INSERT INTO runs (ticket_id, agent_id, server_id, bucket, agent_title, agent_name, archived,
         started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.ticketId,
      input.agentId,
      input.serverId,
      input.bucket,
      input.agentTitle,
      input.agentName,
      archived,
      input.observedAt,
      input.observedAt,
    );
    insertEvent(db, input.ticketId, actor, {
      eventType: "run_linked",
      to: input.agentName ?? input.agentTitle ?? input.agentId,
    });
    return;
  }
  db.prepare(
    `UPDATE runs SET server_id = ?, bucket = ?, agent_title = ?, agent_name = ?, archived = ?,
       updated_at = ?
     WHERE ticket_id = ? AND agent_id = ?`,
  ).run(
    input.serverId,
    input.bucket,
    input.agentTitle,
    input.agentName,
    archived,
    input.observedAt,
    input.ticketId,
    input.agentId,
  );
  if (previousBucket !== input.bucket) {
    insertEvent(db, input.ticketId, actor, {
      eventType: "run_state",
      from: previousBucket,
      to: input.bucket,
    });
  }
}

export interface TicketServiceOptions {
  store: TicketStore;
  logger: Logger;
}

/**
 * Business rules of native tickets over TicketStore. Every mutation runs in
 * one transaction, writes its activity events, bumps the revision once and
 * notifies onChange after commit.
 */
export class TicketService {
  private readonly store: TicketStore;
  private readonly logger: Logger;
  private readonly changeListeners = new Set<(change: TicketsChange) => void>();
  private readonly movedListeners = new Set<(event: TicketMovedEvent) => void>();
  private readonly commentListeners = new Set<(event: TicketCommentAddedEvent) => void>();
  private readonly createdListeners = new Set<(event: TicketCreatedEvent) => void>();

  constructor(options: TicketServiceOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ module: "tickets" });
  }

  onChange(listener: (change: TicketsChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onTicketMoved(listener: (event: TicketMovedEvent) => void): () => void {
    this.movedListeners.add(listener);
    return () => {
      this.movedListeners.delete(listener);
    };
  }

  onCommentAdded(listener: (event: TicketCommentAddedEvent) => void): () => void {
    this.commentListeners.add(listener);
    return () => {
      this.commentListeners.delete(listener);
    };
  }

  onTicketCreated(listener: (event: TicketCreatedEvent) => void): () => void {
    this.createdListeners.add(listener);
    return () => {
      this.createdListeners.delete(listener);
    };
  }

  /** For writers that commit through the store directly (the itsaplan import). */
  publishChange(change: TicketsChange): void {
    this.notify(this.changeListeners, change);
  }

  // Listeners run after commit; one that throws must not turn a committed
  // mutation into a failed response.
  private notify<E>(listeners: Set<(event: E) => void>, event: E): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ err: error }, "Tickets listener failed");
      }
    }
  }

  private commit<T>(work: (db: SqliteDatabase, mutation: Mutation) => T): T {
    const mutation: Mutation = {
      boardIds: new Set(),
      ticketIds: new Set(),
      initiativeIds: new Set(),
      events: [],
    };
    const outcome = this.store.withTransaction((db) => {
      const value = work(db, mutation);
      const isTouched =
        mutation.boardIds.size > 0 ||
        mutation.ticketIds.size > 0 ||
        mutation.initiativeIds.size > 0;
      return { value, revision: isTouched ? this.store.bumpRevision() : null };
    });
    if (outcome.revision !== null) {
      this.publishChange({
        revision: outcome.revision,
        boardIds: [...mutation.boardIds],
        ticketIds: [...mutation.ticketIds],
        initiativeIds: [...mutation.initiativeIds],
      });
      for (const emit of mutation.events) {
        emit();
      }
    }
    return outcome.value;
  }

  private requireBoard(boardId: string): TicketBoard {
    const board = this.store.getBoard(boardId);
    if (!board) {
      throw new TicketsError("not_found", `Board ${boardId} not found`);
    }
    return board;
  }

  private requireSummary(ticketId: string): TicketSummary {
    const summary = this.store.getSummary(ticketId);
    if (!summary) {
      throw new TicketsError("not_found", `Ticket ${ticketId} not found`);
    }
    return summary;
  }

  private requireDetail(ticketId: string): TicketDetail {
    const detail = this.store.getDetail(ticketId);
    if (!detail) {
      throw new TicketsError("not_found", `Ticket ${ticketId} not found`);
    }
    return detail;
  }

  private requireComment(db: SqliteDatabase, activityId: string): SqlRow {
    const row = requireRow(db, "activity", activityId);
    if (row.kind !== "comment") {
      throw new TicketsError("invalid", `Activity ${activityId} is not a comment`);
    }
    return row;
  }

  // ---- boards and columns

  listBoards(): TicketBoard[] {
    return this.store.listBoards();
  }

  /** Idempotent on projectKey; boards without a project are matched by name. */
  ensureBoard(input: EnsureBoardInput): TicketBoard {
    const name = requireText(input.name, "Board name");
    return this.commit((db, mutation) => {
      const existing =
        input.projectKey === null
          ? db
              .prepare(
                "SELECT id FROM boards WHERE project_key IS NULL AND name = ? ORDER BY created_at LIMIT 1",
              )
              .get(name)
          : db.prepare("SELECT id FROM boards WHERE project_key = ?").get(input.projectKey);
      if (existing) {
        return this.requireBoard(text(existing, "id"));
      }
      const boardId = newId("brd");
      const key = uniqueBoardKey(db, boardKeyBase(input.key ?? name));
      const createdAt = nowIso();
      db.prepare(
        `INSERT INTO boards (id, key, name, project_key, next_sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).run(boardId, key, name, input.projectKey, createdAt, createdAt);
      const insertColumn = db.prepare(
        "INSERT INTO columns (id, board_id, name, state_type, position) VALUES (?, ?, ?, ?, ?)",
      );
      DEFAULT_COLUMNS.forEach((column, index) => {
        insertColumn.run(newId("col"), boardId, column.name, column.stateType, index + 1);
      });
      mutation.boardIds.add(boardId);
      return this.requireBoard(boardId);
    });
  }

  updateBoard(boardId: string, patch: UpdateBoardInput): TicketBoard {
    return this.commit((db, mutation) => {
      const row = requireRow(db, "boards", boardId);
      const name =
        patch.name === undefined ? text(row, "name") : requireText(patch.name, "Board name");
      const isArchived = textOrNull(row, "archived_at") !== null;
      const wantsArchived = patch.archived ?? isArchived;
      if (name === text(row, "name") && wantsArchived === isArchived) {
        return this.requireBoard(boardId);
      }
      const updatedAt = nowIso();
      const archivedAt = wantsArchived ? (textOrNull(row, "archived_at") ?? updatedAt) : null;
      db.prepare("UPDATE boards SET name = ?, archived_at = ?, updated_at = ? WHERE id = ?").run(
        name,
        archivedAt,
        updatedAt,
        boardId,
      );
      mutation.boardIds.add(boardId);
      return this.requireBoard(boardId);
    });
  }

  listColumns(boardId: string): TicketColumn[] {
    return this.store.listColumns(boardId);
  }

  getColumn(columnId: string): TicketColumn | null {
    return this.store.getColumn(columnId);
  }

  /** Create (no columnId) or update a column. `afterColumnId` null = first, absent = keep/last. */
  saveColumn(input: SaveColumnInput): TicketBoard {
    const name = requireText(input.name, "Column name");
    return this.commit((db, mutation) => {
      requireRow(db, "boards", input.boardId);
      const columnId = input.columnId ?? newId("col");
      const ordered = db
        .prepare(
          "SELECT id, position FROM columns WHERE board_id = ? AND id != ? ORDER BY position, id",
        )
        .all(input.boardId, columnId)
        .map(toPositioned);
      if (input.columnId === undefined) {
        const position = placeAfter(db, "columns", ordered, input.afterColumnId);
        db.prepare(
          "INSERT INTO columns (id, board_id, name, state_type, position) VALUES (?, ?, ?, ?, ?)",
        ).run(columnId, input.boardId, name, input.stateType, position);
      } else {
        const row = requireRow(db, "columns", columnId);
        if (text(row, "board_id") !== input.boardId) {
          throw new TicketsError("invalid", `Column ${columnId} is not on board ${input.boardId}`);
        }
        const position =
          input.afterColumnId === undefined
            ? num(row, "position")
            : placeAfter(db, "columns", ordered, input.afterColumnId);
        db.prepare("UPDATE columns SET name = ?, state_type = ?, position = ? WHERE id = ?").run(
          name,
          input.stateType,
          position,
          columnId,
        );
      }
      mutation.boardIds.add(input.boardId);
      return this.requireBoard(input.boardId);
    });
  }

  /**
   * Refuses a column that still holds tickets unless `moveTo` names another
   * column of the same board; moved tickets keep their order at its bottom.
   */
  deleteColumn(columnId: string, moveTo?: string): TicketBoard {
    return this.commit((db, mutation) => {
      const row = requireRow(db, "columns", columnId);
      const from = toColumn(row);
      const boardColumnCount = selectNumber(
        db,
        "SELECT COUNT(*) AS value FROM columns WHERE board_id = ?",
        from.boardId,
      );
      if (boardColumnCount <= 1) {
        throw new TicketsError("conflict", "A board keeps at least one column");
      }
      const held = db
        .prepare("SELECT * FROM tickets WHERE column_id = ? ORDER BY position, created_at, id")
        .all(columnId);
      if (held.length > 0) {
        if (moveTo === undefined) {
          throw new TicketsError(
            "conflict",
            `Column ${from.name} still holds ${held.length} tickets`,
          );
        }
        const to = toColumn(requireRow(db, "columns", moveTo));
        if (to.boardId !== from.boardId || to.id === from.id) {
          throw new TicketsError(
            "invalid",
            "Tickets can only move to another column of the same board",
          );
        }
        const bottom = selectNumber(
          db,
          "SELECT COALESCE(MAX(position), 0) AS value FROM tickets WHERE column_id = ?",
          to.id,
        );
        const move = db.prepare(
          "UPDATE tickets SET column_id = ?, position = ?, updated_at = ? WHERE id = ?",
        );
        const updatedAt = nowIso();
        for (const [index, ticketRow] of held.entries()) {
          const ticketId = text(ticketRow, "id");
          move.run(to.id, bottom + index + 1, updatedAt, ticketId);
          insertEvent(db, ticketId, SYSTEM_ACTOR, {
            eventType: "moved",
            from: from.name,
            to: to.name,
          });
          mutation.ticketIds.add(ticketId);
          for (const dependentId of dependentTicketIds(db, ticketRow)) {
            mutation.ticketIds.add(dependentId);
          }
          const ticket = this.requireSummary(ticketId);
          mutation.events.push(() =>
            this.notify(this.movedListeners, { ticket, from, to, actor: SYSTEM_ACTOR }),
          );
        }
      }
      db.prepare("DELETE FROM columns WHERE id = ?").run(columnId);
      mutation.boardIds.add(from.boardId);
      return this.requireBoard(from.boardId);
    });
  }

  // ---- tickets

  listTickets(input: ListTicketsInput): TicketListResult {
    return {
      tickets: this.store.listSummaries({
        boardId: input.boardId ?? null,
        initiativeId: input.initiativeId ?? null,
        includeArchived: input.includeArchived ?? false,
      }),
      revision: this.store.getRevision(),
    };
  }

  getTicket(ref: TicketRef): TicketDetail | null {
    if (ref.ticketId !== undefined) {
      return this.store.getDetail(ref.ticketId);
    }
    if (ref.key !== undefined) {
      const ticketId = this.store.findTicketIdByKey(ref.key.trim().toUpperCase());
      return ticketId === null ? null : this.store.getDetail(ticketId);
    }
    throw new TicketsError("invalid", "Give a ticketId or a key");
  }

  findTicketIdByExternalId(system: "itsaplan", externalId: number): string | null {
    return this.store.findTicketIdByExternalId(system, externalId);
  }

  createTicket(input: CreateTicketInput, actor: TicketActor): TicketDetail {
    const title = requireText(input.title, "Title");
    return this.commit((db, mutation) => {
      const board = requireRow(db, "boards", input.boardId);
      const column = this.resolveCreateColumn(db, input);
      if (input.parentId) {
        this.assertParentAllowed(db, {
          boardId: input.boardId,
          parentId: input.parentId,
          childId: null,
        });
      }
      if (input.initiativeId) {
        this.assertInitiativeOnBoard(db, input.initiativeId, input.boardId);
      }
      const blockerIds = [...new Set(input.blockedByTicketIds ?? [])];
      const blockerRows = blockerIds.map((blockerId) => requireRow(db, "tickets", blockerId));

      const { sequence, key } = claimTicketKey(db, board);

      const ticketId = newId("tkt");
      const createdAt = nowIso();
      const position = placeAfter(
        db,
        "tickets",
        orderedColumnTickets(db, column.id, ticketId),
        undefined,
      );
      db.prepare(
        `INSERT INTO tickets (id, board_id, sequence_number, key, title, description, column_id, position,
           priority, type, assignee, parent_id, initiative_id, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ticketId,
        input.boardId,
        sequence,
        key,
        title,
        input.description ?? "",
        column.id,
        position,
        input.priority ?? null,
        input.ticketType ?? null,
        input.assignee ?? null,
        input.parentId ?? null,
        input.initiativeId ?? null,
        input.dueDate ?? null,
        createdAt,
        createdAt,
      );
      insertEvent(db, ticketId, actor, { eventType: "created", to: column.name });
      const insertLink = db.prepare(
        "INSERT INTO ticket_links (ticket_id, blocked_by_ticket_id, created_at) VALUES (?, ?, ?)",
      );
      for (const blockerRow of blockerRows) {
        insertLink.run(ticketId, text(blockerRow, "id"), createdAt);
        insertEvent(db, ticketId, actor, {
          eventType: "blocker_added",
          to: text(blockerRow, "key"),
        });
        mutation.ticketIds.add(text(blockerRow, "id"));
        mutation.boardIds.add(text(blockerRow, "board_id"));
      }
      mutation.boardIds.add(input.boardId);
      mutation.ticketIds.add(ticketId);
      if (input.parentId) {
        mutation.ticketIds.add(input.parentId);
      }
      if (input.initiativeId) {
        mutation.initiativeIds.add(input.initiativeId);
      }
      const ticket = this.requireSummary(ticketId);
      mutation.events.push(() => this.notify(this.createdListeners, { ticket, actor }));
      return this.requireDetail(ticketId);
    });
  }

  private resolveCreateColumn(db: SqliteDatabase, input: CreateTicketInput): TicketColumn {
    if (input.columnId !== undefined) {
      const column = toColumn(requireRow(db, "columns", input.columnId));
      if (column.boardId !== input.boardId) {
        throw new TicketsError(
          "invalid",
          `Column ${input.columnId} is not on board ${input.boardId}`,
        );
      }
      return column;
    }
    const row = db
      .prepare(
        `SELECT * FROM columns WHERE board_id = ?
         ORDER BY CASE state_type WHEN 'backlog' THEN 0 ELSE 1 END, position LIMIT 1`,
      )
      .get(input.boardId);
    if (!row) {
      throw new TicketsError("invalid", `Board ${input.boardId} has no columns`);
    }
    return toColumn(row);
  }

  /** Sub-tasks are one level deep and stay on their parent's board. */
  private assertParentAllowed(
    db: SqliteDatabase,
    input: { boardId: string; parentId: string; childId: string | null },
  ): SqlRow {
    const parent = requireRow(db, "tickets", input.parentId);
    if (input.childId === input.parentId) {
      throw new TicketsError("invalid", "A ticket cannot be its own parent");
    }
    if (text(parent, "board_id") !== input.boardId) {
      throw new TicketsError("invalid", "A sub-task stays on its parent's board");
    }
    if (textOrNull(parent, "parent_id") !== null) {
      throw new TicketsError("invalid", `${text(parent, "key")} is already a sub-task`);
    }
    if (input.childId !== null) {
      const hasChildren = db
        .prepare("SELECT 1 FROM tickets WHERE parent_id = ? LIMIT 1")
        .get(input.childId);
      if (hasChildren) {
        throw new TicketsError("invalid", "A ticket with sub-tasks cannot become a sub-task");
      }
    }
    return parent;
  }

  private assertInitiativeOnBoard(
    db: SqliteDatabase,
    initiativeId: string,
    boardId: string,
  ): SqlRow {
    const initiative = requireRow(db, "initiatives", initiativeId);
    if (text(initiative, "board_id") !== boardId) {
      throw new TicketsError("invalid", `Initiative ${initiativeId} is not on board ${boardId}`);
    }
    return initiative;
  }

  updateTicket(ticketId: string, patch: UpdateTicketPatch, actor: TicketActor): TicketDetail {
    const fields = {
      ...patch,
      title: patch.title === undefined ? undefined : requireText(patch.title, "Title"),
    };
    return this.commit((db, mutation) => {
      const row = requireRow(db, "tickets", ticketId);
      const update: TicketUpdate = { assignments: [], values: [], events: [] };
      for (const { field, column } of PLAIN_TICKET_FIELDS) {
        const value = fields[field];
        if (value !== undefined && value !== row[column]) {
          assign(update, column, value);
        }
      }
      for (const { field, column, eventType } of EVENTED_TICKET_FIELDS) {
        const value = fields[field];
        if (value !== undefined && value !== row[column]) {
          assign(update, column, value);
          update.events.push({ eventType, from: textOrNull(row, column), to: value });
        }
      }
      this.planParentChange(db, { row, value: patch.parentId, update, mutation });
      this.planInitiativeChange(db, { row, value: patch.initiativeId, update, mutation });
      this.planArchiveChange(db, { row, value: patch.archived, update, mutation });

      if (update.assignments.length === 0) {
        return this.requireDetail(ticketId);
      }
      assign(update, "updated_at", nowIso());
      db.prepare(`UPDATE tickets SET ${update.assignments.join(", ")} WHERE id = ?`).run(
        ...update.values,
        ticketId,
      );
      for (const event of update.events) {
        insertEvent(db, ticketId, actor, event);
      }
      mutation.boardIds.add(text(row, "board_id"));
      mutation.ticketIds.add(ticketId);
      return this.requireDetail(ticketId);
    });
  }

  private planParentChange(db: SqliteDatabase, change: FieldChange<string | null>): void {
    const previousParentId = textOrNull(change.row, "parent_id");
    const parentId = change.value;
    if (parentId === undefined || parentId === previousParentId) {
      return;
    }
    const parent =
      parentId === null
        ? null
        : this.assertParentAllowed(db, {
            boardId: text(change.row, "board_id"),
            parentId,
            childId: text(change.row, "id"),
          });
    const previousParent =
      previousParentId === null
        ? undefined
        : db.prepare("SELECT key FROM tickets WHERE id = ?").get(previousParentId);
    assign(change.update, "parent_id", parentId);
    change.update.events.push({
      eventType: "parent_changed",
      from: previousParent ? text(previousParent, "key") : null,
      to: parent ? text(parent, "key") : null,
    });
    for (const affectedId of [previousParentId, parentId]) {
      if (affectedId !== null) {
        change.mutation.ticketIds.add(affectedId);
      }
    }
  }

  private planInitiativeChange(db: SqliteDatabase, change: FieldChange<string | null>): void {
    const previousInitiativeId = textOrNull(change.row, "initiative_id");
    const initiativeId = change.value;
    if (initiativeId === undefined || initiativeId === previousInitiativeId) {
      return;
    }
    const initiative =
      initiativeId === null
        ? null
        : this.assertInitiativeOnBoard(db, initiativeId, text(change.row, "board_id"));
    const previousInitiative =
      previousInitiativeId === null
        ? undefined
        : db.prepare("SELECT title FROM initiatives WHERE id = ?").get(previousInitiativeId);
    assign(change.update, "initiative_id", initiativeId);
    change.update.events.push({
      eventType: "initiative_changed",
      from: previousInitiative ? text(previousInitiative, "title") : null,
      to: initiative ? text(initiative, "title") : null,
    });
    for (const affectedId of [previousInitiativeId, initiativeId]) {
      if (affectedId !== null) {
        change.mutation.initiativeIds.add(affectedId);
      }
    }
  }

  // Archiving changes the counts of the parent, of blocked tickets and of the initiative.
  private planArchiveChange(db: SqliteDatabase, change: FieldChange<boolean>): void {
    const isArchived = textOrNull(change.row, "archived_at") !== null;
    if (change.value === undefined || change.value === isArchived) {
      return;
    }
    assign(change.update, "archived_at", change.value ? nowIso() : null);
    change.update.events.push({ eventType: change.value ? "archived" : "restored" });
    for (const dependentId of dependentTicketIds(db, change.row)) {
      change.mutation.ticketIds.add(dependentId);
    }
    const initiativeId = textOrNull(change.row, "initiative_id");
    if (initiativeId !== null) {
      change.mutation.initiativeIds.add(initiativeId);
    }
  }

  /** `afterTicketId` null = top of the column, undefined = bottom. */
  moveTicket(
    ticketId: string,
    columnId: string,
    afterTicketId: string | null | undefined,
    actor: TicketActor,
  ): TicketSummary {
    return this.commit((db, mutation) => {
      const row = requireRow(db, "tickets", ticketId);
      const to = toColumn(requireRow(db, "columns", columnId));
      if (to.boardId !== text(row, "board_id")) {
        throw new TicketsError("invalid", "A ticket moves only between columns of its own board");
      }
      const position = placeAfter(
        db,
        "tickets",
        orderedColumnTickets(db, columnId, ticketId),
        afterTicketId,
      );
      const fromColumnId = text(row, "column_id");
      if (fromColumnId === columnId) {
        db.prepare("UPDATE tickets SET position = ? WHERE id = ?").run(position, ticketId);
      } else {
        const fromRow = db.prepare("SELECT * FROM columns WHERE id = ?").get(fromColumnId);
        const from = fromRow ? toColumn(fromRow) : null;
        db.prepare(
          "UPDATE tickets SET column_id = ?, position = ?, updated_at = ? WHERE id = ?",
        ).run(columnId, position, nowIso(), ticketId);
        insertEvent(db, ticketId, actor, {
          eventType: "moved",
          from: from?.name ?? null,
          to: to.name,
        });
        for (const dependentId of dependentTicketIds(db, row)) {
          mutation.ticketIds.add(dependentId);
        }
        const initiativeId = textOrNull(row, "initiative_id");
        if (initiativeId !== null) {
          mutation.initiativeIds.add(initiativeId);
        }
        const moved = this.requireSummary(ticketId);
        mutation.events.push(() =>
          this.notify(this.movedListeners, { ticket: moved, from, to, actor }),
        );
      }
      mutation.boardIds.add(to.boardId);
      mutation.ticketIds.add(ticketId);
      return this.requireSummary(ticketId);
    });
  }

  /** Removes the ticket with its links, activity, attachments (files too) and runs; sub-tasks are detached. */
  async deleteTicket(ticketId: string): Promise<void> {
    const storagePaths = this.commit((db, mutation) => {
      const row = requireRow(db, "tickets", ticketId);
      const linkedRows = db
        .prepare(
          `SELECT t.id, t.board_id FROM ticket_links l JOIN tickets t
             ON t.id = CASE WHEN l.ticket_id = ? THEN l.blocked_by_ticket_id ELSE l.ticket_id END
           WHERE l.ticket_id = ? OR l.blocked_by_ticket_id = ?`,
        )
        .all(ticketId, ticketId, ticketId);
      const childIds = db
        .prepare("SELECT id FROM tickets WHERE parent_id = ?")
        .all(ticketId)
        .map((child) => text(child, "id"));
      const paths = db
        .prepare("SELECT storage_path FROM attachments WHERE ticket_id = ?")
        .all(ticketId)
        .map((attachment) => text(attachment, "storage_path"));

      db.prepare("DELETE FROM ticket_links WHERE ticket_id = ? OR blocked_by_ticket_id = ?").run(
        ticketId,
        ticketId,
      );
      db.prepare("DELETE FROM activity WHERE ticket_id = ?").run(ticketId);
      db.prepare("DELETE FROM attachments WHERE ticket_id = ?").run(ticketId);
      db.prepare("DELETE FROM runs WHERE ticket_id = ?").run(ticketId);
      db.prepare("UPDATE tickets SET parent_id = NULL WHERE parent_id = ?").run(ticketId);
      for (const childId of childIds) {
        insertEvent(db, childId, SYSTEM_ACTOR, {
          eventType: "parent_changed",
          from: text(row, "key"),
        });
        mutation.ticketIds.add(childId);
      }
      db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

      mutation.boardIds.add(text(row, "board_id"));
      mutation.ticketIds.add(ticketId);
      for (const linked of linkedRows) {
        mutation.ticketIds.add(text(linked, "id"));
        mutation.boardIds.add(text(linked, "board_id"));
      }
      const parentId = textOrNull(row, "parent_id");
      if (parentId !== null) {
        mutation.ticketIds.add(parentId);
      }
      const initiativeId = textOrNull(row, "initiative_id");
      if (initiativeId !== null) {
        mutation.initiativeIds.add(initiativeId);
      }
      return paths;
    });
    await Promise.all(
      storagePaths.map((storagePath) =>
        rm(this.store.attachmentPath(storagePath), { force: true }),
      ),
    );
  }

  /** Cross-board links are allowed; a link that closes a cycle is refused. */
  setLink(
    ticketId: string,
    blockedByTicketId: string,
    linked: boolean,
    actor: TicketActor,
  ): TicketDetail {
    if (ticketId === blockedByTicketId) {
      throw new TicketsError("invalid", "A ticket cannot block itself");
    }
    return this.commit((db, mutation) => {
      const ticket = requireRow(db, "tickets", ticketId);
      const blocker = requireRow(db, "tickets", blockedByTicketId);
      const existing = db
        .prepare("SELECT 1 FROM ticket_links WHERE ticket_id = ? AND blocked_by_ticket_id = ?")
        .get(ticketId, blockedByTicketId);
      if (linked === Boolean(existing)) {
        return this.requireDetail(ticketId);
      }
      if (linked) {
        // Cycle when the new blocker is already, directly or not, blocked by the ticket.
        const closesCycle = db
          .prepare(
            `WITH RECURSIVE chain(id) AS (
               SELECT ?
               UNION
               SELECT l.blocked_by_ticket_id FROM ticket_links l JOIN chain ON l.ticket_id = chain.id
             )
             SELECT 1 FROM chain WHERE id = ? LIMIT 1`,
          )
          .get(blockedByTicketId, ticketId);
        if (closesCycle) {
          throw new TicketsError(
            "conflict",
            `${text(blocker, "key")} already waits on ${text(ticket, "key")}; the link would create a cycle`,
          );
        }
        db.prepare(
          "INSERT INTO ticket_links (ticket_id, blocked_by_ticket_id, created_at) VALUES (?, ?, ?)",
        ).run(ticketId, blockedByTicketId, nowIso());
        insertEvent(db, ticketId, actor, { eventType: "blocker_added", to: text(blocker, "key") });
      } else {
        db.prepare("DELETE FROM ticket_links WHERE ticket_id = ? AND blocked_by_ticket_id = ?").run(
          ticketId,
          blockedByTicketId,
        );
        insertEvent(db, ticketId, actor, {
          eventType: "blocker_removed",
          from: text(blocker, "key"),
        });
      }
      mutation.boardIds.add(text(ticket, "board_id"));
      mutation.boardIds.add(text(blocker, "board_id"));
      mutation.ticketIds.add(ticketId);
      mutation.ticketIds.add(blockedByTicketId);
      return this.requireDetail(ticketId);
    });
  }

  // ---- activity

  addComment(
    ticketId: string,
    body: string,
    actor: TicketActor,
    replyToId?: string | null,
  ): TicketActivity {
    const content = requireText(body, "Comment");
    return this.commit((db, mutation) => {
      const ticket = requireRow(db, "tickets", ticketId);
      if (replyToId) {
        const parent = this.requireComment(db, replyToId);
        if (text(parent, "ticket_id") !== ticketId) {
          throw new TicketsError("invalid", "A reply stays on the ticket of its comment");
        }
      }
      const activityId = insertActivity(db, {
        ticketId,
        actor,
        kind: "comment",
        body: content,
        eventType: null,
        from: null,
        to: null,
        replyToId: replyToId ?? null,
      });
      mutation.boardIds.add(text(ticket, "board_id"));
      mutation.ticketIds.add(ticketId);
      const activity = this.requireActivity(activityId);
      const summary = this.requireSummary(ticketId);
      mutation.events.push(() => this.notify(this.commentListeners, { activity, ticket: summary }));
      return activity;
    });
  }

  private requireActivity(activityId: string): TicketActivity {
    const activity = this.store.getActivity(activityId);
    if (!activity) {
      throw new TicketsError("not_found", `Comment ${activityId} not found`);
    }
    return activity;
  }

  updateComment(activityId: string, body: string): TicketActivity {
    const content = requireText(body, "Comment");
    return this.commit((db, mutation) => {
      const row = this.requireComment(db, activityId);
      if (content !== text(row, "body")) {
        db.prepare("UPDATE activity SET body = ?, edited_at = ? WHERE id = ?").run(
          content,
          nowIso(),
          activityId,
        );
        this.touchTicket(db, mutation, text(row, "ticket_id"));
      }
      return this.requireActivity(activityId);
    });
  }

  /** Replies to the deleted comment stay, as top-level comments. */
  deleteComment(activityId: string): void {
    this.commit((db, mutation) => {
      const row = this.requireComment(db, activityId);
      db.prepare("DELETE FROM activity WHERE id = ?").run(activityId);
      db.prepare("UPDATE activity SET reply_to_id = NULL WHERE reply_to_id = ?").run(activityId);
      this.touchTicket(db, mutation, text(row, "ticket_id"));
    });
  }

  private touchTicket(db: SqliteDatabase, mutation: Mutation, ticketId: string): void {
    const ticket = requireRow(db, "tickets", ticketId);
    mutation.boardIds.add(text(ticket, "board_id"));
    mutation.ticketIds.add(ticketId);
  }

  addEvent(ticketId: string, event: TicketEventInput, actor: TicketActor): TicketActivity {
    return this.commit((db, mutation) => {
      this.touchTicket(db, mutation, ticketId);
      return this.requireActivity(insertEvent(db, ticketId, actor, event));
    });
  }

  // ---- attachments

  async addAttachment(
    ticketId: string,
    upload: AttachmentUpload,
    actor: TicketActor,
  ): Promise<TicketDetail> {
    const fileName = requireText(upload.fileName, "File name");
    if (upload.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new TicketsError("too_large", "Attachments are limited to 20 MB");
    }
    this.requireSummary(ticketId);
    const attachmentId = newId("att");
    const filePath = this.store.attachmentPath(attachmentId);
    await writeFile(filePath, upload.data);
    // The ticket can go away while the file is written; drop the orphan file.
    try {
      return this.commit((db, mutation) => {
        this.touchTicket(db, mutation, ticketId);
        db.prepare(
          `INSERT INTO attachments (id, ticket_id, file_name, mime_type, size, storage_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          attachmentId,
          ticketId,
          fileName,
          upload.mimeType,
          upload.data.byteLength,
          attachmentId,
          nowIso(),
        );
        insertEvent(db, ticketId, actor, { eventType: "attachment_added", to: fileName });
        return this.requireDetail(ticketId);
      });
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }

  async readAttachment(attachmentId: string): Promise<AttachmentContent | null> {
    const file = this.store.getAttachmentFile(attachmentId);
    if (!file) {
      return null;
    }
    const data = await readFile(this.store.attachmentPath(file.storagePath));
    return { fileName: file.fileName, mimeType: file.mimeType, data };
  }

  async deleteAttachment(attachmentId: string, actor: TicketActor): Promise<TicketDetail> {
    const removed = this.commit((db, mutation) => {
      const row = requireRow(db, "attachments", attachmentId);
      const ticketId = text(row, "ticket_id");
      db.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
      insertEvent(db, ticketId, actor, {
        eventType: "attachment_removed",
        from: text(row, "file_name"),
      });
      this.touchTicket(db, mutation, ticketId);
      return { storagePath: text(row, "storage_path"), ticket: this.requireDetail(ticketId) };
    });
    await rm(this.store.attachmentPath(removed.storagePath), { force: true });
    return removed.ticket;
  }

  // ---- initiatives

  listInitiatives(boardId?: string | null): Initiative[] {
    return this.store.listInitiatives(boardId ?? null);
  }

  saveInitiative(input: SaveInitiativeInput): Initiative {
    const title = requireText(input.title, "Title");
    return this.commit((db, mutation) => {
      requireRow(db, "boards", input.boardId);
      const initiativeId =
        input.initiativeId === undefined
          ? insertInitiative(db, input, title)
          : updateInitiative(db, { ...input, initiativeId: input.initiativeId }, title);
      mutation.boardIds.add(input.boardId);
      mutation.initiativeIds.add(initiativeId);
      return this.requireInitiative(initiativeId);
    });
  }

  private requireInitiative(initiativeId: string): Initiative {
    const initiative = this.store.getInitiative(initiativeId);
    if (!initiative) {
      throw new TicketsError("not_found", `Initiative ${initiativeId} not found`);
    }
    return initiative;
  }

  /** Unlinks its tickets; never deletes them. */
  deleteInitiative(initiativeId: string): void {
    this.commit((db, mutation) => {
      const row = requireRow(db, "initiatives", initiativeId);
      const ticketIds = db
        .prepare("SELECT id FROM tickets WHERE initiative_id = ?")
        .all(initiativeId)
        .map((ticket) => text(ticket, "id"));
      db.prepare("UPDATE tickets SET initiative_id = NULL WHERE initiative_id = ?").run(
        initiativeId,
      );
      for (const ticketId of ticketIds) {
        insertEvent(db, ticketId, SYSTEM_ACTOR, {
          eventType: "initiative_changed",
          from: text(row, "title"),
        });
        mutation.ticketIds.add(ticketId);
      }
      db.prepare("DELETE FROM initiatives WHERE id = ?").run(initiativeId);
      mutation.boardIds.add(text(row, "board_id"));
      mutation.initiativeIds.add(initiativeId);
    });
  }

  // ---- runs

  /**
   * Idempotent run projection. Writes run_linked for a new run and run_state
   * for a bucket change; a report older than the stored one changes nothing.
   */
  upsertRun(input: UpsertRunInput): UpsertRunResult {
    return this.commit((db, mutation) => {
      requireRow(db, "tickets", input.ticketId);
      const existing = db
        .prepare("SELECT * FROM runs WHERE ticket_id = ? AND agent_id = ?")
        .get(input.ticketId, input.agentId);
      const previousBucket = existing ? TicketRunBucketSchema.parse(existing.bucket) : null;
      if (existing && !isRunReportNews(existing, input)) {
        return { ticket: this.requireSummary(input.ticketId), previousBucket, changed: false };
      }
      writeRun(db, input, previousBucket);
      this.touchTicket(db, mutation, input.ticketId);
      return { ticket: this.requireSummary(input.ticketId), previousBucket, changed: true };
    });
  }
}
