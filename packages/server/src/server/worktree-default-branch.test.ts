import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComposerPreferences } from "@getpaseo/protocol/composer-preferences";
import {
  resolveWorktreeDefaultBranch,
  type WorktreeDefaultBranchResolutionDeps,
} from "./bootstrap.js";
import { getWorktreeConfiguredBaseRef } from "../utils/worktree.js";

function createFakeResolutionDeps(overrides?: {
  composerPreferences?: ComposerPreferences | null;
  projects?: Array<{ rootPath: string; projectId: string; projectKey: string }>;
  repoDefaultBranch?: string;
  readConfiguredBaseRef?: (repoRoot: string) => string | undefined;
}): WorktreeDefaultBranchResolutionDeps {
  return {
    daemonConfigStore: {
      get: () => ({
        composerPreferences: overrides?.composerPreferences ?? null,
      }),
    },
    projectRegistry: {
      list: async () => overrides?.projects ?? [],
    },
    workspaceGitService: {
      resolveDefaultBranch: async (_repoRoot: string) =>
        overrides?.repoDefaultBranch ?? "origin/HEAD",
    },
    readConfiguredBaseRef: overrides?.readConfiguredBaseRef,
  };
}

describe("resolveWorktreeDefaultBranch resolution order", () => {
  const repoRoot = "/test/repo/project-a";
  const project = {
    rootPath: repoRoot,
    projectId: "proj-123",
    projectKey: "project-a",
  };

  test("(a) paseo.json worktree.warmPool.baseRef wins over a remembered preference", async () => {
    const deps = createFakeResolutionDeps({
      readConfiguredBaseRef: () => "configured-base-branch",
      composerPreferences: {
        byProject: {
          [project.projectId]: { baseBranch: "remembered-project-branch" },
        },
      },
      projects: [project],
      repoDefaultBranch: "repo-default-main",
    });

    const result = await resolveWorktreeDefaultBranch(repoRoot, deps);
    expect(result).toBe("configured-base-branch");
  });

  test("(b) with no paseo.json key, the remembered preference wins", async () => {
    const deps = createFakeResolutionDeps({
      readConfiguredBaseRef: () => undefined,
      composerPreferences: {
        byProject: {
          [project.projectId]: { baseBranch: "remembered-project-branch" },
        },
      },
      projects: [project],
      repoDefaultBranch: "repo-default-main",
    });

    const result = await resolveWorktreeDefaultBranch(repoRoot, deps);
    expect(result).toBe("remembered-project-branch");
  });

  test("(c) with neither, the repo default is used", async () => {
    const deps = createFakeResolutionDeps({
      readConfiguredBaseRef: () => undefined,
      composerPreferences: null,
      projects: [project],
      repoDefaultBranch: "repo-default-main",
    });

    const result = await resolveWorktreeDefaultBranch(repoRoot, deps);
    expect(result).toBe("repo-default-main");
  });

  test("an empty or whitespace configured base ref is ignored and falls through", async () => {
    const depsEmpty = createFakeResolutionDeps({
      readConfiguredBaseRef: () => "   ",
      composerPreferences: {
        byProject: {
          [project.projectId]: { baseBranch: "remembered-project-branch" },
        },
      },
      projects: [project],
      repoDefaultBranch: "repo-default-main",
    });

    const result = await resolveWorktreeDefaultBranch(repoRoot, depsEmpty);
    expect(result).toBe("remembered-project-branch");
  });
});

describe("real disk integration with paseo.json", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-test-base-branch-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reads valid worktree.warmPool.baseRef from paseo.json on disk", async () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          warmPool: { baseRef: "staging" },
        },
      }),
    );

    expect(getWorktreeConfiguredBaseRef(tempDir)).toBe("staging");

    const deps = createFakeResolutionDeps({
      composerPreferences: {
        baseBranch: "global-remembered-branch",
      },
      repoDefaultBranch: "main",
    });

    const resolved = await resolveWorktreeDefaultBranch(tempDir, deps);
    expect(resolved).toBe("staging");
  });

  test("trims whitespace from worktree.warmPool.baseRef in paseo.json", async () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          warmPool: { baseRef: "  production-release  " },
        },
      }),
    );

    expect(getWorktreeConfiguredBaseRef(tempDir)).toBe("production-release");

    const deps = createFakeResolutionDeps({
      composerPreferences: {
        baseBranch: "global-remembered-branch",
      },
      repoDefaultBranch: "main",
    });

    const resolved = await resolveWorktreeDefaultBranch(tempDir, deps);
    expect(resolved).toBe("production-release");
  });

  test("ignores empty/whitespace worktree.warmPool.baseRef in paseo.json", async () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          warmPool: { baseRef: "   " },
        },
      }),
    );

    expect(getWorktreeConfiguredBaseRef(tempDir)).toBeUndefined();

    const deps = createFakeResolutionDeps({
      composerPreferences: {
        baseBranch: "global-remembered-branch",
      },
      repoDefaultBranch: "main",
    });

    const resolved = await resolveWorktreeDefaultBranch(tempDir, deps);
    expect(resolved).toBe("global-remembered-branch");
  });

  test("swallows malformed paseo.json syntax on disk and falls through", async () => {
    writeFileSync(join(tempDir, "paseo.json"), '{"worktree": { NOT_VALID_JSON');

    expect(getWorktreeConfiguredBaseRef(tempDir)).toBeUndefined();

    const deps = createFakeResolutionDeps({
      composerPreferences: {
        baseBranch: "global-remembered-branch",
      },
      repoDefaultBranch: "main",
    });

    const resolved = await resolveWorktreeDefaultBranch(tempDir, deps);
    expect(resolved).toBe("global-remembered-branch");
  });

  test("returns undefined when paseo.json is absent on disk", async () => {
    expect(getWorktreeConfiguredBaseRef(tempDir)).toBeUndefined();

    const deps = createFakeResolutionDeps({
      composerPreferences: null,
      repoDefaultBranch: "origin/HEAD",
    });

    const resolved = await resolveWorktreeDefaultBranch(tempDir, deps);
    expect(resolved).toBe("origin/HEAD");
  });
});
