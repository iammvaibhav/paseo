import { describe, expect, it } from "vitest";
import { resolveUnattendedModeId } from "./unattended-mode";

describe("resolveUnattendedModeId", () => {
  it("returns known modes for claude, codex, and copilot", () => {
    expect(resolveUnattendedModeId("claude")).toBe("bypassPermissions");
    expect(resolveUnattendedModeId("codex")).toBe("full-access");
    expect(resolveUnattendedModeId("copilot")).toBe("allow-all");
  });

  it("prefers known mode when present in available modes", () => {
    expect(
      resolveUnattendedModeId("claude", [
        { id: "default" },
        { id: "bypassPermissions", isUnattended: true },
      ]),
    ).toBe("bypassPermissions");
  });

  it("uses paseo-allow-all only when the host lists it", () => {
    expect(
      resolveUnattendedModeId("cursor", [
        { id: "agent" },
        { id: "paseo-allow-all", isUnattended: true },
      ]),
    ).toBe("paseo-allow-all");
  });

  it("falls back to first isUnattended mode", () => {
    expect(
      resolveUnattendedModeId("agy", [{ id: "safe" }, { id: "yolo", isUnattended: true }]),
    ).toBe("yolo");
  });

  it("omits mode when provider reports no modes (Available modes: none)", () => {
    // Grok / some ACP agents advertise an empty mode list; inventing
    // paseo-allow-all is rejected by create_agent validation.
    expect(resolveUnattendedModeId("grok", [])).toBeUndefined();
    expect(resolveUnattendedModeId("cursor", [])).toBeUndefined();
  });

  it("does not invent paseo-allow-all when modes are unknown", () => {
    expect(resolveUnattendedModeId("grok")).toBeUndefined();
    expect(resolveUnattendedModeId("cursor", null)).toBeUndefined();
  });
});
