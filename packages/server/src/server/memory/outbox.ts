import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { createHash } from "node:crypto";
import { tryLoadNodeSqlite, type SqliteDatabase } from "../search/sqlite.js";
import type { MemoryItem, MemoryNoteInput } from "./types.js";

const BATCH = 200;
const FLUSH_INTERVAL_MS = 15_000;
const BASE_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60_000;

const DDL = `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sent (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface OutboxTransport {
  ingest(items: MemoryItem[]): Promise<void>;
  writeNote(note: MemoryNoteInput): Promise<unknown>;
}

function hashOf(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

/**
 * Durable queue of writes to fleet-memory (~/.paseo/memory/outbox.db). Every write
 * goes through here, so nothing is lost while the memory host is asleep or
 * unreachable: a failed flush backs off (15 s doubling to 10 min) and retries,
 * across daemon restarts. An item identical to one already delivered is dropped
 * at enqueue, which keeps re-indexing cheap.
 */
export class MemoryOutbox {
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs = 0;
  private blockedUntil = 0;

  private constructor(
    private readonly db: SqliteDatabase,
    private readonly transport: () => OutboxTransport | null,
    private readonly logger: Logger,
  ) {}

  static async open(input: {
    paseoHome: string;
    transport: () => OutboxTransport | null;
    logger: Logger;
  }): Promise<MemoryOutbox | null> {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) return null;
    const dir = path.join(input.paseoHome, "memory");
    await mkdir(dir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(dir, "outbox.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(DDL);
    return new MemoryOutbox(db, input.transport, input.logger.child({ module: "memory-outbox" }));
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
    void this.flush();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Queue documents; unchanged ones already delivered are skipped. Returns how many were queued. */
  enqueueItems(items: readonly MemoryItem[]): number {
    let queued = 0;
    const sentStmt = this.db.prepare("SELECT hash FROM sent WHERE id = ?");
    const put = this.db.prepare(
      `INSERT INTO outbox (id, kind, payload, hash, attempts, next_attempt_at) VALUES (?, 'item', ?, ?, 0, 0)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, hash = excluded.hash`,
    );
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const hash = hashOf(item);
        if (sentStmt.get(item.id)?.hash === hash) continue;
        put.run(item.id, JSON.stringify(item), hash);
        queued += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (queued > 0) void this.flush();
    return queued;
  }

  enqueueNote(note: MemoryNoteInput): void {
    const id = `note-write:${Date.now()}:${hashOf(note).slice(0, 12)}`;
    this.db
      .prepare("INSERT INTO outbox (id, kind, payload, hash) VALUES (?, 'note', ?, ?)")
      .run(id, JSON.stringify(note), hashOf(note));
    void this.flush();
  }

  pendingCount(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n ?? 0);
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key);
    return typeof row?.value === "string" ? row.value : null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Retry now, skipping any backoff (e.g. the memory host came back or its URL changed). */
  retryNow(): Promise<void> {
    this.blockedUntil = 0;
    return this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || Date.now() < this.blockedUntil) return;
    const transport = this.transport();
    if (!transport) return;
    this.flushing = true;
    try {
      for (;;) {
        const rows = this.db
          .prepare(
            "SELECT id, kind, payload, hash FROM outbox WHERE next_attempt_at <= ? ORDER BY kind DESC, rowid LIMIT ?",
          )
          .all(Date.now(), BATCH);
        if (rows.length === 0) break;
        const notes = rows.filter((row) => row.kind === "note");
        const items = rows.filter((row) => row.kind === "item");
        for (const row of notes) {
          await transport.writeNote(JSON.parse(String(row.payload)) as MemoryNoteInput);
          this.db.prepare("DELETE FROM outbox WHERE id = ?").run(row.id);
        }
        if (items.length > 0) {
          await transport.ingest(items.map((row) => JSON.parse(String(row.payload)) as MemoryItem));
          this.markDelivered(items);
        }
        this.backoffMs = 0;
      }
    } catch (error) {
      this.backoffMs = Math.min(
        this.backoffMs ? this.backoffMs * 2 : BASE_BACKOFF_MS,
        MAX_BACKOFF_MS,
      );
      this.blockedUntil = Date.now() + this.backoffMs;
      this.logger.warn(
        { err: error, retryInMs: this.backoffMs, pending: this.pendingCount() },
        "memory.outbox.flush_failed",
      );
    } finally {
      this.flushing = false;
    }
  }

  private markDelivered(rows: ReadonlyArray<Record<string, unknown>>): void {
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        this.db.prepare("DELETE FROM outbox WHERE id = ? AND hash = ?").run(row.id, row.hash);
        this.db
          .prepare(
            "INSERT INTO sent (id, hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash",
          )
          .run(row.id, row.hash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
