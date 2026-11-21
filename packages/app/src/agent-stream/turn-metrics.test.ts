import { describe, expect, it } from "vitest";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import {
  buildSecondOpinionPrompt,
  collectTurnEditedFiles,
  compactTokens,
  formatTurnMetricsLine,
  truncate,
} from "./turn-metrics";

describe("compactTokens", () => {
  it("formats token counts compactly", () => {
    expect(compactTokens(0)).toBe("0");
    expect(compactTokens(512)).toBe("512");
    expect(compactTokens(1400)).toBe("1.4k");
    expect(compactTokens(12600)).toBe("12.6k");
    expect(compactTokens(1000000)).toBe("1m");
  });

  it("handles negative and non-finite values safely", () => {
    expect(compactTokens(-10)).toBe("0");
    expect(compactTokens(NaN)).toBe("0");
    expect(compactTokens(Infinity)).toBe("0");
  });
});

describe("truncate", () => {
  it("leaves short strings intact", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("appends ellipsis when exceeding limit", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });
});

describe("formatTurnMetricsLine", () => {
  it("returns null when no fields are present", () => {
    expect(formatTurnMetricsLine({})).toBeNull();
    expect(formatTurnMetricsLine({ fallbackDurationMs: 0 })).toBeNull();
    expect(formatTurnMetricsLine({ fallbackDurationMs: null })).toBeNull();
  });

  it("renders fallback duration when metrics are absent", () => {
    const line = formatTurnMetricsLine({ fallbackDurationMs: 1250 });
    expect(line).toBe("Worked for 1s");
  });

  it("renders all known fields matching contract parity", () => {
    const metrics: AgentUsage = {
      durationMs: 10000,
      model: "claude-3-7-sonnet",
      outputTokens: 512,
      inputTokens: 1400,
      cachedInputTokens: 12600,
      cacheWriteTokens: 0,
    };

    const line = formatTurnMetricsLine({ metrics });
    expect(line).toBe(
      "Worked for 10s · claude-3-7-sonnet · 51 tok/s · cache 90% · in 1.4k · out 512 · cached 12.6k",
    );
  });

  it("omits unknown / optional fields cleanly", () => {
    const metrics: AgentUsage = {
      durationMs: 4000,
      outputTokens: 100,
      // no model, no cache tokens, no input tokens
    };

    const line = formatTurnMetricsLine({ metrics });
    expect(line).toBe("Worked for 4s · 25 tok/s · out 100");
  });

  it("handles 0% cache hit when cached tokens are 0", () => {
    const metrics: AgentUsage = {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200,
      durationMs: 2000,
    };

    const line = formatTurnMetricsLine({ metrics });
    expect(line).toContain("cache 0%");
  });

  it("omits tok/s when duration is zero to avoid division by zero", () => {
    const metrics: AgentUsage = {
      outputTokens: 500,
      durationMs: 0,
    };

    const line = formatTurnMetricsLine({ metrics });
    expect(line).not.toContain("tok/s");
    expect(line).toContain("out 500");
  });
});

describe("collectTurnEditedFiles", () => {
  it("collects edited and written file paths from tool calls, deduplicating them", () => {
    const items: StreamItem[] = [
      {
        kind: "user_message",
        id: "u1",
        text: "Please update the app",
        timestamp: new Date(),
      },
      {
        kind: "tool_call",
        id: "t1",
        timestamp: new Date(),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "c1",
            name: "edit",
            status: "completed",
            error: null,
            detail: {
              type: "edit",
              filePath: "src/index.ts",
            },
          },
        },
      },
      {
        kind: "tool_call",
        id: "t2",
        timestamp: new Date(),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "c2",
            name: "write",
            status: "completed",
            error: null,
            detail: {
              type: "write",
              filePath: "src/utils.ts",
            },
          },
        },
      },
      {
        kind: "tool_call",
        id: "t3",
        timestamp: new Date(),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "c3",
            name: "edit",
            status: "completed",
            error: null,
            detail: {
              type: "edit",
              filePath: "src/index.ts", // duplicate
            },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "a1",
        text: "Done updating",
        timestamp: new Date(),
      },
    ];

    const files = collectTurnEditedFiles({
      items,
      startIndex: 4,
    });

    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/utils.ts");
    expect(files).toHaveLength(2);
  });
});

describe("buildSecondOpinionPrompt", () => {
  it("constructs bounded critique prompt with all sections", () => {
    const prompt = buildSecondOpinionPrompt({
      provider: "claude",
      userText: "Fix the race condition in the auth store",
      assistantText: "I resolved the race condition by adding a lock.",
      files: ["packages/app/src/auth.ts"],
    });

    expect(prompt).toContain(
      "Give a second opinion on work claude just finished in this same working copy.",
    );
    expect(prompt).toContain("## User request\nFix the race condition in the auth store");
    expect(prompt).toContain(
      "## What claude reported\nI resolved the race condition by adding a lock.",
    );
    expect(prompt).toContain("## Files it edited\npackages/app/src/auth.ts");
  });

  it("handles missing user message, summary, and files gracefully", () => {
    const prompt = buildSecondOpinionPrompt({
      provider: "claude",
    });

    expect(prompt).toContain("## User request\n(not recorded)");
    expect(prompt).toContain("## What claude reported\n(no written summary — inspect the files)");
    expect(prompt).toContain("## Files it edited\n(none recorded on this turn)");
  });

  it("bounds long text with truncation", () => {
    const prompt = buildSecondOpinionPrompt({
      provider: "claude",
      userText: "a".repeat(1000),
      assistantText: "b".repeat(10000),
    });

    expect(prompt.length).toBeLessThan(5000);
    expect(prompt).toContain("…");
  });
});
