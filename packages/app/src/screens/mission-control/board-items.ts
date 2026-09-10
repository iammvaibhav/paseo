import {
  LIFECYCLE_BUCKET_LABELS,
  type LifecycleBucket,
  type LifecycleBucketGroup,
  type LifecycleRow,
} from "@/mission-control/lifecycle";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export type BoardItem =
  | { kind: "bucket"; bucket: LifecycleBucket; label: string; count: number }
  | { kind: "agent"; row: LifecycleRow }
  | { kind: "offlineHost"; serverId: string; label: string };

export function itemKey(item: BoardItem): string {
  switch (item.kind) {
    case "bucket":
      return `bucket:${item.bucket}`;
    case "agent":
      return `agent:${item.row.agent.serverId}:${item.row.agent.id}`;
    case "offlineHost":
      return `offline:${item.serverId}`;
  }
}

export interface BuildBoardItemsInput {
  groups: readonly LifecycleBucketGroup[];
  hosts: readonly { serverId: string; label: string }[];
  connectionStatuses: ReadonlyMap<string, HostRuntimeConnectionStatus>;
  doneExpanded: boolean;
  itemCache?: Map<string, BoardItem>;
  prevItems?: readonly BoardItem[];
}

export interface BuildBoardItemsResult {
  items: BoardItem[];
  itemCache: Map<string, BoardItem>;
}

function buildBucketItem(
  group: LifecycleBucketGroup,
  prevCache: Map<string, BoardItem>,
): BoardItem {
  const bucketKey = `bucket:${group.bucket}`;
  const prev = prevCache.get(bucketKey);
  if (
    prev &&
    prev.kind === "bucket" &&
    prev.count === group.rows.length &&
    prev.label === LIFECYCLE_BUCKET_LABELS[group.bucket]
  ) {
    return prev;
  }
  return {
    kind: "bucket",
    bucket: group.bucket,
    label: LIFECYCLE_BUCKET_LABELS[group.bucket],
    count: group.rows.length,
  };
}

function buildAgentItem(row: LifecycleRow, prevCache: Map<string, BoardItem>): BoardItem {
  const agentKey = `agent:${row.agent.serverId}:${row.agent.id}`;
  const prev = prevCache.get(agentKey);
  if (prev && prev.kind === "agent" && prev.row === row) {
    return prev;
  }
  return { kind: "agent", row };
}

function buildOfflineHostItem(
  host: { serverId: string; label: string },
  prevCache: Map<string, BoardItem>,
): BoardItem {
  const offlineKey = `offline:${host.serverId}`;
  const prev = prevCache.get(offlineKey);
  if (prev && prev.kind === "offlineHost" && prev.label === host.label) {
    return prev;
  }
  return { kind: "offlineHost", serverId: host.serverId, label: host.label };
}

export function buildStableBoardItems(input: BuildBoardItemsInput): BuildBoardItemsResult {
  const { groups, hosts, connectionStatuses, doneExpanded, itemCache, prevItems } = input;
  const prevCache = itemCache ?? new Map<string, BoardItem>();
  const nextCache = new Map<string, BoardItem>();
  const boardItems: BoardItem[] = [];

  for (const group of groups) {
    const bucketItem = buildBucketItem(group, prevCache);
    nextCache.set(`bucket:${group.bucket}`, bucketItem);
    boardItems.push(bucketItem);

    if (group.bucket !== "done" || doneExpanded) {
      for (const row of group.rows) {
        const agentItem = buildAgentItem(row, prevCache);
        nextCache.set(`agent:${row.agent.serverId}:${row.agent.id}`, agentItem);
        boardItems.push(agentItem);
      }
    }
  }

  for (const host of hosts) {
    if (connectionStatuses.get(host.serverId) === "online") {
      continue;
    }
    const offlineItem = buildOfflineHostItem(host, prevCache);
    nextCache.set(`offline:${host.serverId}`, offlineItem);
    boardItems.push(offlineItem);
  }

  const isSame =
    prevItems &&
    boardItems.length === prevItems.length &&
    boardItems.every((item, i) => item === prevItems[i]);
  const stableItems = isSame ? (prevItems as BoardItem[]) : boardItems;

  return { items: stableItems, itemCache: nextCache };
}

export interface ScrollAnchor {
  key: string;
  offset: number;
}

export interface VisibleRowRect {
  key: string;
  top: number;
  bottom: number;
}

export function computeScrollAnchor(
  containerTop: number,
  rows: readonly VisibleRowRect[],
  scrollTop: number,
): ScrollAnchor | null {
  if (scrollTop <= 0) {
    return null;
  }
  const visible = rows.find((r) => r.bottom > containerTop + 1);
  if (!visible || !visible.key) {
    return null;
  }
  return {
    key: visible.key,
    offset: visible.top - containerTop,
  };
}

export function resolveScrollAnchorAdjustment(
  containerTop: number,
  newRowTop: number | null | undefined,
  anchor: ScrollAnchor | null,
): number {
  if (!anchor || newRowTop === null || newRowTop === undefined) {
    return 0;
  }
  const newOffset = newRowTop - containerTop;
  const delta = newOffset - anchor.offset;
  return Math.abs(delta) > 0.5 ? delta : 0;
}
