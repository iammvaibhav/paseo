import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCounters = vi.hoisted(() => ({
  nameStatusCalls: 0,
  numstatCalls: 0,
  trackedPatchCalls: 0,
  noIndexCalls: 0,
  showCalls: 0,
  catFileBatchCalls: 0,
}));

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, commandArgs] = args;
      if (command === "git" && Array.isArray(commandArgs)) {
        const normalizedArgs = commandArgs.map((arg) => String(arg));
        // `runGitCommand` always prepends its two config overrides; skip them
        // to find the actual git subcommand.
        const subcommandIndex =
          normalizedArgs[0] === "-c" && normalizedArgs[1] === "core.quotepath=false" ? 4 : 0;
        const subcommand = normalizedArgs[subcommandIndex];
        if (subcommand === "diff") {
          if (normalizedArgs.includes("--name-status")) {
            spawnCounters.nameStatusCalls += 1;
          } else if (normalizedArgs.includes("--numstat")) {
            spawnCounters.numstatCalls += 1;
          } else if (normalizedArgs.includes("--no-index")) {
            spawnCounters.noIndexCalls += 1;
          } else if (!normalizedArgs.includes("--shortstat")) {
            spawnCounters.trackedPatchCalls += 1;
          }
        } else if (subcommand === "show") {
          spawnCounters.showCalls += 1;
        } else if (subcommand === "cat-file" && normalizedArgs.includes("--batch")) {
          spawnCounters.catFileBatchCalls += 1;
        }
      }
      return actual.spawn(...args);
    },
  };
});

import * as runGitCommandModule from "./run-git-command.js";
import {
  collectTrackedBlobSpecs,
  getCheckoutDiff,
  readGitBlobsAtRefsBatch,
} from "./checkout-git.js";
import type { CheckoutFileChange } from "./checkout-git.js";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";

function resetSpawnCounters(): void {
  spawnCounters.nameStatusCalls = 0;
  spawnCounters.numstatCalls = 0;
  spawnCounters.trackedPatchCalls = 0;
  spawnCounters.noIndexCalls = 0;
  spawnCounters.showCalls = 0;
  spawnCounters.catFileBatchCalls = 0;
}

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

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses a single git diff spawn for tracked patch text regardless of file count", async () => {
    const setup = initRepoWithTrackedChanges(20);
    tempDir = setup.tempDir;
    repoDir = setup.repoDir;
    resetSpawnCounters();

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: false,
    });

    expect(result.diff).toContain("file-0.txt");
    expect(result.diff).toContain("file-19.txt");
    expect(spawnCounters.nameStatusCalls).toBe(1);
    expect(spawnCounters.numstatCalls).toBe(1);
    expect(spawnCounters.trackedPatchCalls).toBe(1);
    expect(spawnCounters.showCalls).toBe(0);
    expect(spawnCounters.noIndexCalls).toBe(0);
    expect(spawnCounters.catFileBatchCalls).toBe(0);
  });

  it("uses at most one cat-file --batch and zero per-file git show/diff/--no-index spawns for structured diffs", async () => {
    const setup = initRepoWithTrackedChanges(20, 5);
    tempDir = setup.tempDir;
    repoDir = setup.repoDir;
    resetSpawnCounters();

    const result = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    expect(result.structured?.map((file) => file.path)).toContain("file-0.txt");
    expect(result.structured?.map((file) => file.path)).toContain("untracked-0.txt");
    expect(spawnCounters.nameStatusCalls).toBe(1);
    expect(spawnCounters.numstatCalls).toBe(1);
    expect(spawnCounters.trackedPatchCalls).toBe(1);
    expect(spawnCounters.catFileBatchCalls).toBeLessThanOrEqual(1);
    expect(spawnCounters.showCalls).toBe(0);
    expect(spawnCounters.noIndexCalls).toBe(0);
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
