import { describe, expect, it } from "vitest";
import { buildTurnItems } from "./turns.js";

const source = {
  agentId: "a1",
  agentTitle: "Fix login",
  agentName: "Rex",
  host: "dev",
  project: "paseo",
};

describe("buildTurnItems", () => {
  it("makes one item per prompt with the agent's replies and no tool output", () => {
    const items = buildTurnItems(source, [
      {
        role: "user_message",
        ts: 1,
        text: '<paseo-mode name="solo">\nDo it.\n</paseo-mode>\n\nfix the login',
      },
      { role: "tool_call", ts: 2, text: "bash: npm test" },
      { role: "assistant_message", ts: 3, text: "Fixed the redirect." },
      { role: "user_message", ts: 4, text: "now the logout" },
      { role: "assistant_message", ts: 5, text: "Done." },
    ]);
    expect(items.map((i) => [i.id, i.text])).toEqual([
      ["turn:a1:0:0", "User: fix the login\nAgent: Fixed the redirect."],
      ["turn:a1:3:0", "User: now the logout\nAgent: Done."],
    ]);
    expect(items[0]).toMatchObject({ kind: "turn", host: "dev", project: "paseo", ts: 1 });
  });

  it("keeps ids stable when later turns are appended", () => {
    const first = [
      { role: "user_message", ts: 1, text: "a" },
      { role: "assistant_message", ts: 2, text: "b" },
    ];
    const before = buildTurnItems(source, first).map((i) => i.id);
    const after = buildTurnItems(source, [
      ...first,
      { role: "user_message", ts: 3, text: "c" },
    ]).map((i) => i.id);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("splits a long turn and repeats the prompt on every piece", () => {
    const items = buildTurnItems(source, [
      { role: "user_message", ts: 1, text: "explain" },
      { role: "assistant_message", ts: 2, text: "x".repeat(13_000) },
    ]);
    expect(items.map((i) => i.id)).toEqual(["turn:a1:0:0", "turn:a1:0:1", "turn:a1:0:2"]);
    for (const item of items) expect(item.text.startsWith("User: explain\nAgent: ")).toBe(true);
  });
});
