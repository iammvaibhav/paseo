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
        type: "user_message",
        text: "hello offline",
        messageId: "user-1",
      },
      {
        type: "assistant_message",
        text: "hi from disk",
        messageId: "omp-history-assistant-1",
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
        type: "user_message",
        text: "seed me",
        messageId: "user-seed",
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
