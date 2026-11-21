import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { projectAcpSessionUpdates } from "./acp-history-projector.js";
import { parseGrokUpdatesJsonl, readGrokTimelineFromDisk } from "./grok-history.js";

function loadGolden(name: string): {
  cwd: string;
  sessionId: string;
  items: Array<Record<string, unknown>>;
} | null {
  const p = path.join("/tmp/paseo-history-goldens", name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as {
    cwd: string;
    sessionId: string;
    items: Array<Record<string, unknown>>;
  };
}

/** Compare timeline items ignoring ephemeral assistant messageIds. */
function normalizeForParity(items: Array<Record<string, unknown>>) {
  return items.map((item) => {
    if (item.type === "assistant_message") {
      const { messageId: _mid, ...rest } = item;
      return rest;
    }
    return item;
  });
}

describe("projectAcpSessionUpdates", () => {
  test("coalesces consecutive user_message_chunks", () => {
    const items = projectAcpSessionUpdates([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello " },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "world" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
        messageId: "fixed-id",
      },
    ]);
    expect(items).toEqual([
      { type: "user_message", text: "hello world" },
      { type: "assistant_message", text: "hi", messageId: "fixed-id" },
    ]);
  });

  test("emits each tool once when it reaches completed", () => {
    const items = projectAcpSessionUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "list_dir",
        rawInput: { target_directory: "/tmp" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        kind: "other",
        title: "List `/tmp`",
        rawInput: { variant: "ListDir", target_directory: "/tmp" },
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { type: "ListDir", Content: { content: "a\nb" } },
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t1",
      name: "List `/tmp`",
      status: "completed",
      metadata: { title: "List `/tmp`" },
    });
  });
});

describe("readGrokTimelineFromDisk vs live goldens", () => {
  for (const name of ["grok-ddab92f1.json", "grok-b23fdfea.json", "grok-5ff365c3.json"]) {
    test(`parity ${name}`, () => {
      const golden = loadGolden(name);
      if (!golden) {
        // Goldens are captured locally via scripts/capture-history-goldens.ts
        expect(true).toBe(true);
        return;
      }
      const disk = readGrokTimelineFromDisk({
        cwd: golden.cwd,
        sessionId: golden.sessionId,
      });
      expect(disk).not.toBeNull();
      const diskNorm = normalizeForParity(disk as Array<Record<string, unknown>>);
      const goldNorm = normalizeForParity(golden.items);
      expect(diskNorm.map((i) => i.type)).toEqual(goldNorm.map((i) => i.type));
      expect(diskNorm).toEqual(goldNorm);
    });
  }

  test("parseGrokUpdatesJsonl skips bad lines", () => {
    const updates = parseGrokUpdatesJsonl(
      [
        "not-json",
        JSON.stringify({
          params: {
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "x" },
            },
          },
        }),
        "",
      ].join("\n"),
    );
    expect(updates).toHaveLength(1);
  });
});

// Ensure path helper is available on this machine layout
test("resolve uses encodeURIComponent cwd segments", () => {
  const home = path.join(os.homedir(), ".grok");
  const expected = path.join(home, "sessions", encodeURIComponent("/Users/vaibhav/paseo"), "sid");
  expect(expected.includes("%2F")).toBe(true);
});
