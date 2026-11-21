import type { HistoryAskScope } from "./scope";

/**
 * Resolve a real cwd for createAgent when launching History Ask.
 * Host-wide scopes intentionally leave scope.cwds empty (search all on host);
 * the agent process still needs some directory to start in.
 */
export function resolveHistoryAskLaunchCwd(input: {
  scope: HistoryAskScope;
  /** Explicit override (e.g. user-selected). */
  preferredCwd?: string | null;
  /** Active/non-archived workspace directories on the target host. */
  workspaceCwds?: readonly string[] | null;
  /** Recent agent cwds on the target host (history list), newest first. */
  historyAgentCwds?: readonly string[] | null;
}): string | null {
  const preferred = input.preferredCwd?.trim();
  if (preferred) {
    return preferred;
  }

  const fromScope = input.scope.cwds.find((cwd) => cwd.trim().length > 0)?.trim();
  if (fromScope) {
    return fromScope;
  }

  for (const cwd of input.workspaceCwds ?? []) {
    const trimmed = cwd.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  for (const cwd of input.historyAgentCwds ?? []) {
    const trimmed = cwd.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}
