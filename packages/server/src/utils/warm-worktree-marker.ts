import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/**
 * A warm worktree is a real Paseo worktree at its final path that has not been
 * handed to a workspace yet. The marker is what makes it warm: listings hide
 * marked worktrees, and the pool rediscovers them across daemon restarts.
 *
 * The marker sits beside the worktree (`<project worktrees root>/.paseo-warm/
 * <slug>.json`), not inside it, so it exists before `git worktree add` runs.
 * That keeps the tree hidden for its whole provisioning, including the
 * checkout hooks (submodule population) git runs during the add.
 */
const WarmWorktreeMarkerSchema = z.object({
  version: z.literal(1),
  /** "provisioning" until worktree.setup finished; only "ready" trees are claimable. */
  status: z.enum(["provisioning", "ready"]),
  sourceRef: z.string().min(1),
  /** Commit the tree was checked out at; a claim whose base moved past it is stale. */
  baseSha: z.string().min(1),
  /** Hash of the worktree.setup commands that ran; null until setup finished. */
  setupFingerprint: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
});

export type WarmWorktreeMarker = z.infer<typeof WarmWorktreeMarkerSchema>;

const WARM_MARKER_DIR_NAME = ".paseo-warm";

function warmWorktreeMarkerPath(worktreePath: string): string {
  return join(dirname(worktreePath), WARM_MARKER_DIR_NAME, `${basename(worktreePath)}.json`);
}

export function hasWarmWorktreeMarker(worktreePath: string): boolean {
  return existsSync(warmWorktreeMarkerPath(worktreePath));
}

export function readWarmWorktreeMarker(worktreePath: string): WarmWorktreeMarker | null {
  try {
    const parsed = WarmWorktreeMarkerSchema.safeParse(
      JSON.parse(readFileSync(warmWorktreeMarkerPath(worktreePath), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeWarmWorktreeMarker(worktreePath: string, marker: WarmWorktreeMarker): void {
  const markerPath = warmWorktreeMarkerPath(worktreePath);
  mkdirSync(dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  renameSync(tempPath, markerPath);
}

export function removeWarmWorktreeMarker(worktreePath: string): void {
  rmSync(warmWorktreeMarkerPath(worktreePath), { force: true });
}

/** Worktree paths that carry a marker under a project's worktrees root, whether or not the tree still exists. */
export function listWarmWorktreeMarkedPaths(projectWorktreesRoot: string): string[] {
  try {
    return readdirSync(join(projectWorktreesRoot, WARM_MARKER_DIR_NAME))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(projectWorktreesRoot, name.slice(0, -".json".length)));
  } catch {
    return [];
  }
}
