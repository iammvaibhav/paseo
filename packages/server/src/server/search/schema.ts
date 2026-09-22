export const TRANSCRIPT_INDEX_SCHEMA_VERSION = "1";

export const TRANSCRIPT_INDEX_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_index (
  agent_id TEXT PRIMARY KEY,
  source_path TEXT,
  source_mtime_ms INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  role TEXT,
  ts INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_agent ON chunk(agent_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text,
  content='chunk',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
`;
