import { homedir } from "node:os";
import { sep } from "node:path";

import { canonicalizePath } from "../utils/path.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

// external path→workspace adapter, not ownership.
//
// Resolves a raw filesystem path to a single workspace id ONLY at the boundary
// where a client hands the daemon a bare worktree path with no id:
// archive-by-path (old client / CLI), auto-archive-after-merge, and the MCP
// `archive_worktree` tool. It is NEVER used to attribute agent status or place
// agents under a workspace — those are keyed by `workspaceId`, and git facts
// derive from a workspace's OWN cwd (id → cwd).
//
// Resolution: an exact directory match wins; otherwise the deepest enclosing
// workspace directory, never the home directory; null when nothing encloses it.
export function resolveWorkspaceIdForPath(
  cwd: string,
  workspaces: Iterable<PersistedWorkspaceRecord>,
): string | null {
  // Paths compare by realpath: a client may hand a symlinked spelling
  // (~/paseo) of a workspace registered at its target (/data/paseo), or vice versa.
  const workspaceRecords = Array.from(workspaces, (workspace) => ({
    workspace,
    canonicalCwd: canonicalizePath(workspace.cwd),
  }));
  const resolvedCwd = canonicalizePath(cwd);
  const exactMatch = workspaceRecords.find(({ canonicalCwd }) => canonicalCwd === resolvedCwd);
  if (exactMatch) {
    return exactMatch.workspace.workspaceId;
  }

  const userHome = canonicalizePath(homedir());
  let bestMatchLength = 0;
  let bestMatch: PersistedWorkspaceRecord | null = null;
  for (const { workspace, canonicalCwd: workspaceCwd } of workspaceRecords) {
    if (workspace.archivedAt) continue;
    if (workspaceCwd === userHome) continue;
    const prefix = workspaceCwd.endsWith(sep) ? workspaceCwd : `${workspaceCwd}${sep}`;
    if (!resolvedCwd.startsWith(prefix)) {
      continue;
    }
    if (workspaceCwd.length > bestMatchLength) {
      bestMatchLength = workspaceCwd.length;
      bestMatch = workspace;
    }
  }

  return bestMatch?.workspaceId ?? null;
}
