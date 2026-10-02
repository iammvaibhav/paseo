import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readOmpTimelineFromDisk } from "./omp-history.js";
import {
  supportsDiskTimeline,
  tryReadProviderTimelineFromDisk,
} from "../../provider-disk-history.js";

describe("OMP offline disk history", () => {
  test("supportsDiskTimeline includes omp", () => {
    expect(supportsDiskTimeline("omp")).toBe(true);
    expect(supportsDiskTimeline("pi")).toBe(false);
  });

  test("readOmpTimelineFromDisk projects session JSONL without spawning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-omp-disk-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-07-29T00:00:00.000Z",
          cwd: "/tmp/repo",
        },
        {
          type: "message",
          id: "user-1",
          parentId: "session-1",
          timestamp: "2026-07-29T00:00:01.000Z",
          message: { role: "user", content: "hello offline" },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-07-29T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi from disk" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    await expect(readOmpTimelineFromDisk({ sessionFile })).resolves.toEqual([
      {
        item: { type: "user_message", text: "hello offline", messageId: "user-1" },
        timestamp: "2026-07-29T00:00:01.000Z",
      },
      {
        item: {
          type: "assistant_message",
          text: "hi from disk",
          messageId: "omp-history-assistant-1",
        },
        timestamp: "2026-07-29T00:00:02.000Z",
      },
    ]);
  });
  test("readOmpTimelineFromDisk projects custom_message IRC entries as hub tool calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-omp-disk-irc-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "omp-session-irc",
          timestamp: "2026-07-29T00:00:00.000Z",
          cwd: "/tmp/repo",
        },
        {
          type: "message",
          id: "u1",
          parentId: "root",
          timestamp: "2026-07-29T00:00:01.000Z",
          message: { role: "user", content: "spawn worker" },
        },
        {
          type: "custom_message",
          customType: "irc:incoming",
          id: "c1",
          parentId: "u1",
          timestamp: "2026-07-29T00:00:02.000Z",
          display: true,
          content:
            "<irc>\nIncoming IRC message from agent `PolishWorker`:\n\nAll tasks complete\n</irc>",
          details: {
            from: "PolishWorker",
            message: "All tasks complete",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    await expect(readOmpTimelineFromDisk({ sessionFile })).resolves.toEqual([
      {
        item: { type: "user_message", text: "spawn worker", messageId: "u1" },
        timestamp: "2026-07-29T00:00:01.000Z",
      },
      {
        item: {
          type: "tool_call",
          callId: "omp-irc:c1",
          name: "hub",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "receive · from PolishWorker · All tasks complete",
            text: "All tasks complete",
            icon: "bot",
          },
          metadata: {
            synthetic: true,
            source: "omp_irc",
            from: "PolishWorker",
          },
          error: null,
        },
        timestamp: "2026-07-29T00:00:02.000Z",
      },
    ]);
  });

  test("tryReadProviderTimelineFromDisk uses OMP nativeHandle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-omp-disk-seed-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-seed",
          timestamp: "2026-07-29T00:00:00.000Z",
          cwd: "/tmp/repo",
        },
        {
          type: "message",
          id: "user-seed",
          parentId: "session-seed",
          timestamp: "2026-07-29T00:00:01.000Z",
          message: { role: "user", content: "seed me" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    await expect(
      tryReadProviderTimelineFromDisk({
        provider: "omp",
        cwd: "/tmp/repo",
        sessionId: "session-seed",
        nativeHandle: sessionFile,
      }),
    ).resolves.toEqual([
      {
        item: { type: "user_message", text: "seed me", messageId: "user-seed" },
        timestamp: "2026-07-29T00:00:01.000Z",
      },
    ]);
  });

  test("tryReadProviderTimelineFromDisk returns null without nativeHandle", async () => {
    await expect(
      tryReadProviderTimelineFromDisk({
        provider: "omp",
        cwd: "/tmp/repo",
        sessionId: "session-seed",
      }),
    ).resolves.toBeNull();
  });

  test("readOmpTimelineFromDisk returns null for missing file", async () => {
    await expect(
      readOmpTimelineFromDisk({ sessionFile: join(tmpdir(), "missing-omp-session.jsonl") }),
    ).resolves.toBeNull();
  });
});
