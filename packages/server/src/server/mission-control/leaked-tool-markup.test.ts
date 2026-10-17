import { describe, expect, it } from "vitest";
import { detectLeakedToolCalls, hasLeakedMutatingToolCall } from "./service";

describe("detectLeakedToolCalls", () => {
  it("names every Commander tool written as literal markup", () => {
    const text =
      'Dispatching.\n<fleet_create_agent host="macbook" provider="omp/x" cwd="/repo" />\n<post_answer headline="done" />';
    expect(detectLeakedToolCalls(text).sort()).toEqual(["fleet_create_agent", "post_answer"]);
  });

  it("ignores prose that only mentions a tool name", () => {
    expect(detectLeakedToolCalls("I will call fleet_create_agent now.")).toEqual([]);
  });
});

describe("hasLeakedMutatingToolCall", () => {
  it("is true for a leaked dispatch that never ran", () => {
    expect(hasLeakedMutatingToolCall('<fleet_create_agent host="local" />')).toBe(true);
    expect(hasLeakedMutatingToolCall('<fleet_send_prompt agentId="a" />')).toBe(true);
    expect(hasLeakedMutatingToolCall('<fleet_rename_agent_title agentId="a" />')).toBe(true);
  });

  it("is false for a leaked read-only or answer tool", () => {
    // These leak as text too, but nothing was supposed to change on the fleet,
    // so the answer-card path still applies after the markup is stripped.
    expect(hasLeakedMutatingToolCall('<post_answer headline="x" />')).toBe(false);
    expect(hasLeakedMutatingToolCall("<fleet_list_agents />")).toBe(false);
  });

  it("is false for ordinary prose", () => {
    expect(hasLeakedMutatingToolCall("Spawned a worker on blrofc3.")).toBe(false);
  });
});
