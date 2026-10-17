import { describe, expect, it } from "vitest";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

describe("isWorkspaceRootAgent", () => {
  it("treats an agent with no parent as a root agent", () => {
    expect(isWorkspaceRootAgent({ parentAgentId: null, workspaceId: "wks_1" }, undefined)).toBe(
      true,
    );
  });

  it("treats a child in the parent's workspace as nested", () => {
    expect(
      isWorkspaceRootAgent({ parentAgentId: "p1", workspaceId: "wks_1" }, { workspaceId: "wks_1" }),
    ).toBe(false);
  });

  it("treats a child in a different workspace as a root agent", () => {
    expect(
      isWorkspaceRootAgent({ parentAgentId: "p1", workspaceId: "wks_2" }, { workspaceId: "wks_1" }),
    ).toBe(true);
  });

  it("treats a child whose parent is not on this host as a root agent", () => {
    // Mission Control dispatches carry paseo.parent-agent-id pointing at a
    // Commander on another host. With the parent unresolvable the agent used
    // to be hidden from its own workspace entirely.
    expect(isWorkspaceRootAgent({ parentAgentId: "p1", workspaceId: "wks_2" }, undefined)).toBe(
      true,
    );
  });
});
