// omp-stats-fleet-export.mjs — runs on each host (over ssh as `bun run -`, or
// locally) and returns only the parts of ~/.omp/stats.db the collector does not
// already have. Bun-only (bun:sqlite); remotes have bun because omp runs on it.
//
// Rows are grouped into fixed chunks by their source `id` (AUTOINCREMENT, so a
// row never changes chunk). The collector sends the hash it holds for every
// chunk; this side hashes every chunk of the live DB and returns the rows of
// the chunks whose hash differs, plus the full current chunk list. That one
// rule covers all the ways omp mutates the DB: new rows land in new or tail
// chunks, the in-place UPDATEs (tool result_chars, user message model, catalog
// cost reprice) change an old chunk's hash, and deletes shrink or empty one.
//
// The ssh transport appends a call to `exportStatsDelta` and writes its result
// to stdout, so this file must stay self-contained: no imports beyond bun's.

import { Database } from "bun:sqlite";

export const FLEET_TABLES = ["messages", "user_messages", "tool_calls"];

/**
 * @param {{ dbPath: string, chunkSize: number, known: Record<string, Record<string, string>> }} request
 *   `known[table][chunk]` is the hash the collector holds for that chunk.
 * @returns {Uint8Array} a gzipped SQLite database with `fleet_chunks(tbl, chunk, hash, rows)`
 *   listing every current chunk, and one table per FLEET_TABLES entry holding the rows of
 *   the chunks whose hash is not in `known`.
 */
export function exportStatsDelta(request) {
  const src = new Database(request.dbPath, { readonly: true });
  const out = new Database(":memory:");
  try {
    src.run("PRAGMA busy_timeout = 10000");
    out.run(
      "CREATE TABLE fleet_chunks (tbl TEXT NOT NULL, chunk INTEGER NOT NULL, hash TEXT NOT NULL, rows INTEGER NOT NULL)",
    );
    const insertChunk = out.prepare(
      "INSERT INTO fleet_chunks (tbl, chunk, hash, rows) VALUES (?, ?, ?, ?)",
    );
    // One read transaction: every table is hashed and copied from the same snapshot,
    // even while omp keeps writing.
    src.run("BEGIN");
    out.run("BEGIN");
    for (const table of FLEET_TABLES) {
      const columns = src
        .query(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((row) => row.name);
      if (columns.length === 0) {
        continue;
      }
      const quoted = columns.map((name) => `"${name}"`).join(", ");
      out.run(`CREATE TABLE "${table}" (${quoted})`);
      const insertRow = out.prepare(
        `INSERT INTO "${table}" (${quoted}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      const known = request.known[table] ?? {};
      const idIndex = columns.indexOf("id");
      // The column list seeds every chunk hash, so an omp schema change resends all rows.
      const seed = Bun.hash.xxHash64(quoted);
      let chunk = -1;
      let hash = seed;
      let buffered = [];
      const flush = () => {
        if (chunk < 0) {
          return;
        }
        const hex = hash.toString(16);
        insertChunk.run(table, chunk, hex, buffered.length);
        if (known[String(chunk)] !== hex) {
          for (const row of buffered) {
            insertRow.run(...row);
          }
        }
      };
      for (const row of src.query(`SELECT ${quoted} FROM "${table}" ORDER BY id`).values()) {
        const rowChunk = Math.floor(row[idIndex] / request.chunkSize);
        if (rowChunk !== chunk) {
          flush();
          chunk = rowChunk;
          hash = seed;
          buffered = [];
        }
        hash = Bun.hash.xxHash64(JSON.stringify(row), hash);
        buffered.push(row);
      }
      flush();
    }
    out.run("COMMIT");
    src.run("COMMIT");
    return Bun.gzipSync(out.serialize());
  } finally {
    out.close();
    src.close();
  }
}
