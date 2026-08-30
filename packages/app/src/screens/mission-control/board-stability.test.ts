import { describe, expect, it } from "vitest";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { LifecycleBucketGroup, LifecycleRow } from "@/mission-control/lifecycle";
import {
  buildStableBoardItems,
  computeScrollAnchor,
  resolveScrollAnchorAdjustment,
  type BoardItem,
} from "./board-items";

function resolveTestReviewState(bucket: "running" | "ready" | "done") {
  if (bucket === "ready") {
    return "ready";
  }
  if (bucket === "done") {
    return "done";
  }
  return "none";
}

function makeTestRow(id: string, bucket: "running" | "ready" | "done"): LifecycleRow {
  return {
    bucket,
    reviewState: resolveTestReviewState(bucket),
    verdict: null,
    doneReason: null,
    lastReportHeadline: "headline",
    lastEventAt: null,
    pendingProposalCount: 0,
    dormant: false,
    withinWindow: true,
    snapshotTitle: null,
    snapshotName: null,
    snapshotShortDescription: null,
    snapshotStoppedBy: null,
    sortTime: 1_700_000_000_000,
    agent: {
      id,
      name: `Agent ${id}`,
      title: `Agent ${id}`,
      shortDescription: null,
      status: bucket === "running" ? "running" : "idle",
      attentionReason: null,
      lastActivityAt: new Date(1_700_000_000_000),
      lastUserMessageAt: null,
      createdAt: new Date(1_700_000_000_000),
      archivedAt: null,
      workspaceId: "ws-1",
      cwd: "/repo",
      labels: {},
      pendingPermissionCount: 0,
      provider: "claude",
      serverId: "local",
      serverLabel: "Local",
      bucket,
    },
  };
}

const TEST_HOSTS = [{ serverId: "local", label: "Local" }];
const TEST_STATUSES = new Map<string, HostRuntimeConnectionStatus>([["local", "online"]]);

function findAgentItem(items: readonly BoardItem[], agentId: string) {
  for (const item of items) {
    if (item.kind === "agent" && item.row.agent.id === agentId) {
      return item;
    }
  }
  return undefined;
}

function findBucketItem(items: readonly BoardItem[], bucket: string) {
  for (const item of items) {
    if (item.kind === "bucket" && item.bucket === bucket) {
      return item;
    }
  }
  return undefined;
}

describe("Mission Control Board List Stability & Scroll Anchoring", () => {
  it("preserves exact item reference identity for untouched rows across bucket transitions", () => {
    const runningRow1 = makeTestRow("agent-1", "running");
    const runningRow2 = makeTestRow("agent-2", "running");
    const readyRow = makeTestRow("agent-3", "ready");

    const initialGroups: LifecycleBucketGroup[] = [
      { bucket: "running", rows: [runningRow1, runningRow2] },
      { bucket: "ready", rows: [readyRow] },
    ];

    const firstPass = buildStableBoardItems({
      groups: initialGroups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: true,
    });

    expect(firstPass.items).toHaveLength(5);
    const initialRunningItem1 = findAgentItem(firstPass.items, "agent-1");
    const initialRunningItem2 = findAgentItem(firstPass.items, "agent-2");
    const initialRunningBucket = findBucketItem(firstPass.items, "running");
    const initialReadyItem = findAgentItem(firstPass.items, "agent-3");

    expect(initialRunningItem1).toBeDefined();
    expect(initialRunningItem2).toBeDefined();
    expect(initialRunningBucket).toBeDefined();

    // Now move agent-3 from "ready" to "done"
    const doneRow = makeTestRow("agent-3", "done");
    const nextGroups: LifecycleBucketGroup[] = [
      { bucket: "running", rows: [runningRow1, runningRow2] },
      { bucket: "done", rows: [doneRow] },
    ];

    const secondPass = buildStableBoardItems({
      groups: nextGroups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: true,
      itemCache: firstPass.itemCache,
      prevItems: firstPass.items,
    });

    const nextRunningItem1 = findAgentItem(secondPass.items, "agent-1");
    const nextRunningItem2 = findAgentItem(secondPass.items, "agent-2");
    const nextRunningBucket = findBucketItem(secondPass.items, "running");
    const nextDoneItem = findAgentItem(secondPass.items, "agent-3");

    // INVARIANT: Untouched items MUST keep exact reference identity (===)
    expect(nextRunningItem1).toBe(initialRunningItem1);
    expect(nextRunningItem2).toBe(initialRunningItem2);
    expect(nextRunningBucket).toBe(initialRunningBucket);

    // Transitioned item is updated in its new bucket
    expect(nextDoneItem).not.toBe(initialReadyItem);
    expect(nextDoneItem?.kind).toBe("agent");
    if (nextDoneItem?.kind === "agent") {
      expect(nextDoneItem.row.bucket).toBe("done");
    }
  });

  it("reuses the exact same items array reference when no data changes", () => {
    const runningRow1 = makeTestRow("agent-1", "running");
    const groups: LifecycleBucketGroup[] = [{ bucket: "running", rows: [runningRow1] }];

    const pass1 = buildStableBoardItems({
      groups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: false,
    });

    const pass2 = buildStableBoardItems({
      groups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: false,
      itemCache: pass1.itemCache,
      prevItems: pass1.items,
    });

    // Array reference identity is preserved
    expect(pass2.items).toBe(pass1.items);
  });
  it("fails reference identity without item caching (regression test for before-fix behavior)", () => {
    const runningRow = makeTestRow("agent-1", "running");
    const groups: LifecycleBucketGroup[] = [{ bucket: "running", rows: [runningRow] }];

    const pass1 = buildStableBoardItems({
      groups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: false,
    });

    // Without cache (prior behavior), a fresh object is allocated every pass
    const unmemoizedPass = buildStableBoardItems({
      groups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: false,
    });

    expect(findAgentItem(unmemoizedPass.items, "agent-1")).not.toBe(
      findAgentItem(pass1.items, "agent-1"),
    );
    expect(unmemoizedPass.items).not.toBe(pass1.items);

    // With cache (fixed behavior), reference identity is preserved
    const memoizedPass = buildStableBoardItems({
      groups,
      hosts: TEST_HOSTS,
      connectionStatuses: TEST_STATUSES,
      doneExpanded: false,
      itemCache: pass1.itemCache,
      prevItems: pass1.items,
    });
    expect(findAgentItem(memoizedPass.items, "agent-1")).toBe(
      findAgentItem(pass1.items, "agent-1"),
    );
    expect(memoizedPass.items).toBe(pass1.items);
  });

  it("captures first visible row intersecting container top when scrolled", () => {
    const containerTop = 100;
    const rows = [
      { key: "row-above", top: 20, bottom: 80 },
      { key: "row-visible-1", top: 90, bottom: 140 },
      { key: "row-visible-2", top: 140, bottom: 190 },
    ];

    const anchor = computeScrollAnchor(containerTop, rows, 250);
    expect(anchor).toEqual({
      key: "row-visible-1",
      offset: -10,
    });
  });

  it("returns null when at top of list (scrollTop <= 0)", () => {
    const containerTop = 100;
    const rows = [{ key: "row-1", top: 100, bottom: 150 }];
    const anchor = computeScrollAnchor(containerTop, rows, 0);
    expect(anchor).toBeNull();
  });

  it("calculates exact delta when rows above are removed / layout shifts", () => {
    const containerTop = 100;
    const anchor = { key: "row-visible-1", offset: -10 };

    // After Ready items above are removed, the anchor row shifts up from 90 to 40
    const newRowTop = 40;
    const delta = resolveScrollAnchorAdjustment(containerTop, newRowTop, anchor);

    // newOffset = 40 - 100 = -60. delta = -60 - (-10) = -50
    expect(delta).toBe(-50);
  });

  it("ignores subpixel jitter <= 0.5px", () => {
    const containerTop = 100;
    const anchor = { key: "row-visible-1", offset: -10 };

    // Jitter: row top moves by 0.3px
    const newRowTop = 90.3;
    const delta = resolveScrollAnchorAdjustment(containerTop, newRowTop, anchor);
    expect(delta).toBe(0);
  });
});
