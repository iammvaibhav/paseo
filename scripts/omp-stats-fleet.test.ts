// Run with: bun test scripts/omp-stats-fleet.test.ts (bun:sqlite, so not vitest).
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { exportStatsDelta } from "./omp-stats-fleet-export.mjs";
import {
  CHUNK_SIZE,
  HOST_ID_SPAN,
  applySyncDelta,
  buildSyncRequest,
  toFleetHost,
  type FleetHost,
} from "./omp-stats-fleet.ts";

// The columns the collector special-cases plus one mutable column per table,
// mirroring omp's real in-place UPDATEs (cost reprice, tool result, user model).
const SCHEMA = `
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL,
    entry_id TEXT NOT NULL, folder TEXT NOT NULL, timestamp INTEGER NOT NULL, cost_total REAL NOT NULL,
    UNIQUE(session_file, entry_id));
  CREATE TABLE user_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL,
    entry_id TEXT NOT NULL, folder TEXT NOT NULL, timestamp INTEGER NOT NULL, model TEXT,
    UNIQUE(session_file, entry_id));
  CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL,
    entry_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, folder TEXT NOT NULL, timestamp INTEGER NOT NULL,
    result_chars INTEGER, UNIQUE(session_file, tool_call_id));
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-fleet-test-"));
  dirs.push(dir);
  const open = (name: string) => {
    const db = new Database(path.join(dir, name));
    db.run(SCHEMA);
    return db;
  };
  return { dir, mirror: open("mirror.db"), open };
}

function addSession(db: Database, session: string, count: number, startTs = 1_000): void {
  const message = db.query(
    "INSERT INTO messages (session_file, entry_id, folder, timestamp, cost_total) VALUES (?, ?, '/work', ?, ?)",
  );
  const user = db.query(
    "INSERT INTO user_messages (session_file, entry_id, folder, timestamp, model) VALUES (?, ?, '/work', ?, NULL)",
  );
  const tool = db.query(
    "INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, timestamp, result_chars) VALUES (?, ?, ?, '/work', ?, NULL)",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      message.run(session, `e${i}`, startTs + i, i / 100);
      user.run(session, `e${i}`, startTs + i);
      tool.run(session, `e${i}`, `t${i}`, startTs + i);
    }
  })();
}

function sync(dir: string, mirror: Database, source: Database, host: FleetHost) {
  const request = buildSyncRequest(mirror, host);
  const gz = exportStatsDelta({ ...request, dbPath: source.filename });
  const deltaPath = path.join(dir, `${host.label}-delta.db`);
  writeFileSync(deltaPath, Bun.gunzipSync(gz));
  const result = applySyncDelta(mirror, host, request, deltaPath);
  rmSync(deltaPath);
  return { ...result, bytes: gz.byteLength };
}

/** The host's mirrored rows with the mirror's id/prefix layout undone. */
function mirroredRows(mirror: Database, host: FleetHost, table: string): unknown[] {
  const slot = mirror
    .query<{ slot: number }, [string]>("SELECT slot FROM fleet_sync_host WHERE host = ?")
    .get(host.label);
  const base = (slot?.slot ?? 0) * HOST_ID_SPAN;
  return mirror
    .query<Record<string, unknown>, [number, number]>(
      `SELECT * FROM ${table} WHERE id >= ? AND id < ? ORDER BY id`,
    )
    .all(base, base + HOST_ID_SPAN)
    .map((row) =>
      Object.assign(row, {
        id: Number(row.id) - base,
        session_file: String(row.session_file).slice(`${host.label}!`.length),
        folder: String(row.folder).slice(`${host.label} · `.length),
      }),
    );
}

function expectMirrorsSource(mirror: Database, source: Database, host: FleetHost): void {
  for (const table of ["messages", "user_messages", "tool_calls"]) {
    expect(mirroredRows(mirror, host, table)).toEqual(
      source.query(`SELECT * FROM ${table} ORDER BY id`).all(),
    );
  }
}

test("first refresh copies every row; an unchanged host then sends no rows", () => {
  const { dir, mirror, open } = workspace();
  const source = open("blrofc3.db");
  addSession(source, "/s/a.jsonl", CHUNK_SIZE * 2 + 10);
  const host = toFleetHost("blrofc3");

  const first = sync(dir, mirror, source, host);
  expect(first.full).toBe(true);
  expectMirrorsSource(mirror, source, host);
  expect(mirror.query("SELECT session_file, folder FROM messages LIMIT 1").get()).toEqual({
    session_file: "blrofc3!/s/a.jsonl",
    folder: "blrofc3 · /work",
  });

  const second = sync(dir, mirror, source, host);
  expect(second).toMatchObject({ full: false, changedChunks: 0 });
  expectMirrorsSource(mirror, source, host);
});

test("only changed chunks move: appends, in-place updates and deletes all land", () => {
  const { dir, mirror, open } = workspace();
  const source = open("dev.db");
  addSession(source, "/s/old.jsonl", CHUNK_SIZE * 4);
  const host = toFleetHost("iammvaibhav");
  const full = sync(dir, mirror, source, host);

  addSession(source, "/s/new.jsonl", 5, 9_000); // appends to the tail chunk
  source.run("UPDATE tool_calls SET result_chars = 42 WHERE id = 3"); // tool result arrives
  source.run("UPDATE user_messages SET model = 'gpt' WHERE id = ?", [CHUNK_SIZE + 1]); // model linked
  source.run("DELETE FROM messages WHERE id = ?", [CHUNK_SIZE * 2 + 7]); // fork dedupe

  const delta = sync(dir, mirror, source, host);
  expect(delta.full).toBe(false);
  // tool_calls: chunk 0 + tail; user_messages: chunk 1 + tail; messages: chunk 2 + tail.
  expect(delta.changedChunks).toBe(6);
  expect(delta.bytes).toBeLessThan(full.bytes / 2);
  expectMirrorsSource(mirror, source, host);
});

test("a chunk whose rows were all deleted is removed from the mirror", () => {
  const { dir, mirror, open } = workspace();
  const source = open("mac.db");
  addSession(source, "/s/a.jsonl", CHUNK_SIZE * 2);
  const host = toFleetHost("local");
  sync(dir, mirror, source, host);

  source.run("DELETE FROM messages WHERE id > ?", [CHUNK_SIZE]);
  sync(dir, mirror, source, host);
  expectMirrorsSource(mirror, source, host);
});

test("a mirror that lost rows behind the collector's back gets a full copy", () => {
  const { dir, mirror, open } = workspace();
  const source = open("blrofc3.db");
  addSession(source, "/s/a.jsonl", 100);
  const host = toFleetHost("blrofc3");
  sync(dir, mirror, source, host);

  // A newer omp's migration on the mirror profile wipes tool_calls.
  mirror.run("DELETE FROM tool_calls");
  const repaired = sync(dir, mirror, source, host);
  expect(repaired.full).toBe(true);
  expectMirrorsSource(mirror, source, host);
});

test("rows from the old full-copy merge are replaced, and other hosts are untouched", () => {
  const { dir, mirror, open } = workspace();
  // What the previous script left: small AUTOINCREMENT ids, same prefixes, and a
  // row the host no longer has (so only the prefix cleanup can remove it).
  mirror.run(
    "INSERT INTO messages (session_file, entry_id, folder, timestamp, cost_total) VALUES ('blrofc3!/s/gone.jsonl', 'e0', 'blrofc3 · /work', 1, 1)",
  );
  const work = open("blrofc3.db");
  const mac = open("mac.db");
  addSession(work, "/s/a.jsonl", 10);
  addSession(mac, "/s/a.jsonl", 20);
  const workHost = toFleetHost("blrofc3");
  const macHost = toFleetHost("local");

  sync(dir, mirror, mac, macHost);
  sync(dir, mirror, work, workHost);
  expectMirrorsSource(mirror, work, workHost);
  expectMirrorsSource(mirror, mac, macHost);
  expect(mirror.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 30 });

  work.run("DELETE FROM messages");
  sync(dir, mirror, work, workHost);
  expectMirrorsSource(mirror, mac, macHost);
  expect(mirroredRows(mirror, workHost, "messages")).toEqual([]);
});
