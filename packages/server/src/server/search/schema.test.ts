import { describe, expect, it } from "vitest";
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
});
