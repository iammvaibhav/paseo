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
  private readonly memory = new Set<string>();

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
      this.memory.add(key);
      return true;
    }
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO automation_event_claims (automation_id, event_key, created_at) VALUES (?, ?, ?)",
      )
      .run(automationId, eventKey, nowMs);
    return Number(result.changes) === 1;
  }

  dropAutomation(automationId: string): void {
    if (!this.db) {
      const prefix = `${automationId}:`;
      const doomed: string[] = [];
      for (const key of this.memory) {
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
