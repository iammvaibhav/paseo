import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { startGitCommandMetrics, stopGitCommandMetrics } from "@server/utils/run-git-command.js";

import * as runGitCommandModule from "./run-git-command.js";
import {
  collectTrackedBlobSpecs,
  getCheckoutDiff,
  readGitBlobsAtRefsBatch,
} from "./checkout-git.js";
import type { CheckoutFileChange } from "./checkout-git.js";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";

function initRepoWithTrackedChanges(
  fileCount: number,
  untrackedCount = 0,
): { tempDir: string; repoDir: string } {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-git-batch-test-")));
  const repoDir = join(tempDir, "repo");

  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });

  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(repoDir, `file-${i}.txt`), `before-${i}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
    cwd: repoDir,
  });

  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(repoDir, `file-${i}.txt`), `after-${i}\n`);
  }
  for (let i = 0; i < untrackedCount; i += 1) {
    writeFileSync(join(repoDir, `untracked-${i}.txt`), `untracked-${i}\n`);
  }

  return { tempDir, repoDir };
}

describe("checkout git diff batching", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    const setup = initRepoWithTrackedChanges(20);
    tempDir = setup.tempDir;
    repoDir = setup.repoDir;
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("collects ordinary tracked patches with one bounded Git command", async () => {
    startGitCommandMetrics();
    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: false,
    });

    expect(result.diff).toContain("file-0.txt");
    expect(result.diff).toContain("file-19.txt");
    const metrics = stopGitCommandMetrics();
    expect(
      metrics.commands.filter(({ args }) => args[0] === "diff" && args.includes("--")),
    ).toHaveLength(1);
  });

  it("batches committed file contents and preserves the highlighted diff", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "change"], { cwd: repoDir });
    startGitCommandMetrics();
    const result = await getCheckoutDiff(repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });
    const metrics = stopGitCommandMetrics();
    expect(result.structured).toHaveLength(20);
    expect(result.structured?.every((file) => file.additions === 1 && file.deletions === 1)).toBe(
      true,
    );
    expect(metrics.commands.filter(({ args }) => args[0] === "show")).toHaveLength(0);
    expect(metrics.commands.filter(({ args }) => args[0] === "cat-file")).toHaveLength(1);
  });

  it("keeps small neighbors when a patch exceeds the entire batch budget", async () => {
    writeFileSync(join(repoDir, "file-0.txt"), "x".repeat(9 * 1024 * 1024) + "\n");
    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(result.structured).toHaveLength(20);
    expect(result.structured?.find((file) => file.path === "file-0.txt")).toMatchObject({
      status: "too_large",
      hunks: [],
    });
    expect(result.structured?.filter((file) => file.status === "ok")).toHaveLength(19);
    expect(result.diff).toContain("+after-19");
    expect(result.diff).not.toContain("x".repeat(1_000));
  });
});

describe("readGitBlobsAtRefsBatch", () => {
  it("a spec list containing a path with an embedded newline still returns correct content for the other specs and null for the newline one", async () => {
    const specs = [
      "main:first.txt",
      "main:file\nwith\nnewline.txt",
      "main:second.txt",
      "main:file\rwith\rcarriage.txt",
    ];

    const gitSpy = vi
      .spyOn(runGitCommandModule, "runGitCommand")
      .mockImplementation(async (args, options) => {
        expect(args).toEqual(["cat-file", "--batch"]);
        expect(options.rawOutput).toBe(true);
        // Specs containing \n or \r must NOT be sent to git cat-file --batch
        expect(options.input).toBe("main:first.txt\nmain:second.txt\n");

        const header1 = "1111111111111111111111111111111111111111 blob 11\n";
        const content1 = "first blob\n";
        const header2 = "2222222222222222222222222222222222222222 blob 12\n";
        const content2 = "second blob\n";
        const raw = Buffer.concat([
          Buffer.from(header1, "utf8"),
          Buffer.from(content1, "utf8"),
          Buffer.from("\n", "utf8"),
          Buffer.from(header2, "utf8"),
          Buffer.from(content2, "utf8"),
          Buffer.from("\n", "utf8"),
        ]);

        return {
          stdout: raw.toString("utf8"),
          stdoutBuffer: raw,
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      });

    try {
      const results = await readGitBlobsAtRefsBatch("/fake/repo", specs);
      expect(results.get("main:first.txt")).toBe("first blob\n");
      expect(results.get("main:file\nwith\nnewline.txt")).toBeNull();
      expect(results.get("main:second.txt")).toBe("second blob\n");
      expect(results.get("main:file\rwith\rcarriage.txt")).toBeNull();
    } finally {
      gitSpy.mockRestore();
    }
  });

  it("a blob with invalid UTF-8 bytes followed by another spec still returns the second blob's content (raw-buffer parsing)", async () => {
    const specs = ["main:corrupt-utf8.bin", "main:valid.txt"];

    // 4 invalid UTF-8 bytes (e.g. 0x80, 0x81, 0xfe, 0xff). If decoded to UTF-8
    // and re-encoded, each byte would expand to 3 bytes of U+FFFD (12 bytes),
    // causing an 8-byte offset drift that corrupts the subsequent header.
    const invalidBytes = Buffer.from([0x80, 0x81, 0xfe, 0xff]);
    const header1 = `1111111111111111111111111111111111111111 blob ${invalidBytes.length}\n`;
    const header2 = "2222222222222222222222222222222222222222 blob 15\n";
    const validContent = "valid file data";

    const raw = Buffer.concat([
      Buffer.from(header1, "utf8"),
      invalidBytes,
      Buffer.from("\n", "utf8"),
      Buffer.from(header2, "utf8"),
      Buffer.from(validContent, "utf8"),
      Buffer.from("\n", "utf8"),
    ]);

    const gitSpy = vi
      .spyOn(runGitCommandModule, "runGitCommand")
      .mockImplementation(async (args, options) => {
        expect(args).toEqual(["cat-file", "--batch"]);
        expect(options.rawOutput).toBe(true);

        return {
          stdout: raw.toString("utf8"),
          stdoutBuffer: raw,
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      });

    try {
      const results = await readGitBlobsAtRefsBatch("/fake/repo", specs);
      expect(results.get("main:corrupt-utf8.bin")).toBeDefined();
      expect(results.get("main:valid.txt")).toBe(validContent);
    } finally {
      gitSpy.mockRestore();
    }
  });

  it("excludes paths with newlines or carriage returns from collectTrackedBlobSpecs", () => {
    const trackedChanges: CheckoutFileChange[] = [
      { path: "normal.txt", isNew: false, isDeleted: false, status: "M" },
      { path: "newline\npath.txt", isNew: false, isDeleted: false, status: "M" },
      { path: "carriage\rpath.txt", isNew: false, isDeleted: false, status: "M" },
      {
        path: "renamed.txt",
        oldPath: "old\nname.txt",
        isNew: false,
        isDeleted: false,
        status: "R",
      },
    ];
    const parsedFile: ParsedDiffFile = {
      path: "placeholder",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      hunks: [],
      status: "ok",
    };
    const parsedTrackedByPath = new Map<string, ParsedDiffFile>([
      ["normal.txt", { ...parsedFile, path: "normal.txt" }],
      ["newline\npath.txt", { ...parsedFile, path: "newline\npath.txt" }],
      ["carriage\rpath.txt", { ...parsedFile, path: "carriage\rpath.txt" }],
      ["renamed.txt", { ...parsedFile, path: "renamed.txt", oldPath: "old\nname.txt" }],
    ]);

    const specs = collectTrackedBlobSpecs({
      trackedChanges,
      trackedPlaceholderByPath: new Map(),
      parsedTrackedByPath,
      refsForDiff: { baseRef: "main", targetRef: "feature" },
    });

    expect(specs).toContain("main:normal.txt");
    expect(specs).toContain("feature:normal.txt");
    expect(specs.some((s) => s.includes("\n") || s.includes("\r"))).toBe(false);
  });
});
