import { describe, expect, it } from "vitest";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import { compactTokens, formatTurnMetricsLine } from "./turn-metrics";

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
