import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null, labels: {} })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent", labels: {} })).toEqual({
      kind: "layout-only",
    });
  });

  it("never archives the Commander (paseo.mission-control label)", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        labels: { "paseo.mission-control": "commander" },
      }),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});
