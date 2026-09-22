import { describe, expect, it } from "vitest";
import {
  resolveExplicitWorkspacePlacement,
  type CreateAgentCommandDependencies,
} from "./create.js";

function deps(
  workspace: { cwd: string; archivedAt: string | null } | null,
): CreateAgentCommandDependencies {
  return {
    getWorkspace: async () => workspace,
  } as unknown as CreateAgentCommandDependencies;
}

describe("resolveExplicitWorkspacePlacement", () => {
  it("places the agent in the workspace directory when the caller passed no cwd", async () => {
    // Regression: the caller's cwd defaults to the daemon's process.cwd() ("/"),
    // which filed spawned agents outside the workspace and hid them from the board.
    const placement = await resolveExplicitWorkspacePlacement({
      dependencies: deps({ cwd: "/Users/vaibhav/paseo", archivedAt: null }),
      workspaceId: "wks_1",
      callerRequestedCwd: undefined,
      fallbackCwd: "/",
    });

    expect(placement).toEqual({ workspaceId: "wks_1", cwd: "/Users/vaibhav/paseo" });
  });

  it("keeps an explicitly requested cwd so a spawn can target a subdirectory", async () => {
    const placement = await resolveExplicitWorkspacePlacement({
      dependencies: deps({ cwd: "/repo", archivedAt: null }),
      workspaceId: "wks_1",
      callerRequestedCwd: "/repo/packages/app",
      fallbackCwd: "/repo/packages/app",
    });

    expect(placement.cwd).toBe("/repo/packages/app");
  });

  it("refuses an archived workspace instead of creating an agent the sweep archives", async () => {
    await expect(
      resolveExplicitWorkspacePlacement({
        dependencies: deps({ cwd: "/repo", archivedAt: "2026-08-01T00:00:00.000Z" }),
        workspaceId: "wks_gone",
        callerRequestedCwd: undefined,
        fallbackCwd: "/",
      }),
    ).rejects.toThrow("Workspace wks_gone is archived");
  });

  it("refuses a workspace that does not exist", async () => {
    await expect(
      resolveExplicitWorkspacePlacement({
        dependencies: deps(null),
        workspaceId: "wks_missing",
        callerRequestedCwd: undefined,
        fallbackCwd: "/",
      }),
    ).rejects.toThrow("Workspace wks_missing not found");
  });

  it("falls back to the caller cwd when no workspace lookup is wired", async () => {
    const placement = await resolveExplicitWorkspacePlacement({
      dependencies: {} as CreateAgentCommandDependencies,
      workspaceId: "wks_1",
      callerRequestedCwd: undefined,
      fallbackCwd: "/tmp/x",
    });

    expect(placement).toEqual({ workspaceId: "wks_1", cwd: "/tmp/x" });
  });
});
