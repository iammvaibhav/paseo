import { mkdtemp, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  ingestTransferredOmpSession,
  OMP_SESSION_TRANSFER_MAX_BYTES,
  readOmpSessionForTransfer,
} from "./session-transfer.js";
import { encodeOmpSessionDirName } from "./warm-pool.js";

const TRANSCRIPT = '{"type":"session","cwd":"/work/ws-a"}\n{"type":"user","text":"hello"}\n';
const SESSION_FILE_NAME = "2026-09-16T15-10-42-000Z_019fe24f-c4cc-7000-8961-3d1ca5d87282.jsonl";

async function transcriptFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-transfer-"));
  const file = path.join(root, SESSION_FILE_NAME);
  await writeFile(file, TRANSCRIPT, "utf8");
  return file;
}

describe("readOmpSessionForTransfer", () => {
  test("returns null when the agent has no transcript to carry", async () => {
    expect(await readOmpSessionForTransfer(undefined)).toBeNull();
    expect(await readOmpSessionForTransfer(null)).toBeNull();
    expect(await readOmpSessionForTransfer("   ")).toBeNull();
    expect(await readOmpSessionForTransfer("/nowhere/missing.jsonl")).toBeNull();
  });

  test("carries the transcript bytes under its own file name", async () => {
    const sessionFile = await transcriptFixture();
    const carried = await readOmpSessionForTransfer(sessionFile);

    expect(carried).toEqual({
      fileName: SESSION_FILE_NAME,
      contentBase64: Buffer.from(TRANSCRIPT, "utf8").toString("base64"),
    });
  });

  test("refuses a transcript over the transfer cap instead of truncating it", async () => {
    const sessionFile = await transcriptFixture();
    // Sparse file: reports a size over the cap without writing the bytes.
    await truncate(sessionFile, OMP_SESSION_TRANSFER_MAX_BYTES + 1);

    await expect(readOmpSessionForTransfer(sessionFile)).rejects.toThrow(
      /over the 10\.0 MB cross-host move limit/,
    );
  });
});

describe("ingestTransferredOmpSession", () => {
  test("writes the transcript where omp looks for a session in that cwd", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "paseo-omp-ingest-"));
    const cwd = path.join(sessionsRoot, "work", "ws-b");

    const sessionFile = await ingestTransferredOmpSession({
      fileName: SESSION_FILE_NAME,
      contentBase64: Buffer.from(TRANSCRIPT, "utf8").toString("base64"),
      cwd,
      sessionsRoot,
    });

    expect(sessionFile).toBe(
      path.join(sessionsRoot, encodeOmpSessionDirName(path.resolve(cwd)), SESSION_FILE_NAME),
    );
    expect(await readFile(sessionFile, "utf8")).toBe(TRANSCRIPT);
  });

  test("replaces an existing transcript with the same name (retry is idempotent)", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "paseo-omp-ingest-retry-"));
    const cwd = path.join(sessionsRoot, "work", "ws-b");
    const args = { fileName: SESSION_FILE_NAME, contentBase64: "", cwd, sessionsRoot };

    await ingestTransferredOmpSession({
      ...args,
      contentBase64: Buffer.from("stale", "utf8").toString("base64"),
    });
    const sessionFile = await ingestTransferredOmpSession({
      ...args,
      contentBase64: Buffer.from(TRANSCRIPT, "utf8").toString("base64"),
    });

    expect(await readFile(sessionFile, "utf8")).toBe(TRANSCRIPT);
  });

  test("refuses a file name that could escape the sessions directory", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "paseo-omp-ingest-escape-"));
    const cwd = path.join(sessionsRoot, "work", "ws-b");
    const base64 = Buffer.from(TRANSCRIPT, "utf8").toString("base64");

    await expect(
      ingestTransferredOmpSession({
        fileName: "../../escaped.jsonl",
        contentBase64: base64,
        cwd,
        sessionsRoot,
      }),
    ).rejects.toThrow(/unexpected file name/);
    await expect(
      ingestTransferredOmpSession({
        fileName: "not-a-transcript.txt",
        contentBase64: base64,
        cwd,
        sessionsRoot,
      }),
    ).rejects.toThrow(/unexpected file name/);
    await expect(stat(path.join(sessionsRoot, "escaped.jsonl"))).rejects.toThrow();
  });
});
