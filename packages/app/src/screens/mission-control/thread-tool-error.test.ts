import { describe, expect, it } from "vitest";
import type { AgentToolCallData } from "@/types/stream";
import { readDispatchToolResultError } from "./thread-tool-error";

function dispatchCall(overrides: Partial<AgentToolCallData>): AgentToolCallData {
  return {
    provider: "omp",
    callId: "call-1",
    name: "fleet_create_agent",
    status: "completed",
    error: null,
    detail: {
      type: "unknown",
      input: { host: "work", provider: "anthropic/claude", initialPrompt: "fix it" },
      output: null,
    },
    ...overrides,
  };
}

describe("readDispatchToolResultError", () => {
  it("returns the error text for a structured success:false result", () => {
    const data = dispatchCall({
      detail: {
        type: "unknown",
        input: { host: "work" },
        output: {
          content: [],
          details: { success: false, error: "Provider anthropic is not configured" },
        },
      },
    });
    expect(readDispatchToolResultError(data)).toBe("Provider anthropic is not configured");
  });

  it("accepts ok:false with a message", () => {
    const data = dispatchCall({
      detail: {
        type: "unknown",
        input: { host: "work" },
        output: { content: [], details: { ok: false, message: "schema rejected" } },
      },
    });
    expect(readDispatchToolResultError(data)).toBe("schema rejected");
  });

  it("returns null for a successful dispatch (no success-shaped-header regression)", () => {
    const data = dispatchCall({
      detail: {
        type: "unknown",
        input: { host: "work" },
        output: { content: [], details: { success: true, agentId: "agent-7" } },
      },
    });
    expect(readDispatchToolResultError(data)).toBeNull();
  });

  it("returns null when the result carries no failure signal", () => {
    expect(readDispatchToolResultError(dispatchCall({}))).toBeNull();
  });
});
