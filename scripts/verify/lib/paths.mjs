import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
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
 * Path to durable proofs directory: ~/.paseo/verify-proofs/<worktreeBasename>/<runId>
 */
export function getProofDir(worktreeRoot = getWorktreeRoot(), runId) {
  const baseName = path.basename(worktreeRoot);
  return path.join(os.homedir(), ".paseo", "verify-proofs", baseName, runId);
}

/**
 * Root directory for daemon homes: ~/.paseo/verify-runs
 */
export function getVerifyRunsBaseDir() {
  return path.join(os.homedir(), ".paseo", "verify-runs");
}

/**
 * Path to a run's daemon homes: ~/.paseo/verify-runs/<worktreeBasename>/<runId>
 * Deliberately outside any git repository so reserved Commander homes resolve
 * to host: project keys (which the itsaplan bridge already excludes).
 */
export function getRunsDir(worktreeRoot = getWorktreeRoot(), runId) {
  const baseName = path.basename(worktreeRoot);
  return path.join(getVerifyRunsBaseDir(), baseName, runId);
}

/**
 * Root directory for all durable verify proofs: ~/.paseo/verify-proofs
 */
export function getVerifyProofsBaseDir() {
  return path.join(os.homedir(), ".paseo", "verify-proofs");
}

/**
 * Resolve commander model from ~/.omp/agent/config.yml modelRoles.task with trailing :tier stripped.
 * Fallback: omp/google-antigravity/gemini-3.8-flash.
 */
export function resolveCommanderModel() {
  const fallback = "omp/google-antigravity/gemini-3.8-flash";
  const configPath = path.join(os.homedir(), ".omp", "agent", "config.yml");
  if (!existsSync(configPath)) {
    return fallback;
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    let taskRole = null;
    try {
      const parsed = YAML.parse(raw);
      taskRole = parsed?.modelRoles?.task;
    } catch {
      const match = raw.match(/^\s*task:\s*([^\s#]+)/m);
      if (match) {
        taskRole = match[1];
      }
    }
    if (typeof taskRole === "string" && taskRole.trim()) {
      const stripped = taskRole.trim().replace(/:[^:]+$/, "");
      return stripped.startsWith("omp/") ? stripped : `omp/${stripped}`;
    }
  } catch {
    // Fallback on read or parse failure
  }
  return fallback;
}

/**
 * Resolve reachable VPN IPv4 address:
 * 1. PASEO_VERIFY_REACHABLE_HOST env
 * 2. First non-loopback IPv4 address on an interface matching wg*
 * Fails if neither exists.
 */
export function resolveReachableIp() {
  const envHost = process.env.PASEO_VERIFY_REACHABLE_HOST?.trim();
  if (envHost) {
    return envHost;
  }
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name.startsWith("wg") && Array.isArray(addrs)) {
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal && addr.address) {
          return addr.address;
        }
      }
    }
  }
  throw new Error(
    "No WireGuard interface (wg*) with an IPv4 address found. Set PASEO_VERIFY_REACHABLE_HOST=<ip> to specify reachable IP.",
  );
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

/**
 * Path to the shared, always-on code-server config: ~/.config/code-server/config.yaml
 */
export function getCodeServerConfigPath() {
  return path.join(os.homedir(), ".config", "code-server", "config.yaml");
}

/**
 * Parse `bind-addr` out of the shared code-server config.yaml. Returns null when the
 * config file is missing or has no bind-addr, meaning code-server is not installed here.
 */
export function readCodeServerBindAddr() {
  const configPath = getCodeServerConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    let bindAddr = null;
    try {
      const parsed = YAML.parse(raw);
      bindAddr = parsed?.["bind-addr"];
    } catch {
      const match = raw.match(/^\s*bind-addr:\s*([^\s#]+)/m);
      if (match) {
        bindAddr = match[1];
      }
    }
    return typeof bindAddr === "string" && bindAddr.trim() ? bindAddr.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Probe a code-server (or any HTTP) URL for a 2xx/3xx response within timeoutMs.
 * Never throws; returns false on network error, non-2xx/3xx, or timeout.
 */
export async function probeHttpHealthy(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover the shared, per-host code-server instance. code-server is never spawned by the
 * mock stack (heavy + already project/folder-scoped by ?folder=<path>, same rule as itsaplan):
 * this only reads its config and probes health.
 *
 * Returns null when the config file is missing (code-server not configured on this host) or
 * when forced off via `enabled: false`.
 */
export async function discoverCodeServer({ enabled = true, timeoutMs = 2000 } = {}) {
  if (!enabled) {
    return null;
  }
  const bindAddr = readCodeServerBindAddr();
  if (!bindAddr) {
    return null;
  }
  const url = `http://${bindAddr}`;
  const healthy = await probeHttpHealthy(`${url}/`, timeoutMs);
  return { url, bindAddr, shared: true, healthy };
}
