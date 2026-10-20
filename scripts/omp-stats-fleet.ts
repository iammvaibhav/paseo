// omp-stats-fleet.ts — the collector behind scripts/omp-stats-fleet.sh. Bun-only.
//
// Keeps ~/.omp/profiles/<profile>/stats.db as a merged mirror of every host's
// ~/.omp/stats.db and serves the stock `omp stats` dashboard on it. Each refresh
// moves only what changed since the last one: the mirror records a hash per
// chunk of source ids, each host returns the rows of the chunks whose hash no
// longer matches (see omp-stats-fleet-export.mjs), and the collector replaces
// exactly those chunks. A full copy happens only the first time, or when the
// mirror and its bookkeeping disagree.
//
// Mirror layout, so a chunk can be replaced with two indexed statements:
//   id           = slot * HOST_ID_SPAN + source id   (slot is per host, from 1)
//   session_file = "<label>!" + source session_file  (unique keys and joins stay per host)
//   folder       = "<label> · " + source folder      (the dashboard's Folder view = per host)

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { FLEET_TABLES } from "./omp-stats-fleet-export.mjs";

export const CHUNK_SIZE = 2048;
// Source ids stay far below 2^40; slots start at 1 so ids written by the old
// full-copy merge (small AUTOINCREMENT values) never fall inside a host's range.
export const HOST_ID_SPAN = 2 ** 40;

const EXPORT_SOURCE_PATH = path.join(import.meta.dir, "omp-stats-fleet-export.mjs");
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"';

export interface FleetHost {
  /** ssh destination, or "local" for this machine. */
  name: string;
  /** Prefix written into session_file/folder; "local" is "local-mac" for continuity. */
  label: string;
}

export interface SyncRequest {
  chunkSize: number;
  known: Record<string, Record<string, string>>;
}

export interface ApplyResult {
  changedChunks: number;
  totalChunks: number;
  full: boolean;
}

function log(message: string): void {
  process.stderr.write(`\u001B[2m[fleet]\u001B[0m ${message}\n`);
}

function die(message: string): never {
  process.stderr.write(`\u001B[31m[fleet] ${message}\u001B[0m\n`);
  process.exit(1);
}

export function toFleetHost(name: string): FleetHost {
  return { name, label: name === "local" ? "local-mac" : name };
}

export function ensureSyncTables(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS fleet_sync_host (host TEXT PRIMARY KEY, slot INTEGER NOT NULL UNIQUE, synced_at INTEGER)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS fleet_sync_chunk (host TEXT NOT NULL, tbl TEXT NOT NULL, chunk INTEGER NOT NULL, " +
      "hash TEXT NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY (host, tbl, chunk)) WITHOUT ROWID",
  );
}

function hostSlot(db: Database, label: string): number {
  const existing = db
    .query<{ slot: number }, [string]>("SELECT slot FROM fleet_sync_host WHERE host = ?")
    .get(label);
  if (existing) {
    return existing.slot;
  }
  const next = db
    .query<{ slot: number }, []>("SELECT coalesce(max(slot), 0) + 1 AS slot FROM fleet_sync_host")
    .get();
  const slot = next?.slot ?? 1;
  db.query("INSERT INTO fleet_sync_host (host, slot, synced_at) VALUES (?, ?, NULL)").run(
    label,
    slot,
  );
  return slot;
}

/**
 * The chunk hashes to send a host. Empty (a full copy) when the mirror's row
 * count for the host no longer matches the bookkeeping, e.g. a newer omp ran a
 * migration on the mirror profile and wiped or rewrote rows.
 */
export function buildSyncRequest(db: Database, host: FleetHost): SyncRequest {
  ensureSyncTables(db);
  const slot = hostSlot(db, host.label);
  const known: Record<string, Record<string, string>> = {};
  let consistent = true;
  for (const table of FLEET_TABLES) {
    const chunks = db
      .query<{ chunk: number; hash: string; rows: number }, [string, string]>(
        "SELECT chunk, hash, rows FROM fleet_sync_chunk WHERE host = ? AND tbl = ?",
      )
      .all(host.label, table);
    const expected = chunks.reduce((sum, chunk) => sum + chunk.rows, 0);
    const actual = db
      .query<{ n: number }, [number, number]>(
        `SELECT count(*) AS n FROM "${table}" WHERE id >= ? AND id < ?`,
      )
      .get(slot * HOST_ID_SPAN, (slot + 1) * HOST_ID_SPAN);
    if ((actual?.n ?? 0) !== expected) {
      consistent = false;
    }
    known[table] = Object.fromEntries(chunks.map((chunk) => [String(chunk.chunk), chunk.hash]));
  }
  if (!consistent) {
    db.query("DELETE FROM fleet_sync_chunk WHERE host = ?").run(host.label);
    return { chunkSize: CHUNK_SIZE, known: {} };
  }
  return { chunkSize: CHUNK_SIZE, known };
}

function columnsOf(db: Database, schema: string, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA ${schema}.table_info("${table}")`)
    .all()
    .map((row) => row.name);
}

/**
 * Replaces the host's changed chunks in the mirror with the rows in `delta`
 * (the gunzipped database exportStatsDelta built against `request`), in one
 * transaction: a failed apply leaves the previous mirror intact.
 */
export function applySyncDelta(
  db: Database,
  host: FleetHost,
  request: SyncRequest,
  deltaPath: string,
): ApplyResult {
  ensureSyncTables(db);
  const slot = hostSlot(db, host.label);
  const base = slot * HOST_ID_SPAN;
  // No bookkeeping (first refresh, or reset after a mismatch) means a full copy.
  const full = Object.values(request.known).every((chunks) => Object.keys(chunks).length === 0);
  db.query("ATTACH DATABASE ? AS delta").run(deltaPath);
  try {
    const current = db
      .query<{ tbl: string; chunk: number; hash: string; rows: number }, []>(
        "SELECT tbl, chunk, hash, rows FROM delta.fleet_chunks",
      )
      .all();
    let changedChunks = 0;
    db.transaction(() => {
      for (const table of FLEET_TABLES) {
        const known = request.known[table] ?? {};
        const live = current.filter((chunk) => chunk.tbl === table);
        const changed = live.filter((chunk) => known[String(chunk.chunk)] !== chunk.hash);
        changedChunks += changed.length;
        if (full) {
          // Also clears rows the old full-copy merge wrote outside any slot range.
          db.query(`DELETE FROM "${table}" WHERE id >= ? AND id < ?`).run(
            base,
            base + HOST_ID_SPAN,
          );
          db.query(`DELETE FROM "${table}" WHERE session_file >= ? AND session_file < ?`).run(
            `${host.label}!`,
            `${host.label}"`,
          );
        } else {
          const liveChunks = new Set(live.map((chunk) => String(chunk.chunk)));
          const dropped = Object.keys(known)
            .filter((chunk) => !liveChunks.has(chunk))
            .map(Number);
          const remove = db.query(`DELETE FROM "${table}" WHERE id >= ? AND id < ?`);
          for (const chunk of [...changed.map((c) => c.chunk), ...dropped]) {
            remove.run(base + chunk * request.chunkSize, base + (chunk + 1) * request.chunkSize);
          }
        }

        const deltaColumns = new Set(columnsOf(db, "delta", table));
        const columns = columnsOf(db, "main", table).filter((name) => deltaColumns.has(name));
        if (columns.length > 0 && deltaColumns.has("id")) {
          const select = columns.map((name) => {
            if (name === "id") return "?1 + id";
            if (name === "session_file") return "?2 || session_file";
            if (name === "folder") return "?3 || folder";
            return `"${name}"`;
          });
          db.query(
            `INSERT OR REPLACE INTO main."${table}" (${columns.map((n) => `"${n}"`).join(", ")}) ` +
              `SELECT ${select.join(", ")} FROM delta."${table}"`,
          ).run(base, `${host.label}!`, `${host.label} · `);
        }
      }
      db.query("DELETE FROM fleet_sync_chunk WHERE host = ?").run(host.label);
      const record = db.query(
        "INSERT INTO fleet_sync_chunk (host, tbl, chunk, hash, rows) VALUES (?, ?, ?, ?, ?)",
      );
      for (const chunk of current) {
        record.run(host.label, chunk.tbl, chunk.chunk, chunk.hash, chunk.rows);
      }
      db.query("UPDATE fleet_sync_host SET synced_at = ? WHERE host = ?").run(
        Date.now(),
        host.label,
      );
    })();
    return { changedChunks, totalChunks: current.length, full };
  } finally {
    db.run("DETACH DATABASE delta");
  }
}

/** Runs the exporter on `host` and resolves with the gzipped delta it prints. */
async function fetchDelta(
  host: FleetHost,
  request: SyncRequest,
  doSync: boolean,
): Promise<Uint8Array> {
  const program =
    `${readFileSync(EXPORT_SOURCE_PATH, "utf8")}\n` +
    `const delta = exportStatsDelta({ ...${JSON.stringify(request)}, dbPath: process.env.HOME + "/.omp/stats.db" });\n` +
    "await Bun.write(Bun.stdout, delta);\n";
  const sync = doSync
    ? 'omp stats --summary >/dev/null 2>&1 || echo "[fleet] omp stats sync warned" >&2; '
    : "";
  const command =
    host.name === "local"
      ? ["bash", "-c", `${REMOTE_PATH}; ${sync}exec bun run -`]
      : [
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=5",
          "-o",
          "ServerAliveCountMax=3",
          host.name,
          `${REMOTE_PATH}; ${sync}exec bun run -`,
        ];
  const child = Bun.spawn(command, { stdin: new Blob([program]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    const reason = stderr.trim().split("\n").findLast(Boolean) ?? `exit ${code}`;
    throw new Error(reason);
  }
  return stdout;
}

interface HostReport {
  syncedAt: string | null;
  error?: string;
}

interface SyncMarker {
  asOf: string | null;
  hosts: Record<string, HostReport>;
}

function readMarker(markerPath: string): SyncMarker {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8")) as SyncMarker;
  } catch {
    return { asOf: null, hosts: {} };
  }
}

/** Refreshes the mirror from every host in parallel. Returns the hosts that failed. */
export async function refreshMirror(input: {
  mergedDbPath: string;
  markerPath: string;
  hosts: FleetHost[];
  doSync: boolean;
}): Promise<string[]> {
  const db = new Database(input.mergedDbPath);
  db.run("PRAGMA busy_timeout = 10000");
  const work = mkdtempSync(path.join(tmpdir(), "omp-fleet-"));
  const marker = readMarker(input.markerPath);
  const failed: string[] = [];
  // Exports run concurrently; applies share one connection, so they queue.
  let applyQueue = Promise.resolve();
  try {
    await Promise.all(
      input.hosts.map(async (host) => {
        const started = performance.now();
        const request = buildSyncRequest(db, host);
        try {
          const gz = await fetchDelta(host, request, input.doSync);
          const fetchedMs = performance.now() - started;
          const deltaPath = path.join(work, `${host.label}.db`);
          writeFileSync(deltaPath, Bun.gunzipSync(gz));
          const applied = applyQueue.then(() => applySyncDelta(db, host, request, deltaPath));
          applyQueue = applied.then(
            () => undefined,
            () => undefined,
          );
          const result = await applied;
          rmSync(deltaPath, { force: true });
          marker.hosts[host.label] = { syncedAt: new Date().toISOString() };
          log(
            `${host.label}: ${result.full ? "full copy, " : ""}${result.changedChunks}/${result.totalChunks} chunks, ` +
              `${(gz.byteLength / 1e6).toFixed(2)} MB, fetch ${(fetchedMs / 1000).toFixed(1)}s, ` +
              `total ${((performance.now() - started) / 1000).toFixed(1)}s`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push(host.label);
          marker.hosts[host.label] = {
            syncedAt: marker.hosts[host.label]?.syncedAt ?? null,
            error: message,
          };
          log(
            `${host.label}: kept data from ${marker.hosts[host.label].syncedAt ?? "never"} (${message})`,
          );
        }
      }),
    );
    if (failed.length < input.hosts.length) {
      marker.asOf = new Date().toISOString();
    }
    writeFileSync(input.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    logMirrorSummary(db);
  } finally {
    db.close();
    rmSync(work, { recursive: true, force: true });
  }
  return failed;
}

function logMirrorSummary(db: Database): void {
  const hosts = db
    .query<{ host: string; slot: number }, []>(
      "SELECT host, slot FROM fleet_sync_host ORDER BY slot",
    )
    .all();
  const totals = db.query<{ n: number; cost: number }, [number, number]>(
    "SELECT count(*) AS n, coalesce(sum(cost_total), 0) AS cost FROM messages WHERE id >= ? AND id < ?",
  );
  for (const host of hosts) {
    const row = totals.get(host.slot * HOST_ID_SPAN, (host.slot + 1) * HOST_ID_SPAN);
    log(`  ${host.host}: ${row?.n ?? 0} requests, $${(row?.cost ?? 0).toFixed(2)}`);
  }
}

function hasSchema(mergedDbPath: string): boolean {
  try {
    const db = new Database(mergedDbPath, { readonly: true });
    try {
      return db.query("SELECT 1 FROM sqlite_master WHERE name = 'messages'").get() !== null;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function runOmp(args: string[], profile: string, inherit: boolean): Promise<number> {
  const child = Bun.spawn(["omp", ...args], {
    env: { ...process.env, OMP_PROFILE: profile },
    stdin: "ignore",
    stdout: inherit ? "inherit" : "ignore",
    stderr: inherit ? "inherit" : "ignore",
  });
  return child.exited;
}

const USAGE = `Usage: scripts/omp-stats-fleet.sh [--merge-only | --serve | --summary | --json] [--no-sync]
  (default)     refresh the merged DB, then serve the dashboard
  --merge-only  refresh the merged DB and exit (exit 3: some hosts failed and kept old data)
  --serve       serve the merged DB as it is, without refreshing
  --summary     refresh, then print omp's text summary
  --json        refresh, then print omp's JSON summary
  --no-sync     skip each host's 'omp stats' session sync before export
Env: OMP_FLEET_HOSTS="local blrofc3 iammvaibhav"  OMP_FLEET_PROFILE=fleet  OMP_FLEET_PORT=3848`;

type Mode = "dashboard" | "merge-only" | "serve" | "summary" | "json";

const MODE_BY_FLAG: Record<string, Mode> = {
  "--merge-only": "merge-only",
  "--serve": "serve",
  "--summary": "summary",
  "--json": "json",
};

/**
 * Stock omp creates the mirror so its schema matches the installed omp and
 * every backfill key is marked complete (an unmarked key wipes imported rows).
 */
async function ensureMirrorSchema(profileRoot: string, mergedDbPath: string, profile: string) {
  if (hasSchema(mergedDbPath)) {
    return;
  }
  mkdirSync(profileRoot, { recursive: true });
  log(`initializing profile schema: ${mergedDbPath}`);
  await runOmp(["stats", "--summary"], profile, false);
  if (!hasSchema(mergedDbPath)) {
    die(`omp did not create ${mergedDbPath}`);
  }
}

async function main(): Promise<void> {
  let mode: Mode = "dashboard";
  let doSync = true;
  for (const arg of process.argv.slice(2)) {
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return;
    }
    if (arg === "--no-sync") {
      doSync = false;
    } else if (MODE_BY_FLAG[arg]) {
      mode = MODE_BY_FLAG[arg];
    } else {
      console.error(`unknown flag: ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }

  const hosts = (process.env.OMP_FLEET_HOSTS ?? "local blrofc3 iammvaibhav")
    .split(/\s+/)
    .filter(Boolean)
    .map(toFleetHost);
  const profile = process.env.OMP_FLEET_PROFILE ?? "fleet";
  const port = process.env.OMP_FLEET_PORT ?? "3848";
  const configRoot = path.join(homedir(), ".omp");
  const profileRoot = path.join(configRoot, "profiles", profile);
  const mergedDbPath = path.join(profileRoot, "stats.db");
  const markerPath = path.join(profileRoot, "fleet-sync.json");
  if (mergedDbPath === path.join(configRoot, "stats.db")) {
    die("refusing to target the real stats.db");
  }

  if (mode === "serve") {
    if (!hasSchema(mergedDbPath)) {
      die(`no merged DB at ${mergedDbPath}; run without --serve first`);
    }
  } else {
    await ensureMirrorSchema(profileRoot, mergedDbPath, profile);
    log(`hosts: ${hosts.map((host) => host.name).join(" ")} (sync=${doSync ? 1 : 0})`);
    const failed = await refreshMirror({ mergedDbPath, markerPath, hosts, doSync });
    if (failed.length === hosts.length) {
      die("every host failed");
    }
    if (mode === "merge-only") {
      process.exit(failed.length > 0 ? 3 : 0);
    }
  }

  if (mode === "summary" || mode === "json") {
    process.exit(await runOmp(["stats", `--${mode}`], profile, true));
  }
  log(`dashboard: http://127.0.0.1:${port} (Ctrl-C to stop)`);
  process.exit(await runOmp(["stats", "-p", port], profile, true));
}

if (import.meta.main) {
  await main();
}
