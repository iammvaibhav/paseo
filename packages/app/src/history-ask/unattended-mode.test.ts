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

  it("uses paseo-allow-all for ACP-style providers", () => {
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

  it("defaults ACP providers without modes to paseo-allow-all", () => {
    expect(resolveUnattendedModeId("grok")).toBe("paseo-allow-all");
    expect(resolveUnattendedModeId("cursor")).toBe("paseo-allow-all");
  });
});
