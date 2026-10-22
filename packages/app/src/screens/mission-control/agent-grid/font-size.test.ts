import { describe, expect, it } from "vitest";
import { resolveAgentGridZoom } from "./font-size";

describe("resolveAgentGridZoom", () => {
  it("is identity when the grid size matches content size", () => {
    expect(resolveAgentGridZoom(15, 15)).toBe(1);
  });

  it("scales tile text independently of the full-agent content size", () => {
    expect(resolveAgentGridZoom(12, 15)).toBeCloseTo(0.8);
    expect(resolveAgentGridZoom(18, 15)).toBeCloseTo(1.2);
  });

  it("never divides by zero", () => {
    expect(resolveAgentGridZoom(12, 0)).toBe(12);
  });
});
