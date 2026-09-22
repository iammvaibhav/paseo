import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BINARY_NAME = "plannotator";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the plannotator binary. GUI daemons often lack ~/.local/bin on PATH,
 * so check that path first, then PATH entries, then an optional override.
 */
export function resolvePlannotatorBinary(input?: {
  override?: string | null;
  envPath?: string | null;
  homeDir?: string;
}): string | null {
  const override = input?.override?.trim();
  if (override && isExecutable(override)) {
    return override;
  }

  const home = input?.homeDir ?? homedir();
  const localBin = join(home, ".local", "bin", DEFAULT_BINARY_NAME);
  if (isExecutable(localBin)) {
    return localBin;
  }

  const pathEnv = input?.envPath ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, DEFAULT_BINARY_NAME);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function detectPlannotatorVersion(binaryPath: string): string | null {
  try {
    // Lazy require so tests can mock spawn if needed; keep sync for server_info.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.trim().split("\n")[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}
