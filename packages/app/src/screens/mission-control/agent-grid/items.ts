import type { LifecycleRow } from "@/mission-control/lifecycle";

/**
 * Agent Grid shows two sections: agents the user is watching run, and agents
 * whose run just finished and want review. Every other bucket (done, idle,
 * dormant) has no place in the grid.
 */
export type AgentGridSection = "running" | "ready" | "done";

export interface AgentGridItem {
  /** `${serverId}:${agentId}` — React key and identity. */
  key: string;
  section: AgentGridSection;
  row: LifecycleRow;
}

/**
 * A row counts as Running if it is actually running, or paused on a
 * permission mid-run (`needs_you` while the agent process is still
 * `running`) — the user wants to watch or approve that run, same as a
 * plain running row.
 */
export function resolveAgentGridSection(row: LifecycleRow): AgentGridSection | null {
  if (row.bucket === "running") {
    return "running";
  }
  if (row.bucket === "needs_you" && row.agent.status === "running") {
    return "running";
  }
  if (row.bucket === "ready") {
    return "ready";
  }
  return null;
}

/**
 * Run start instant, same source the agent window's elapsed timer reads:
 * only an open turn has a start; a closed/idle turn has none.
 */
export function agentGridRunStartMs(row: LifecycleRow): number | null {
  const { turn } = row.agent;
  return turn.phase === "open" ? (turn.startedAt?.getTime() ?? null) : null;
}

function rowKey(row: LifecycleRow): string {
  return `${row.agent.serverId}:${row.agent.id}`;
}

/** Tie-break for equal-rank rows: name asc, then serverId:id asc. */
function compareByNameThenKey(left: LifecycleRow, right: LifecycleRow): number {
  const leftName = left.agent.name ?? left.agent.title ?? left.agent.id;
  const rightName = right.agent.name ?? right.agent.title ?? right.agent.id;
  const nameCmp = leftName.localeCompare(rightName);
  if (nameCmp !== 0) {
    return nameCmp;
  }
  return rowKey(left).localeCompare(rowKey(right));
}

/** Running order: most recently started run first; a run with no known
 * start (null) sorts last. */
function compareRunning(left: LifecycleRow, right: LifecycleRow): number {
  const leftStart = agentGridRunStartMs(left);
  const rightStart = agentGridRunStartMs(right);
  if (leftStart !== rightStart) {
    if (leftStart === null) return 1;
    if (rightStart === null) return -1;
    return rightStart - leftStart;
  }
  return compareByNameThenKey(left, right);
}

/** Ready order: existing board convention, most recently ready first. */
function compareReady(left: LifecycleRow, right: LifecycleRow): number {
  if (left.sortTime !== right.sortTime) {
    return right.sortTime - left.sortTime;
  }
  return compareByNameThenKey(left, right);
}

/**
 * Filters + orders rows per the grid's Running-then-Ready convention. Pass
 * the previous result to keep identity: returns `prev` itself when keys,
 * order and row references are all unchanged; otherwise reuses unchanged
 * item objects (same key, same `row` reference, same section) so tiles keyed
 * by `key` keep their React instance across reorders.
 */
export function buildAgentGridItems(
  rows: readonly LifecycleRow[],
  prev?: readonly AgentGridItem[],
  snapshotKeys?: readonly string[] | null,
): AgentGridItem[] {
  const prevByKey = new Map<string, AgentGridItem>();
  if (prev) {
    for (const item of prev) {
      prevByKey.set(item.key, item);
    }
  }

  const items =
    snapshotKeys != null
      ? buildSnapshotGridItems(rows, snapshotKeys, prevByKey)
      : buildDynamicGridItems(rows, prevByKey);
  if (prev && prev.length === items.length && items.every((item, index) => item === prev[index])) {
    return prev as AgentGridItem[];
  }
  return items;
}

function buildItem(
  row: LifecycleRow,
  section: AgentGridSection,
  prevByKey: Map<string, AgentGridItem>,
): AgentGridItem {
  const key = rowKey(row);
  const prevItem = prevByKey.get(key);
  if (prevItem && prevItem.section === section && prevItem.row === row) {
    return prevItem;
  }
  return { key, section, row };
}

function buildSnapshotGridItems(
  rows: readonly LifecycleRow[],
  snapshotKeys: readonly string[],
  prevByKey: Map<string, AgentGridItem>,
): AgentGridItem[] {
  const items: AgentGridItem[] = [];
  const rowsByKey = new Map<string, LifecycleRow>();
  for (const row of rows) {
    rowsByKey.set(rowKey(row), row);
  }

  const seenKeys = new Set<string>();

  // 1. Snapshot order first
  for (const key of snapshotKeys) {
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const row = rowsByKey.get(key);
    if (!row || row.agent.archivedAt != null) {
      continue;
    }

    const activeSection = resolveAgentGridSection(row);
    if (activeSection) {
      items.push(buildItem(row, activeSection, prevByKey));
    } else if (row.bucket === "done") {
      items.push(buildItem(row, "done", prevByKey));
    }
  }

  // 2. Newcomers appended sorted (running sorted, then ready sorted)
  const newRunning: LifecycleRow[] = [];
  const newReady: LifecycleRow[] = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (seenKeys.has(key) || row.agent.archivedAt != null) {
      continue;
    }
    const section = resolveAgentGridSection(row);
    if (section === "running") {
      newRunning.push(row);
    } else if (section === "ready") {
      newReady.push(row);
    }
  }

  newRunning.sort(compareRunning);
  newReady.sort(compareReady);

  for (const row of newRunning) {
    items.push(buildItem(row, "running", prevByKey));
  }
  for (const row of newReady) {
    items.push(buildItem(row, "ready", prevByKey));
  }

  return items;
}

function buildDynamicGridItems(
  rows: readonly LifecycleRow[],
  prevByKey: Map<string, AgentGridItem>,
): AgentGridItem[] {
  const running: LifecycleRow[] = [];
  const ready: LifecycleRow[] = [];
  for (const row of rows) {
    if (row.agent.archivedAt != null) {
      continue;
    }
    const section = resolveAgentGridSection(row);
    if (section === "running") {
      running.push(row);
    } else if (section === "ready") {
      ready.push(row);
    }
  }
  running.sort(compareRunning);
  ready.sort(compareReady);

  const items: AgentGridItem[] = [];
  for (const row of running) {
    items.push(buildItem(row, "running", prevByKey));
  }
  for (const row of ready) {
    items.push(buildItem(row, "ready", prevByKey));
  }
  return items;
}
