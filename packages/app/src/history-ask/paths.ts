/**
 * Path encoding helpers for History Ask briefs.
 * Mirror daemon / native agent storage layout so the launched agent can find
 * catalogs and transcripts on disk.
 */

/** Paseo agent catalog dir name under `$PASEO_HOME/agents/{sanitized}/`. */
export function sanitizePaseoAgentDir(cwd: string): string {
  // Match packages/server agent-storage projectDirNameFromCwd (win32-aware).
  const rootMatch = cwd.match(/^([a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/)/);
  const root = rootMatch?.[1] ?? "";
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? `${sanitizedRoot}-` : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

const CLAUDE_PROJECT_DIR_LENGTH_CAP = 200;

/** Claude project dir segment under `~/.claude/projects/`. */
export function encodeClaudeProjectDir(cwd: string): string {
  const replaced = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= CLAUDE_PROJECT_DIR_LENGTH_CAP) {
    return replaced;
  }
  return `${replaced.slice(0, CLAUDE_PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(cwd)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Grok session dir segment under `~/.grok/sessions/`. */
export function encodeGrokSessionDir(cwd: string): string {
  return encodeURIComponent(cwd);
}

export interface HistorySearchRoots {
  cwds: string[];
  paseoAgentDirs: string[];
  claudeProjectDirs: string[];
  grokSessionDirs: string[];
  ompSessionDirs: string[];
}

/**
 * Build absolute-ish path hints for the History Ask brief.
 * Uses `~` home notation so agents on the host can expand them.
 */
export function buildHistorySearchRoots(cwds: readonly string[]): HistorySearchRoots {
  const unique = uniqueNonEmpty(cwds);
  return {
    cwds: unique,
    paseoAgentDirs: unique.map((cwd) => `~/.paseo/agents/${sanitizePaseoAgentDir(cwd)}`),
    claudeProjectDirs: unique.map((cwd) => `~/.claude/projects/${encodeClaudeProjectDir(cwd)}`),
    grokSessionDirs: unique.map((cwd) => `~/.grok/sessions/${encodeGrokSessionDir(cwd)}`),
    ompSessionDirs: ["~/.omp/agent/sessions/"],
  };
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
