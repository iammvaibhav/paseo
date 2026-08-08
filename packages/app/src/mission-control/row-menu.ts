import type { LifecycleRow } from "./lifecycle";

/**
 * Board row context-menu actions (spec "Board row context menu"). Pure so the
 * menu composition is unit-testable without mounting the row.
 */
export type BoardRowMenuAction =
  | "open"
  | "copy-reference"
  | "stop"
  | "mark-done"
  | "clear"
  | "archive";

export function resolveBoardRowMenuActions(row: LifecycleRow): BoardRowMenuAction[] {
  const actions: BoardRowMenuAction[] = ["open", "copy-reference"];
  if (row.bucket === "running") {
    // Running rows show Stop instead of Archive (spec).
    actions.push("stop");
    return actions;
  }
  if (row.bucket === "ready") {
    actions.push("mark-done");
  } else if (row.bucket === "done") {
    actions.push("clear");
  }
  actions.push("archive");
  return actions;
}

/**
 * Clipboard reference for the Commander ("Copy reference"): `Name — Title —
 * agentId`. Missing name/title slots drop their separator so the reference
 * never reads " — " between empty fields.
 */
export function buildAgentReference(agent: {
  name?: string | null;
  title?: string | null;
  id: string;
}): string {
  const name = agent.name?.trim() || null;
  const title = agent.title?.trim() || null;
  const parts = [name ?? title ?? agent.id];
  if (title && title !== parts[0]) {
    parts.push(title);
  }
  if (parts[0] !== agent.id) {
    parts.push(agent.id);
  }
  return parts.join(" — ");
}
