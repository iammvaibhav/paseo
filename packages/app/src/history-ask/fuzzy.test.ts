import { describe, expect, it } from "vitest";
import { filterByHistoryAskFuzzy, matchesHistoryAskFuzzy } from "./fuzzy";

describe("matchesHistoryAskFuzzy", () => {
  const agent = {
    title: "Implement webhooks",
    provider: "claude",
    cwd: "/Users/vaibhav/paseo",
    labels: { "paseo.history-ask": "1", surface: "workspace" },
    id: "agt_abc",
    serverLabel: "Mac",
  };

  it("matches empty query", () => {
    expect(matchesHistoryAskFuzzy(agent, "")).toBe(true);
    expect(matchesHistoryAskFuzzy(agent, "   ")).toBe(true);
  });

  it("requires every token to match some field", () => {
    expect(matchesHistoryAskFuzzy(agent, "webhook claude")).toBe(true);
    expect(matchesHistoryAskFuzzy(agent, "webhook codex")).toBe(false);
    expect(matchesHistoryAskFuzzy(agent, "paseo mac")).toBe(true);
    expect(matchesHistoryAskFuzzy(agent, "history-ask")).toBe(true);
  });

  it("filters a list", () => {
    const items = [agent, { title: "Other", provider: "codex", cwd: "/tmp" }];
    expect(filterByHistoryAskFuzzy(items, "webhook").map((item) => item.title)).toEqual([
      "Implement webhooks",
    ]);
  });
});
