import { describe, expect, it } from "vitest";
import { resolveHistoryAskLaunchCwd } from "./resolve-launch-cwd";
import { resolveHostScope, resolveWorkspaceScope } from "./scope";

describe("resolveHistoryAskLaunchCwd", () => {
  it("prefers preferredCwd then scope cwds", () => {
    const scope = resolveWorkspaceScope({
      serverId: "srv",
      workspaceId: "ws",
      cwd: "/from-scope",
    });
    expect(
      resolveHistoryAskLaunchCwd({
        scope,
        preferredCwd: " /pref ",
        workspaceCwds: ["/ws"],
        historyAgentCwds: ["/hist"],
      }),
    ).toBe("/pref");
    expect(
      resolveHistoryAskLaunchCwd({
        scope,
        workspaceCwds: ["/ws"],
        historyAgentCwds: ["/hist"],
      }),
    ).toBe("/from-scope");
  });

  it("for host-wide scope falls back to workspace then history agent cwds", () => {
    const scope = resolveHostScope({ serverId: "srv", displayName: "Mac" });
    expect(scope.cwds).toEqual([]);
    expect(
      resolveHistoryAskLaunchCwd({
        scope,
        workspaceCwds: ["", " /repo/a "],
        historyAgentCwds: ["/hist"],
      }),
    ).toBe("/repo/a");
    expect(
      resolveHistoryAskLaunchCwd({
        scope,
        workspaceCwds: [],
        historyAgentCwds: ["/Users/me/project"],
      }),
    ).toBe("/Users/me/project");
    expect(resolveHistoryAskLaunchCwd({ scope })).toBeNull();
  });
});
