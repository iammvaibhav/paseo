import { describe, expect, it } from "vitest";
import { toFtsQueries } from "./fts-query.js";
import { TRANSCRIPT_INDEX_DDL } from "./schema.js";
import { tryLoadNodeSqlite } from "./sqlite.js";

describe("transcript FTS schema", () => {
  it("opens an in-memory index and matches a prefix", async () => {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      return;
    }
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(TRANSCRIPT_INDEX_DDL);
    db.prepare("INSERT INTO chunk (agent_id, ord, role, ts, text) VALUES (?, ?, ?, ?, ?)").run(
      "agent-1",
      0,
      "user_message",
      null,
      "opened the stripe webhook",
    );
    const rows = db
      .prepare(
        "SELECT chunk.agent_id AS agent_id FROM chunk_fts JOIN chunk ON chunk.id = chunk_fts.rowid WHERE chunk_fts MATCH ?",
      )
      .all("stripe*");
    expect(rows).toEqual([{ agent_id: "agent-1" }]);
    db.close();
  });

  it("matches the phrase, then nearby words, then words anywhere in a chunk", async () => {
    const sqlite = await tryLoadNodeSqlite();
    if (!sqlite) {
      return;
    }
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(TRANSCRIPT_INDEX_DDL);
    const insert = db.prepare(
      "INSERT INTO chunk (agent_id, ord, role, ts, text) VALUES (?, 0, 'assistant_message', NULL, ?)",
    );
    insert.run("phrase", "Mapping the MacBook traffic flow through NetBird.");
    insert.run("near", "The traffic is not really flowing after wake.");
    insert.run(
      "apart",
      "Preprod traffic is a good shadow test. Later, much later, we drew a flowchart of the build.",
    );
    const select = db.prepare(
      "SELECT group_concat(agent_id) AS agents FROM (SELECT chunk.agent_id AS agent_id FROM chunk_fts JOIN chunk ON chunk.id = chunk_fts.rowid WHERE chunk_fts MATCH ? ORDER BY agent_id)",
    );
    const matching = toFtsQueries("traffic flow").map((match) => select.get(match)?.agents);
    expect(matching).toEqual(["phrase", "near,phrase", "apart,near,phrase"]);
    db.close();
  });
});
