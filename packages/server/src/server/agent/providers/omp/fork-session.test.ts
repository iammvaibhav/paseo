import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { forkOmpSessionFile, planOmpSessionFork } from "./fork-session.js";

const TIMESTAMP = new Date("2026-07-30T10:20:30.400Z");

function userPrompt(id: string, parentId: string, text: string): unknown {
  return { type: "message", id, parentId, message: { role: "user", content: text } };
}

function assistantReply(id: string, parentId: string, text: string): unknown {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function toolResult(id: string, parentId: string): unknown {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
  };
}

/**
 * Shape of a real OMP session file: a title header, the session entry, then a
 * parent-linked chain of two complete turns.
 */
const SESSION_ENTRIES: unknown[] = [
  { type: "title", v: 1, title: "Source session", source: "auto" },
  { type: "session", id: "source-session", timestamp: "2026-07-01T00:00:00.000Z", cwd: "/repo" },
  { type: "model_change", id: "model-1", parentId: "source-session", model: "gpt-5.5" },
  userPrompt("prompt-1", "model-1", "first prompt"),
  assistantReply("assistant-1a", "prompt-1", "calling a tool"),
  toolResult("tool-1", "assistant-1a"),
  assistantReply("assistant-1b", "tool-1", "first answer"),
  userPrompt("prompt-2", "assistant-1b", "second prompt"),
  assistantReply("assistant-2", "prompt-2", "second answer"),
];

function sourceFile(entries: unknown[] = SESSION_ENTRIES): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function forkedEntryIds(contents: string): string[] {
  return contents
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { id?: string })
    .map((entry) => entry.id ?? "-");
}

describe("OMP session fork", () => {
  test("copies the whole session and rebinds the session id when no boundary is given", () => {
    const plan = planOmpSessionFork({
      source: sourceFile(),
      sessionId: "fork-session",
      timestamp: TIMESTAMP,
    });

    const entries = plan.contents
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[1]).toEqual({
      type: "session",
      id: "fork-session",
      timestamp: TIMESTAMP.toISOString(),
      cwd: "/repo",
    });
    // Entries rooted at the old session id have to follow it, or the forked
    // chain loses its root.
    expect(entries[2]).toMatchObject({ id: "model-1", parentId: "fork-session" });
    expect(forkedEntryIds(plan.contents)).toEqual([
      "-",
      "fork-session",
      "model-1",
      "prompt-1",
      "assistant-1a",
      "tool-1",
      "assistant-1b",
      "prompt-2",
      "assistant-2",
    ]);
  });

  test("a user entry boundary keeps that whole turn and drops the next prompt onward", () => {
    const plan = planOmpSessionFork({
      source: sourceFile(),
      boundary: { kind: "user_entry", entryId: "prompt-1" },
      sessionId: "fork-session",
      timestamp: TIMESTAMP,
    });

    expect(forkedEntryIds(plan.contents)).toEqual([
      "-",
      "fork-session",
      "model-1",
      "prompt-1",
      "assistant-1a",
      "tool-1",
      "assistant-1b",
    ]);
  });

  test("a boundary on the newest prompt keeps the session up to its head", () => {
    const plan = planOmpSessionFork({
      source: sourceFile(),
      boundary: { kind: "user_entry", entryId: "prompt-2" },
      sessionId: "fork-session",
      timestamp: TIMESTAMP,
    });

    expect(forkedEntryIds(plan.contents)).toEqual([
      "-",
      "fork-session",
      "model-1",
      "prompt-1",
      "assistant-1a",
      "tool-1",
      "assistant-1b",
      "prompt-2",
      "assistant-2",
    ]);
  });

  test("the last-prompt boundary drops the turn still streaming after it", () => {
    const plan = planOmpSessionFork({
      source: sourceFile([
        ...SESSION_ENTRIES,
        userPrompt("prompt-3", "assistant-2", "third prompt"),
        assistantReply("assistant-3", "prompt-3", "partial work"),
        toolResult("tool-3", "assistant-3"),
      ]),
      boundary: { kind: "last_prompt" },
      sessionId: "fork-session",
      timestamp: TIMESTAMP,
    });

    expect(forkedEntryIds(plan.contents).at(-1)).toBe("prompt-3");
  });

  test("keeps tool results out of the prompt boundary search", () => {
    // A toolResult role is not a prompt, so a boundary turn containing one must
    // not be cut short at it.
    const plan = planOmpSessionFork({
      source: sourceFile(),
      boundary: { kind: "user_entry", entryId: "prompt-1" },
      sessionId: "fork-session",
      timestamp: TIMESTAMP,
    });

    expect(forkedEntryIds(plan.contents)).toContain("tool-1");
  });

  test("drops a partially flushed trailing entry", () => {
    const plan = planOmpSessionFork({
      source: `${sourceFile()}{"type":"message","id":"half-writ`,
      sessionId: "fork-session",
      timestamp: TIMESTAMP,
    });

    expect(forkedEntryIds(plan.contents).at(-1)).toBe("assistant-2");
  });

  test("refuses a boundary the session does not contain", () => {
    expect(() =>
      planOmpSessionFork({
        source: sourceFile(),
        boundary: { kind: "user_entry", entryId: "prompt-missing" },
        sessionId: "fork-session",
        timestamp: TIMESTAMP,
      }),
    ).toThrow(/no entry prompt-missing/);
  });

  test("refuses a boundary that is not a user prompt", () => {
    expect(() =>
      planOmpSessionFork({
        source: sourceFile(),
        boundary: { kind: "user_entry", entryId: "assistant-1b" },
        sessionId: "fork-session",
        timestamp: TIMESTAMP,
      }),
    ).toThrow(/not a user message/);
  });

  test("refuses a session file with no session header", () => {
    expect(() =>
      planOmpSessionFork({
        source: sourceFile([{ type: "title", title: "Headerless" }]),
        sessionId: "fork-session",
        timestamp: TIMESTAMP,
      }),
    ).toThrow(/no session header/);
  });

  test("writes the fork beside the source under OMP's own file naming", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-omp-fork-"));
    const source = path.join(dir, "2026-07-01T00-00-00-000Z_source-session.jsonl");
    await writeFile(source, sourceFile(), "utf8");

    const forked = await forkOmpSessionFile({
      sessionFile: source,
      boundary: { kind: "user_entry", entryId: "prompt-1" },
      now: TIMESTAMP,
    });

    expect(path.dirname(forked.sessionFile)).toBe(dir);
    expect(path.basename(forked.sessionFile)).toBe(
      `2026-07-30T10-20-30-400Z_${forked.sessionId}.jsonl`,
    );
    // OMP session ids are UUIDv7, timestamp-prefixed.
    expect(forked.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    expect(forked.sessionId.replaceAll("-", "").slice(0, 12)).toBe(
      TIMESTAMP.getTime().toString(16).padStart(12, "0"),
    );
    // The source is never mutated by a fork.
    expect(await readFile(source, "utf8")).toBe(sourceFile());
    expect(forkedEntryIds(await readFile(forked.sessionFile, "utf8")).at(-1)).toBe("assistant-1b");
  });
});
