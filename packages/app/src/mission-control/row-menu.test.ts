import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { buildAgentReference, resolveBoardRowMenuActions } from "./row-menu";
import type { LifecycleRow } from "./lifecycle";

const REVIEW_STATE_BY_BUCKET: Record<LifecycleRow["bucket"], LifecycleRow["reviewState"]> = {
  done: "done",
  ready: "ready",
  needs_you: "none",
  running: "none",
  dormant: "none",
};

function makeRow(bucket: LifecycleRow["bucket"]): LifecycleRow {
  return {
    bucket,
    reviewState: REVIEW_STATE_BY_BUCKET[bucket],
    verdict: null,
    doneReason: null,
    lastReportHeadline: null,
    lastEventAt: null,
    pendingProposalCount: 0,
    dormant: bucket === "dormant",
    withinWindow: true,
    snapshotTitle: null,
    snapshotName: null,
    snapshotShortDescription: null,
    snapshotStoppedBy: null,
    sortTime: 0,
    agent: {
      id: "agent-1",
      serverId: "host-1",
      serverLabel: "Host 1",
      name: "Bob",
      title: "Fix login flow",
      status: "running",
      lastActivityAt: new Date("2026-08-08T00:00:00.000Z"),
      cwd: "/workspaces/paseo",
      workspaceId: "workspace-1",
      provider: "claude",
      pendingPermissionCount: 0,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      stoppedBy: null,
      archivedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      labels: {},
      projectPlacement: null,
    } as AggregatedAgent,
  };
}

describe("resolveBoardRowMenuActions", () => {
  it("running rows offer open, copy reference, and stop (no archive)", () => {
    expect(resolveBoardRowMenuActions(makeRow("running"))).toEqual([
      "open",
      "copy-reference",
      "stop",
    ]);
  });

  it("ready rows lead with mark done, then open, copy reference, and archive", () => {
    expect(resolveBoardRowMenuActions(makeRow("ready"))).toEqual([
      "mark-done",
      "open",
      "copy-reference",
      "archive",
    ]);
  });

  it("done rows offer clear and archive", () => {
    expect(resolveBoardRowMenuActions(makeRow("done"))).toEqual([
      "open",
      "copy-reference",
      "clear",
      "archive",
    ]);
  });

  it("needs-you and dormant rows offer archive but no stop", () => {
    for (const bucket of ["needs_you", "dormant"] as const) {
      expect(resolveBoardRowMenuActions(makeRow(bucket))).toEqual([
        "open",
        "copy-reference",
        "archive",
      ]);
    }
  });
});

describe("buildAgentReference", () => {
  it("formats Name — Title — agentId", () => {
    expect(buildAgentReference({ name: "Bob", title: "Fix login flow", id: "agent-1" })).toBe(
      "Bob — Fix login flow — agent-1",
    );
  });

  it("drops the title slot when title is missing", () => {
    expect(buildAgentReference({ name: "Bob", title: null, id: "agent-1" })).toBe("Bob — agent-1");
  });

  it("falls back to the title when the name is missing", () => {
    expect(buildAgentReference({ name: null, title: "Fix login flow", id: "agent-1" })).toBe(
      "Fix login flow — agent-1",
    );
  });

  it("falls back to the id when both are missing", () => {
    expect(buildAgentReference({ name: null, title: null, id: "agent-1" })).toBe("agent-1");
  });

  it("does not duplicate a title identical to the name", () => {
    expect(buildAgentReference({ name: "Bob", title: "Bob", id: "agent-1" })).toBe("Bob — agent-1");
  });
});
