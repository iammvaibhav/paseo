import { describe, expect, it } from "vitest";
import { stripAgentNamePrefix } from "./spawn-title.js";

describe("stripAgentNamePrefix", () => {
  it("drops a themed name the Commander prefixed onto the title", () => {
    // The daemon owns the identity chip (AgentNamingService). The Commander
    // was writing its own name into the title, so the UI showed two different
    // names for one agent: chip "Erwin", title "Dirac — paseo dev test agent".
    expect(stripAgentNamePrefix("Dirac — paseo dev test agent")).toBe("paseo dev test agent");
  });

  it("handles a plain hyphen separator", () => {
    expect(stripAgentNamePrefix("Fermi - paseo dev test agent")).toBe("paseo dev test agent");
  });

  it("keeps a title whose first word is not a pool name", () => {
    expect(stripAgentNamePrefix("Deploy — restart the fleet")).toBe("Deploy — restart the fleet");
  });

  it("keeps a title with no separator even when it starts with a pool name", () => {
    // "Curie benchmark" is a task description, not an identity prefix.
    expect(stripAgentNamePrefix("Curie benchmark")).toBe("Curie benchmark");
  });

  it("never empties a title that is only a name", () => {
    expect(stripAgentNamePrefix("Dirac")).toBe("Dirac");
    expect(stripAgentNamePrefix("Dirac — ")).toBe("Dirac — ");
  });

  it("leaves an empty or missing title alone", () => {
    expect(stripAgentNamePrefix("")).toBe("");
    expect(stripAgentNamePrefix(undefined)).toBeUndefined();
  });
});
