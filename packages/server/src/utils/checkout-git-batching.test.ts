import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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

import { getCheckoutDiff } from "./checkout-git.js";

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
