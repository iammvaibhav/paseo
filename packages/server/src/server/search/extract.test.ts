import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { TOOL_OUTPUT_MAX_CHARS, extractChunks } from "./extract.js";

function toolCall(
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "c1",
    name: "tool",
    detail,
    status: "running",
    error: null,
  };
}

describe("extractChunks", () => {
  it("indexes user and assistant messages", () => {
    const chunks = extractChunks([
      { item: { type: "user_message", text: "fix the stripe webhook" } },
      { item: { type: "assistant_message", text: "opened PR 12" } },
    ]);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["fix the stripe webhook", "opened PR 12"]);
  });

  it("indexes shell command output where PR URLs live", () => {
    const chunks = extractChunks([
      {
        item: toolCall({
          type: "shell",
          command: "gh pr create",
          output: "https://github.com/getpaseo/paseo/pull/12",
        }),
      },
    ]);
    expect(chunks.some((chunk) => chunk.text.includes("gh pr create"))).toBe(true);
    expect(chunks.some((chunk) => chunk.text.includes("/pull/12"))).toBe(true);
  });

  it("truncates a single tool output at 8 KB", () => {
    const output = "x".repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const chunks = extractChunks([
      { item: toolCall({ type: "shell", command: "cat huge.log", output }) },
    ]);
    const joined = chunks.map((chunk) => chunk.text).join("\n");
    expect(joined.length).toBeLessThan(output.length);
    expect(joined).toContain("…");
    expect(joined).toContain("x".repeat(32));
  });

  it("indexes a read path but not the file body", () => {
    const chunks = extractChunks([
      {
        item: toolCall({
          type: "read",
          filePath: "src/billing.ts",
          content: "secret stripe key material",
        }),
      },
    ]);
    const joined = chunks.map((chunk) => chunk.text).join("\n");
    expect(joined).toContain("src/billing.ts");
    expect(joined).not.toContain("secret stripe key material");
  });

  it("indexes a write path but not the file body", () => {
    const chunks = extractChunks([
      {
        item: toolCall({
          type: "write",
          filePath: "src/new-file.ts",
          content: "export const hidden = true",
        }),
      },
    ]);
    const joined = chunks.map((chunk) => chunk.text).join("\n");
    expect(joined).toContain("src/new-file.ts");
    expect(joined).not.toContain("export const hidden");
  });
});
