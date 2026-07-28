import { describe, expect, it } from "vitest";
import { buildHistoryAskBrief } from "./brief";
import { buildHistorySearchRoots } from "./paths";
import { resolveHostScope, resolveWorkspaceScope } from "./scope";

describe("buildHistoryAskBrief", () => {
  it("includes role, scope, paths, search steps, and question", () => {
    const scope = resolveWorkspaceScope({
      serverId: "srv_local",
      workspaceId: "ws_1",
      cwd: "/Users/vaibhav/paseo",
      displayName: "paseo",
      projectId: "prj_1",
    });
    const roots = buildHistorySearchRoots(scope.cwds);
    const brief = buildHistoryAskBrief({
      scope,
      question: "When did we add webhooks?",
      roots,
    });

    expect(brief).toContain("# History Ask");
    expect(brief).toContain("allow-all");
    expect(brief).toContain("read-only");
    expect(brief).toContain("## SCOPE");
    expect(brief).toContain("`workspace`");
    expect(brief).toContain("`srv_local`");
    expect(brief).toContain("/Users/vaibhav/paseo");
    expect(brief).toContain("## PASEO CATALOG");
    expect(brief).toContain("~/.paseo/agents/");
    expect(brief).toContain("## NATIVE TRANSCRIPT PATHS");
    expect(brief).toContain("~/.claude/projects/");
    expect(brief).toContain("~/.grok/sessions/");
    expect(brief).toContain("Codex");
    expect(brief).toContain("## HOW TO SEARCH");
    expect(brief).toContain("includeArchived");
    expect(brief).toContain("agent id");
    expect(brief).toContain("## USER QUESTION");
    expect(brief).toContain("When did we add webhooks?");
  });

  it("describes host-wide scope without cwd filter", () => {
    const scope = resolveHostScope({ serverId: "srv_1", displayName: "Host" });
    const brief = buildHistoryAskBrief({
      scope,
      question: "find auth work",
      roots: buildHistorySearchRoots([]),
    });
    expect(brief).toContain("host-wide");
    expect(brief).toContain("all on this host");
  });
});
