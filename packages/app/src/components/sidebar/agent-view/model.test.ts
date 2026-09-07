import { describe, expect, it } from "vitest";
import type {
  LifecycleBucket,
  LifecycleBucketGroup,
  LifecycleRow,
} from "@/mission-control/lifecycle";
import {
  agentWorkspaceKey,
  buildSidebarAgentViewSections,
  SIDEBAR_AGENT_VIEW_BUCKET_ORDER,
} from "./model";

function makeRow(input: {
  id: string;
  serverId?: string;
  workspaceId?: string | null;
  bucket?: LifecycleBucket;
}): LifecycleRow {
  return {
    agent: {
      id: input.id,
      serverId: input.serverId ?? "server-1",
      workspaceId: input.workspaceId !== undefined ? input.workspaceId : "workspace-1",
    } as LifecycleRow["agent"],
    bucket: input.bucket ?? "running",
  } as LifecycleRow;
}

function makeGroup(bucket: LifecycleBucket, rows: LifecycleRow[]): LifecycleBucketGroup {
  return {
    bucket,
    rows,
  };
}

function bucketsOf(sections: readonly { bucket: string }[]): string[] {
  return sections.map((section) => section.bucket);
}

describe("sidebar agent view model", () => {
  describe("agentWorkspaceKey", () => {
    it("formats serverId and workspaceId as serverId:workspaceId", () => {
      expect(agentWorkspaceKey("host-a", "ws-123")).toBe("host-a:ws-123");
    });
  });

  describe("buildSidebarAgentViewSections", () => {
    const emptyMapping = new Map<string, string>();

    it("enforces canonical bucket order and drops dormant bucket", () => {
      const needsYouRow = makeRow({ id: "1", bucket: "needs_you" });
      const runningRow = makeRow({ id: "2", bucket: "running" });
      const readyRow = makeRow({ id: "3", bucket: "ready" });
      const doneRow = makeRow({ id: "4", bucket: "done" });
      const dormantRow = makeRow({ id: "5", bucket: "dormant" });

      // Pass in mixed/reverse order including dormant
      const groups: LifecycleBucketGroup[] = [
        makeGroup("done", [doneRow]),
        makeGroup("dormant", [dormantRow]),
        makeGroup("running", [runningRow]),
        makeGroup("needs_you", [needsYouRow]),
        makeGroup("ready", [readyRow]),
      ];

      const sections = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: true,
      });

      expect(bucketsOf(sections)).toEqual(SIDEBAR_AGENT_VIEW_BUCKET_ORDER);
      expect(sections[0].rows).toEqual([needsYouRow]);
      expect(sections[1].rows).toEqual([runningRow]);
      expect(sections[2].rows).toEqual([readyRow]);
      expect(sections[3].rows).toEqual([doneRow]);
    });

    it("drops done section unless showDone is true", () => {
      const runningRow = makeRow({ id: "r1", bucket: "running" });
      const doneRow = makeRow({ id: "d1", bucket: "done" });
      const groups = [makeGroup("running", [runningRow]), makeGroup("done", [doneRow])];

      // showDone = false -> done bucket omitted
      const withoutDone = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: false,
      });
      expect(bucketsOf(withoutDone)).toEqual(["running"]);
      expect(withoutDone[0].rows).toEqual([runningRow]);

      // showDone = true -> done bucket included
      const withDone = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: true,
      });
      expect(bucketsOf(withDone)).toEqual(["running", "done"]);
      expect(withDone[1].rows).toEqual([doneRow]);
    });

    it("filters rows by hostFilters allowlist", () => {
      const host1Row = makeRow({ id: "h1", serverId: "srv-1" });
      const host2Row = makeRow({ id: "h2", serverId: "srv-2" });
      const groups = [makeGroup("running", [host1Row, host2Row])];

      // Filter to srv-1 only
      const filtered = buildSidebarAgentViewSections({
        groups,
        hostFilters: ["srv-1"],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: false,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].rows).toEqual([host1Row]);

      // Empty hostFilters allows all hosts
      const all = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: false,
      });
      expect(all[0].rows).toEqual([host1Row, host2Row]);
    });

    it("filters rows by projectFilters and drops unmapped rows when filter is active", () => {
      const projectMapping = new Map<string, string>([
        [agentWorkspaceKey("srv-1", "ws-alpha"), "project-alpha"],
        [agentWorkspaceKey("srv-1", "ws-beta"), "project-beta"],
      ]);

      const matchingRow = makeRow({ id: "match", serverId: "srv-1", workspaceId: "ws-alpha" });
      const otherProjectRow = makeRow({ id: "other", serverId: "srv-1", workspaceId: "ws-beta" });
      const unknownWorkspaceRow = makeRow({
        id: "unmapped",
        serverId: "srv-1",
        workspaceId: "ws-unknown",
      });
      const noWorkspaceRow = makeRow({ id: "none", serverId: "srv-1", workspaceId: null });

      const groups = [
        makeGroup("running", [matchingRow, otherProjectRow, unknownWorkspaceRow, noWorkspaceRow]),
      ];

      // With projectFilter active, only matching mapped project is kept;
      // other projects, unknown workspaces, and null workspaceId rows are dropped.
      const filtered = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: ["project-alpha"],
        projectViewKeyByWorkspaceKey: projectMapping,
        showDone: false,
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].rows).toEqual([matchingRow]);

      // Without projectFilter active, all rows are kept (even unmapped/null)
      const unfiltered = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: projectMapping,
        showDone: false,
      });
      expect(unfiltered[0].rows).toEqual([
        matchingRow,
        otherProjectRow,
        unknownWorkspaceRow,
        noWorkspaceRow,
      ]);
    });

    it("preserves incoming row order within each bucket", () => {
      const row1 = makeRow({ id: "agent-z" });
      const row2 = makeRow({ id: "agent-a" });
      const row3 = makeRow({ id: "agent-m" });
      const groups = [makeGroup("running", [row1, row2, row3])];

      const sections = buildSidebarAgentViewSections({
        groups,
        hostFilters: [],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: false,
      });

      expect(sections[0].rows).toEqual([row1, row2, row3]);
    });

    it("omits empty sections from the output", () => {
      const runningRow = makeRow({ id: "r1", serverId: "srv-1" });
      // Needs you has rows, but all belong to srv-2
      const needsYouRow = makeRow({ id: "ny1", serverId: "srv-2", bucket: "needs_you" });

      const groups = [
        makeGroup("needs_you", [needsYouRow]),
        makeGroup("running", [runningRow]),
        makeGroup("ready", []), // completely empty group
      ];

      const sections = buildSidebarAgentViewSections({
        groups,
        hostFilters: ["srv-1"],
        projectFilters: [],
        projectViewKeyByWorkspaceKey: emptyMapping,
        showDone: false,
      });

      // needs_you is omitted because all rows filtered out; ready is omitted because 0 rows
      expect(bucketsOf(sections)).toEqual(["running"]);
      expect(sections[0].rows).toEqual([runningRow]);
    });
  });
});
