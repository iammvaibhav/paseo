import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(
      resolveCloseAgentTabPolicy({ parentAgentId: null, workspaceId: "wks_1", labels: {} }),
    ).toEqual({ kind: "archive-on-close" });
  });

  it("keeps nested subagent tab close layout-only (parent resolvable, not the Commander, same workspace)", () => {
    expect(
      resolveCloseAgentTabPolicy(
        { parentAgentId: "parent-agent", workspaceId: "wks_1", labels: {} },
        { workspaceId: "wks_1", labels: {} },
      ),
    ).toEqual({ kind: "layout-only" });
  });

  it("archives a Commander-dispatched worker whose parent record is not on this host", () => {
    // fleet_create_agent workers carry paseo.parent-agent-id pointing at a
    // Commander on another host. No parent record in this session, so the
    // worker is a root agent — the same test the sidebar uses for workspace
    // visibility — and its close archives like any other root agent.
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: "commander-remote",
        workspaceId: "wks_1",
        labels: { "paseo.parent-agent-id": "commander-remote" },
      }),
    ).toEqual({ kind: "archive-on-close" });
  });

  it("archives a Commander-dispatched worker whose parent IS on this host (the Commander's own host)", () => {
    // On the Commander's host the parent record resolves — and its labels
    // identify the Commander. Command parentage is not nesting: the worker
    // closes like a root agent even in the same workspace.
    expect(
      resolveCloseAgentTabPolicy(
        {
          parentAgentId: "commander-local",
          workspaceId: "wks_1",
          labels: { "paseo.parent-agent-id": "commander-local" },
        },
        { workspaceId: "wks_1", labels: { "paseo.mission-control": "commander" } },
      ),
    ).toEqual({ kind: "archive-on-close" });
  });

  it("keeps system-owned agents layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        workspaceId: "wks_1",
        labels: { "paseo.mission-control": "commander" },
      }),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});
