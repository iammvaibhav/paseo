import { describe, expect, it } from "vitest";
import { resolveHostScope, resolveProjectScope, resolveWorkspaceScope } from "./scope";

describe("resolveWorkspaceScope", () => {
  it("builds a workspace scope", () => {
    const scope = resolveWorkspaceScope({
      serverId: "srv_1",
      workspaceId: "ws_1",
      cwd: "/Users/vaibhav/paseo",
      displayName: "paseo",
      projectId: "prj_1",
    });
    expect(scope).toEqual({
      kind: "workspace",
      serverId: "srv_1",
      workspaceId: "ws_1",
      projectId: "prj_1",
      displayName: "paseo",
      cwds: ["/Users/vaibhav/paseo"],
      workspaceIds: ["ws_1"],
    });
  });

  it("rejects empty cwd", () => {
    expect(() =>
      resolveWorkspaceScope({
        serverId: "srv_1",
        workspaceId: "ws_1",
        cwd: "  ",
      }),
    ).toThrow(/cwd/i);
  });
});

describe("resolveProjectScope", () => {
  it("keeps non-archived workspaces and dedupes", () => {
    const scope = resolveProjectScope({
      serverId: "srv_1",
      projectId: "prj_1",
      displayName: "Paseo",
      workspaces: [
        { id: "ws_1", cwd: "/repo/a", projectId: "prj_1" },
        { id: "ws_2", cwd: "/repo/b", projectId: "prj_1", archived: true },
        { id: "ws_3", cwd: "/repo/a", projectId: "prj_1" },
        { id: "ws_4", cwd: "/other", projectId: "prj_other" },
        { id: "ws_5", cwd: "  ", projectId: "prj_1" },
      ],
    });
    expect(scope.kind).toBe("project");
    expect(scope.cwds).toEqual(["/repo/a"]);
    expect(scope.workspaceIds).toEqual(["ws_1", "ws_3"]);
    expect(scope.projectId).toBe("prj_1");
  });

  it("includes workspaces without projectId when already filtered by caller", () => {
    const scope = resolveProjectScope({
      serverId: "srv_1",
      projectId: "prj_1",
      workspaces: [{ id: "ws_1", cwd: "/repo" }],
    });
    expect(scope.cwds).toEqual(["/repo"]);
    expect(scope.workspaceIds).toEqual(["ws_1"]);
  });
});

describe("resolveHostScope", () => {
  it("returns empty cwds for host-wide search", () => {
    const scope = resolveHostScope({ serverId: "srv_1", displayName: "Mac" });
    expect(scope).toEqual({
      kind: "host",
      serverId: "srv_1",
      displayName: "Mac",
      cwds: [],
      workspaceIds: [],
    });
  });
});
