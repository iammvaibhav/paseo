import { mkdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { FileAgentTimelineStore } from "../agent/file-agent-timeline-store.js";
import { extractChunks } from "./extract.js";
import { toFtsQuery } from "./fts-query.js";
import { TRANSCRIPT_INDEX_DDL, TRANSCRIPT_INDEX_SCHEMA_VERSION } from "./schema.js";
import { tryLoadNodeSqlite, type SqliteDatabase } from "./sqlite.js";
import { loadTranscriptSource } from "./sources.js";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const FTS_CANDIDATE_LIMIT = 3000;

export interface TranscriptHit {
  agentId: string;
  rank: number;
  snippet: string;
}

export interface TranscriptSearchServiceOptions {
  paseoHome: string;
  agentStorage: AgentStorage;
  timelineStore: FileAgentTimelineStore;
  logger: Logger;
}

/**
 * Daemon-owned FTS5 index of agent transcripts. Missing sqlite, a corrupt
 * file, or an FTS5-less build all degrade to "no transcript hits" — History
 * still ranks titles the way it does today.
 */
export class TranscriptSearchService {
  private db: SqliteDatabase;
  private readonly agentStorage: AgentStorage;
  private readonly timelineStore: FileAgentTimelineStore;
  private readonly logger: Logger;
  private readonly pending = new Set<string>();
  private draining = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private constructor(
    db: SqliteDatabase,
    options: Omit<TranscriptSearchServiceOptions, "paseoHome">,
  ) {
    this.db = db;
    this.agentStorage = options.agentStorage;
    this.timelineStore = options.timelineStore;
    this.logger = options.logger;
  }

  static async tryCreate(
    options: TranscriptSearchServiceOptions,
  ): Promise<TranscriptSearchService | null> {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      options.logger.info("node:sqlite unavailable; History search stays metadata-only");
      return null;
    }

    const directory = path.join(options.paseoHome, "search");
    await mkdir(directory, { recursive: true });
    const dbPath = path.join(directory, "transcripts.db");

    let db: SqliteDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(dbPath);
      ensureSchema(db);
    } catch (error) {
      options.logger.warn({ err: error, dbPath }, "Transcript index unusable; rebuilding");
      try {
        db?.close();
      } catch {
        // ignore close of a half-open handle
      }
      try {
        unlinkSync(dbPath);
      } catch {
        // ignore missing
      }
      try {
        db = new sqlite.DatabaseSync(dbPath);
        ensureSchema(db);
      } catch (rebuildError) {
        options.logger.warn(
          { err: rebuildError },
          "Failed to open transcript index; History search stays metadata-only",
        );
        return null;
      }
    }

    if (!db) return null;
    return new TranscriptSearchService(db, options);
  }

  start(): void {
    void this.reconcile().catch((error) => {
      this.logger.warn({ err: error }, "Transcript index boot reconcile failed");
    });
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => {
        this.logger.warn({ err: error }, "Transcript index sweep failed");
      });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  scheduleReindex(agentId: string): void {
    if (this.stopped) return;
    this.pending.add(agentId);
    void this.drain();
  }

  search(query: string): TranscriptHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT chunk.agent_id AS agent_id,
                  bm25(chunk_fts) AS rank,
                  snippet(chunk_fts, 0, '', '', '…', 16) AS snippet
           FROM chunk_fts
           JOIN chunk ON chunk.id = chunk_fts.rowid
           WHERE chunk_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(match, FTS_CANDIDATE_LIMIT);
      const hits = new Map<string, TranscriptHit>();
      for (const row of rows) {
        const agentId = typeof row.agent_id === "string" ? row.agent_id : "";
        if (!agentId || hits.has(agentId)) continue;
        const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
        const snippet =
          typeof row.snippet === "string" ? row.snippet.replace(/\s+/g, " ").trim() : "";
        hits.set(agentId, {
          agentId,
          rank: Number.isFinite(rank) ? rank : 0,
          snippet,
        });
      }
      return [...hits.values()];
    } catch (error) {
      this.logger.debug({ err: error, query }, "Transcript FTS query failed");
      return [];
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.pending.size > 0 && !this.stopped) {
        const agentId = this.pending.values().next().value as string;
        this.pending.delete(agentId);
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          this.deleteAgent(agentId);
          continue;
        }
        await this.indexAgent(record, { force: true });
      }
    } finally {
      this.draining = false;
    }
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const records = await this.agentStorage.list();
    const live = new Set(records.map((record) => record.id));
    for (const record of records) {
      if (this.stopped) return;
      await this.indexAgent(record, { force: false });
    }
    this.pruneMissing(live);
  }

  private async indexAgent(
    record: Awaited<ReturnType<AgentStorage["get"]>> & object,
    options: { force: boolean },
  ): Promise<void> {
    if (!record) return;
    const source = await loadTranscriptSource(record, {
      timelineStore: this.timelineStore,
      logger: this.logger,
    });
    const mtimeMs = source?.mtimeMs ?? Date.parse(record.updatedAt) ?? 0;
    if (!options.force) {
      const previous = this.db
        .prepare("SELECT source_mtime_ms FROM agent_index WHERE agent_id = ?")
        .get(record.id);
      const previousMtime =
        typeof previous?.source_mtime_ms === "number"
          ? previous.source_mtime_ms
          : Number(previous?.source_mtime_ms);
      if (Number.isFinite(previousMtime) && previousMtime === mtimeMs) {
        return;
      }
    }

    const chunks = source ? extractChunks(source.entries) : [];
    this.replaceAgentChunks(record.id, chunks, source?.path ?? null, mtimeMs);
  }

  private replaceAgentChunks(
    agentId: string,
    chunks: ReturnType<typeof extractChunks>,
    sourcePath: string | null,
    mtimeMs: number,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chunk WHERE agent_id = ?").run(agentId);
      const insert = this.db.prepare(
        "INSERT INTO chunk (agent_id, ord, role, ts, text) VALUES (?, ?, ?, ?, ?)",
      );
      for (let ord = 0; ord < chunks.length; ord += 1) {
        const chunk = chunks[ord]!;
        insert.run(agentId, ord, chunk.role, chunk.ts, chunk.text);
      }
      this.db
        .prepare(
          `INSERT INTO agent_index (agent_id, source_path, source_mtime_ms, chunk_count, indexed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             source_path = excluded.source_path,
             source_mtime_ms = excluded.source_mtime_ms,
             chunk_count = excluded.chunk_count,
             indexed_at = excluded.indexed_at`,
        )
        .run(agentId, sourcePath, mtimeMs, chunks.length, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteAgent(agentId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chunk WHERE agent_id = ?").run(agentId);
      this.db.prepare("DELETE FROM agent_index WHERE agent_id = ?").run(agentId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.logger.debug({ err: error, agentId }, "Failed to drop agent from transcript index");
    }
  }

  private pruneMissing(live: ReadonlySet<string>): void {
    const indexed = this.db.prepare("SELECT agent_id FROM agent_index").all();
    for (const row of indexed) {
      const agentId = typeof row.agent_id === "string" ? row.agent_id : "";
      if (agentId && !live.has(agentId)) {
        this.deleteAgent(agentId);
      }
    }
  }
}

function ensureSchema(db: SqliteDatabase): void {
  db.exec(TRANSCRIPT_INDEX_DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = typeof row?.value === "string" ? row.value : null;
  if (version === TRANSCRIPT_INDEX_SCHEMA_VERSION) return;
  if (version !== null) {
    throw new Error(`transcript index schema ${version} != ${TRANSCRIPT_INDEX_SCHEMA_VERSION}`);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
    TRANSCRIPT_INDEX_SCHEMA_VERSION,
  );
}

export async function createTranscriptSearchService(
  options: TranscriptSearchServiceOptions,
): Promise<TranscriptSearchService | null> {
  return TranscriptSearchService.tryCreate(options);
}
