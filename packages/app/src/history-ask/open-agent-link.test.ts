import { describe, expect, it } from "vitest";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { parseHistoryAskAgentOpenUrl } from "./open-agent-link-parse";

describe("parseHistoryAskAgentOpenUrl", () => {
  it("parses paseo deep links", () => {
    const href = buildAgentDeepLink({ serverId: "srv_local", agentId: "agt_abc" });
    expect(parseHistoryAskAgentOpenUrl(href)).toEqual({
      serverId: "srv_local",
      agentId: "agt_abc",
    });
  });

  it("parses path-only /h/…/agent/… links", () => {
    expect(parseHistoryAskAgentOpenUrl("/h/srv_1/agent/agt_xyz")).toEqual({
      serverId: "srv_1",
      agentId: "agt_xyz",
    });
  });

  it("rejects unrelated URLs", () => {
    expect(parseHistoryAskAgentOpenUrl("https://example.com")).toBeNull();
    expect(parseHistoryAskAgentOpenUrl("file:///tmp/x")).toBeNull();
  });
});
