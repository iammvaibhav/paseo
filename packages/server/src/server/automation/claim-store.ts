import { tryLoadNodeSqlite, type SqliteDatabase } from "../search/sqlite.js";

// Exactly-once claims for poll-automation events (MonoCode's
// automation_event_claims, automations.rs). INSERT OR IGNORE is the claim;
// 0 changed rows means another poll already fired this event.
const CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS automation_event_claims (
  automation_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (automation_id, event_key)
);`;

export class AutomationClaimStore {
  private readonly db: SqliteDatabase | null;
  private readonly memory = new Map<string, number>();
  private static readonly MAX_CLAIMS = 10_000;

  private constructor(db: SqliteDatabase | null) {
    this.db = db;
  }

  static async open(options: {
    dbPath: string;
    execMkdir: (dir: string) => Promise<void>;
    dirname: (path: string) => string;
    logger: { info: (msg: string) => void; warn: (obj: unknown, msg: string) => void };
  }): Promise<AutomationClaimStore> {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      options.logger.info("node:sqlite unavailable; automation claims are in-memory only");
      return new AutomationClaimStore(null);
    }
    try {
      await options.execMkdir(options.dirname(options.dbPath));
      const db = new sqlite.DatabaseSync(options.dbPath);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      db.exec(CLAIMS_DDL);
      return new AutomationClaimStore(db);
    } catch (error) {
      options.logger.warn({ err: error }, "Automation claims DB unusable; using in-memory claims");
      return new AutomationClaimStore(null);
    }
  }

  /** True when this call claimed the event (caller must fire). */
  claim(automationId: string, eventKey: string, nowMs: number): boolean {
    if (!this.db) {
      const key = `${automationId}:${eventKey}`;
      if (this.memory.has(key)) return false;
      this.memory.set(key, nowMs);
      this.evictExcessMemory();
      return true;
    }
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO automation_event_claims (automation_id, event_key, created_at) VALUES (?, ?, ?)",
      )
      .run(automationId, eventKey, nowMs);
    return Number(result.changes) === 1;
  }

  /** Remove claims outside the exactly-once retention window and cap size. */
  pruneOlderThan(cutoffMs: number): void {
    if (!this.db) {
      for (const [key, createdAt] of this.memory) {
        if (createdAt < cutoffMs) this.memory.delete(key);
      }
      this.evictExcessMemory();
      return;
    }
    this.db.prepare("DELETE FROM automation_event_claims WHERE created_at < ?").run(cutoffMs);
    const excess = this.db
      .prepare(
        "SELECT automation_id, event_key FROM automation_event_claims " +
          "ORDER BY created_at ASC LIMIT -1 OFFSET ?",
      )
      .all(AutomationClaimStore.MAX_CLAIMS) as Array<{
      automation_id: string;
      event_key: string;
    }>;
    const remove = this.db.prepare(
      "DELETE FROM automation_event_claims WHERE automation_id = ? AND event_key = ?",
    );
    for (const row of excess) remove.run(row.automation_id, row.event_key);
  }

  private evictExcessMemory(): void {
    if (this.memory.size <= AutomationClaimStore.MAX_CLAIMS) return;
    const oldest = [...this.memory.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.memory.size - AutomationClaimStore.MAX_CLAIMS);
    for (const [key] of oldest) this.memory.delete(key);
  }

  dropAutomation(automationId: string): void {
    if (!this.db) {
      const prefix = `${automationId}:`;
      const doomed: string[] = [];
      for (const key of this.memory.keys()) {
        if (key.startsWith(prefix)) doomed.push(key);
      }
      for (const key of doomed) this.memory.delete(key);
      return;
    }
    this.db
      .prepare("DELETE FROM automation_event_claims WHERE automation_id = ?")
      .run(automationId);
  }

  get durable(): boolean {
    return this.db !== null;
  }
}
