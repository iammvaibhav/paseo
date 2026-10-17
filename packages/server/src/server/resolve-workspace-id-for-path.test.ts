import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";

import { createPersistedWorkspaceRecord } from "./workspace-registry.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";

function createWorkspaceRecord(
  cwd: string,
  workspaceId: string,
  overrides?: { createdAt?: string; archivedAt?: string },
) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd,
    kind: "directory",
    displayName: basename(cwd) || cwd,
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides?.archivedAt ?? null,
  });
}

// resolveWorkspaceIdForPath is the external path→workspace adapter for
// archive-by-path. It is NOT ownership: a record's owner is its workspaceId.
// The per-id status law is exercised in workspace-directory.test.ts.

describe("resolveWorkspaceIdForPath", () => {
  test("returns a single id when multiple workspaces share the exact cwd", () => {
    const id = resolveWorkspaceIdForPath("/workspace/project", [
      createWorkspaceRecord("/workspace/project", "ws-1"),
      createWorkspaceRecord("/workspace/project", "ws-2"),
      createWorkspaceRecord("/workspace/other", "ws-3"),
    ]);
    expect(["ws-1", "ws-2"]).toContain(id);
  });

  test("resolves an exact archived workspace match for archive-by-path", () => {
    expect(
      resolveWorkspaceIdForPath("/workspace/project", [
        createWorkspaceRecord("/workspace/project", "ws-archived", {
          archivedAt: "2026-03-05T00:00:00.000Z",
        }),
      ]),
    ).toEqual("ws-archived");
  });

  test("resolves the deepest enclosing workspace for a subdirectory path", () => {
    expect(
      resolveWorkspaceIdForPath("/workspace/project/packages/app", [
        createWorkspaceRecord("/workspace/project", "ws-1"),
        createWorkspaceRecord("/workspace", "ws-root"),
      ]),
    ).toEqual("ws-1");
  });

  test("does not match the home directory as a prefix", () => {
    const home = homedir();

    expect(
      resolveWorkspaceIdForPath(`${home}/child`, [createWorkspaceRecord(home, "ws-home")]),
    ).toBeNull();
    expect(resolveWorkspaceIdForPath(home, [createWorkspaceRecord(home, "ws-home")])).toEqual(
      "ws-home",
    );
  });

  test.skipIf(process.platform === "win32")(
    "resolves a path through a symlink to the workspace registered at either spelling",
    () => {
      const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "resolve-workspace-")));
      try {
        const realRoot = join(tempDir, "data", "paseo");
        const linkRoot = join(tempDir, "home-paseo");
        mkdirSync(join(realRoot, "packages"), { recursive: true });
        symlinkSync(realRoot, linkRoot, "dir");

        const legacy = [createWorkspaceRecord(linkRoot, "ws-link")];
        expect(resolveWorkspaceIdForPath(realRoot, legacy)).toBe("ws-link");
        expect(resolveWorkspaceIdForPath(join(realRoot, "packages"), legacy)).toBe("ws-link");

        const canonical = [createWorkspaceRecord(realRoot, "ws-real")];
        expect(resolveWorkspaceIdForPath(linkRoot, canonical)).toBe("ws-real");
        expect(resolveWorkspaceIdForPath(join(linkRoot, "packages"), canonical)).toBe("ws-real");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
