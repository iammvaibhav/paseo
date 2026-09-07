import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Resolve the git worktree root directory.
 */
export function getWorktreeRoot() {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root && existsSync(root)) {
      return path.resolve(root);
    }
  } catch {
    // Fall back to walking up to find .git
  }

  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

/**
 * Path to scratch state: <worktree>/.dev/verify
 */
export function getDevVerifyDir(worktreeRoot = getWorktreeRoot()) {
  return path.join(worktreeRoot, ".dev", "verify");
}

/**
 * Path to deliverable artifacts: <worktree>/artifacts/verify
 */
export function getArtifactsVerifyDir(worktreeRoot = getWorktreeRoot()) {
  return path.join(worktreeRoot, "artifacts", "verify");
}

/**
 * Path to a specific run directory: <worktree>/.dev/verify/<runId>
 */
export function getStackDir(worktreeRoot, runId) {
  return path.join(getDevVerifyDir(worktreeRoot), runId);
}

/**
 * Path to a specific run's artifacts directory: <worktree>/artifacts/verify/<runId>
 */
export function getStackArtifactsDir(worktreeRoot, runId) {
  return path.join(getArtifactsVerifyDir(worktreeRoot), runId);
}

/**
 * Node compile cache path: <worktree>/.dev/verify/.node-compile-cache
 */
export function getNodeCompileCacheDir(worktreeRoot = getWorktreeRoot()) {
  return path.join(getDevVerifyDir(worktreeRoot), ".node-compile-cache");
}

/**
 * Generate a runId matching the contract: "v-" + 8 hex chars.
 */
export function generateRunId() {
  return `v-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Resolve the web UI dist dir with search order:
 * 1. PASEO_VERIFY_WEB_UI_DIST env
 * 2. <worktree>/packages/server/dist/server/web-ui
 * 3. /data/paseo/packages/server/dist/server/web-ui
 * 4. /home/ubuntu/paseo/packages/server/dist/server/web-ui
 */
export function resolveWebUiDistDir(worktreeRoot = getWorktreeRoot()) {
  const envPath = process.env.PASEO_VERIFY_WEB_UI_DIST?.trim();
  if (envPath && existsSync(envPath)) {
    return path.resolve(envPath);
  }

  const candidates = [
    path.join(worktreeRoot, "packages", "server", "dist", "server", "web-ui"),
    "/data/paseo/packages/server/dist/server/web-ui",
    "/home/ubuntu/paseo/packages/server/dist/server/web-ui",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}
