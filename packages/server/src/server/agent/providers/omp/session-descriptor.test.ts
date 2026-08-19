import { appendFile, mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  cloneOmpSessionFile,
  listOmpImportableSessions,
  readOmpImportSessionConfig,
  resolveOmpSessionFile,
} from "./session-descriptor.js";

async function writeSession(root: string, relativePath: string, lines: unknown[]): Promise<string> {
  const filePath = path.join(root, "sessions", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

describe("OMP session descriptor", () => {
  test("cwd filtering continues past the global candidate overscan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-cwd-limit-"));
    const sessionsDir = path.join(root, "sessions");
    const requestedCwd = path.join(root, "requested");
    const otherCwd = path.join(root, "other");
    const requestedFile = await writeSession(root, "requested/requested.jsonl", [
      {
        type: "session",
        id: "requested-session",
        timestamp: "2026-06-01T00:00:00.000Z",
        cwd: requestedCwd,
      },
    ]);
    await utimes(requestedFile, new Date("2026-06-01"), new Date("2026-06-01"));

    await Promise.all(
      Array.from({ length: 400 }, async (_, index) => {
        const file = await writeSession(root, `other/${index}.jsonl`, [
          {
            type: "session",
            id: `other-${index}`,
            timestamp: "2026-06-02T00:00:00.000Z",
            cwd: otherCwd,
          },
        ]);
        await utimes(file, new Date("2026-06-02"), new Date("2026-06-02"));
      }),
    );

    await expect(
      listOmpImportableSessions({ sessionDir: sessionsDir, cwd: requestedCwd, limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({ providerHandleId: requestedFile, cwd: requestedCwd }),
    ]);
  });

  test("reads title-first sessions and OMP combined model identifiers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-title-first-"));
    const cwd = path.join(root, "repo");
    const sessionFile = await writeSession(root, "project/session.jsonl", [
      {
        type: "title",
        id: "title-1",
        timestamp: "2026-06-09T00:00:00.000Z",
        title: "Deploy Paseo and verify",
      },
      {
        type: "session",
        version: 3,
        id: "session-title-first",
        timestamp: "2026-06-09T00:00:00.100Z",
        cwd,
      },
      {
        type: "model_change",
        id: "model-1",
        timestamp: "2026-06-09T00:00:00.200Z",
        model: "openai-codex/gpt-5.1",
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "import me" }] },
      },
    ]);

    await expect(
      listOmpImportableSessions({ sessionDir: path.join(root, "sessions") }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: sessionFile,
        cwd,
        title: "Deploy Paseo and verify",
        firstPromptPreview: "import me",
      }),
    ]);
    await expect(readOmpImportSessionConfig(sessionFile)).resolves.toEqual({
      model: "openai-codex/gpt-5.1",
    });
  });

  test("keeps recent nested OMP subagent sessions importable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-nested-"));
    const cwd = path.join(root, "repo");
    const parent = await writeSession(root, "project/parent.jsonl", [
      { type: "session", id: "parent", timestamp: "2026-06-10T00:00:00.000Z", cwd },
      {
        type: "message",
        id: "parent-user",
        timestamp: "2026-06-10T00:00:01.000Z",
        message: { role: "user", content: "parent prompt" },
      },
    ]);
    const child = await writeSession(root, "project/parent/Explore.jsonl", [
      { type: "session", id: "child", timestamp: "2026-06-09T00:00:00.000Z", cwd },
      {
        type: "message",
        id: "child-user",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: "child prompt" },
      },
    ]);
    await utimes(parent, new Date("2026-06-08"), new Date("2026-06-08"));
    await utimes(child, new Date("2026-06-09"), new Date("2026-06-09"));

    await expect(
      listOmpImportableSessions({ sessionDir: path.join(root, "sessions"), limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: child,
        title: "Explore",
        firstPromptPreview: "child prompt",
      }),
    ]);
  });

  test("uses OMP's own default session directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-home-"));
    const cwd = path.join(home, "repo");
    const sessionFile = path.join(home, ".omp", "agent", "sessions", "project", "session.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "default-dir", timestamp: "2026-06-09", cwd })}\n`,
      "utf8",
    );

    await expect(listOmpImportableSessions({ homeDir: home, env: {} })).resolves.toEqual([
      expect.objectContaining({ providerHandleId: sessionFile, cwd }),
    ]);
  });
  test("resolveOmpSessionFile locates actual session file when given a stub or missing path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-resolve-"));
    const fileName = "2026-08-04T00-00-00-000Z_019f0000-0000-7000-8000-000000000000.jsonl";
    const invalidPath = path.join(home, ".omp", "agent", "sessions", "invalid-dir", fileName);
    const realPath = path.join(home, ".omp", "agent", "sessions", "home-real-dir", fileName);

    await mkdir(path.dirname(realPath), { recursive: true });
    const line = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-08-04" }) + "\n";
    await writeFile(realPath, line.repeat(50), "utf8");

    const resolved = await resolveOmpSessionFile(invalidPath, { homeDir: home });
    expect(resolved).toBe(realPath);
  });

  test("cloneOmpSessionFile creates an independent, byte-identical copy in the same directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-clone-"));
    const source = path.join(
      root,
      "2026-08-04T00-00-00-000Z_019f0000-0000-7000-8000-000000000001.jsonl",
    );
    const line = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-08-04", cwd: root });
    await writeFile(source, `${line}\n`.repeat(10), "utf8");

    const clone = await cloneOmpSessionFile(source);
    // Fresh uniquely-named file in the same directory, never the source path.
    expect(clone).not.toBe(source);
    expect(path.dirname(clone)).toBe(path.dirname(source));
    expect(clone).toMatch(/\.jsonl$/u);
    // Byte-identical content (reflink or plain-copy fallback both deliver this).
    await expect(readFile(clone, "utf8")).resolves.toBe(await readFile(source, "utf8"));
    // The clone owns its history: appending to it must not touch the source.
    await appendFile(clone, '{"type":"session_info","name":"fork"}\n', "utf8");
    expect(await readFile(source, "utf8")).not.toContain("fork");
  });

  test("cloneOmpSessionFile with targetUserTurnCount slices session entries to the requested turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-clone-bounded-"));
    const source = path.join(
      root,
      "2026-08-04T00-00-00-000Z_019f0000-0000-7000-8000-000000000002.jsonl",
    );
    const lines = [
      JSON.stringify({ type: "title", v: 1, title: "Initial title" }),
      JSON.stringify({ type: "session", id: "root-1", parentId: null, cwd: root }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: "root-1",
        message: { role: "user", content: "first prompt" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "user-2",
        parentId: "assistant-1",
        message: { role: "user", content: "second prompt" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        message: { role: "assistant", content: [{ type: "text", text: "second response" }] },
      }),
    ];
    await writeFile(source, lines.join("\n") + "\n", "utf8");

    const clone = await cloneOmpSessionFile(source, { targetUserTurnCount: 1 });
    expect(clone).not.toBe(source);
    const cloneContent = await readFile(clone, "utf8");
    const cloneLines = cloneContent.trim().split("\n");

    // Contains title, session, user-1, assistant-1; omits user-2 and assistant-2
    expect(cloneLines).toHaveLength(4);
    expect(cloneContent).toContain("first prompt");
    expect(cloneContent).toContain("first response");
    expect(cloneContent).not.toContain("second prompt");
    expect(cloneContent).not.toContain("second response");
  });

  test("cloneOmpSessionFile with targetUserTurnCount >= session turns copies full file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-clone-bounded-full-"));
    const source = path.join(
      root,
      "2026-08-04T00-00-00-000Z_019f0000-0000-7000-8000-000000000003.jsonl",
    );
    const lines = [
      JSON.stringify({ type: "session", id: "root-1", parentId: null, cwd: root }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: "root-1",
        message: { role: "user", content: "first prompt" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
      }),
    ];
    await writeFile(source, lines.join("\n") + "\n", "utf8");

    const clone = await cloneOmpSessionFile(source, { targetUserTurnCount: 5 });
    const cloneContent = await readFile(clone, "utf8");
    expect(cloneContent).toBe(await readFile(source, "utf8"));
  });
});
