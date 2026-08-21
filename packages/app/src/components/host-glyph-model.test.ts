import { describe, expect, it } from "vitest";
import {
  hostGlyphStatusSignal,
  normalizeHostGlyphOverride,
  resolveHostGlyphPresentation,
} from "./host-glyph-model";
import { IDENTITY_COLOR_NAMES, deriveIdentityColorName } from "@/styles/identity-colors";

describe("normalizeHostGlyphOverride", () => {
  it("returns null for non-objects and empty overrides", () => {
    expect(normalizeHostGlyphOverride(undefined)).toBeNull();
    expect(normalizeHostGlyphOverride(null)).toBeNull();
    expect(normalizeHostGlyphOverride("initials")).toBeNull();
    expect(normalizeHostGlyphOverride([])).toBeNull();
    expect(normalizeHostGlyphOverride({})).toBeNull();
    expect(normalizeHostGlyphOverride({ initials: "  " })).toBeNull();
  });

  it("keeps valid initials and identity colors", () => {
    expect(normalizeHostGlyphOverride({ initials: "AB", color: "indigo" })).toEqual({
      initials: "AB",
      color: "indigo",
    });
  });

  it("drops an unknown color but keeps the initials", () => {
    expect(normalizeHostGlyphOverride({ initials: "AB", color: "chartreuse" })).toEqual({
      initials: "AB",
    });
  });

  it("drops an unknown color entirely, leaving an empty override as null", () => {
    expect(normalizeHostGlyphOverride({ color: "not-a-color" })).toBeNull();
  });

  it("trims and bounds initials to two code points (emoji counts as one)", () => {
    expect(normalizeHostGlyphOverride({ initials: "  ab  " })).toEqual({ initials: "ab" });
    expect(normalizeHostGlyphOverride({ initials: "abc" })).toEqual({ initials: "ab" });
    expect(normalizeHostGlyphOverride({ initials: "🚀" })).toEqual({ initials: "🚀" });
    expect(normalizeHostGlyphOverride({ initials: "🚀🚀" })).toEqual({ initials: "🚀🚀" });
  });
});

describe("resolveHostGlyphPresentation", () => {
  it("is deterministic: same serverId always resolves the same color", () => {
    const first = resolveHostGlyphPresentation({ serverId: "mac-pro", label: "Mac Pro" });
    const second = resolveHostGlyphPresentation({ serverId: "mac-pro", label: "Mac Pro" });
    expect(first.colorName).toBe(second.colorName);
    expect(IDENTITY_COLOR_NAMES).toContain(first.colorName);
  });

  it("defaults to the label initial and the deterministic color", () => {
    const presentation = resolveHostGlyphPresentation({ serverId: "srv-1", label: "Build box" });
    expect(presentation.glyph).toBe("B");
    expect(presentation.colorName).toBe(deriveIdentityColorName("srv-1"));
  });

  it("uses the caller-passed label as the default initial (spec: alias initial)", () => {
    // The glyph component passes the host alias (when set) as `label`, so the
    // default initial follows the alias rather than the raw hostname.
    const withAlias = resolveHostGlyphPresentation({ serverId: "srv-1", label: "work server" });
    expect(withAlias.glyph).toBe("W");
    const withoutAlias = resolveHostGlyphPresentation({ serverId: "srv-1", label: "macbook" });
    expect(withoutAlias.glyph).toBe("M");
  });

  it("falls back to the serverId when the label is blank", () => {
    expect(resolveHostGlyphPresentation({ serverId: "blrofc3", label: "" }).glyph).toBe("B");
  });

  it("override initials win over the alias/label initial", () => {
    const presentation = resolveHostGlyphPresentation({
      serverId: "srv-1",
      label: "work server",
      override: { initials: "WS" },
    });
    expect(presentation.glyph).toBe("WS");
  });

  it("keeps an emoji override verbatim", () => {
    const presentation = resolveHostGlyphPresentation({
      serverId: "srv-1",
      label: "work server",
      override: { initials: "🚀" },
    });
    expect(presentation.glyph).toBe("🚀");
  });

  it("override color wins over the deterministic color", () => {
    const overrideColor = IDENTITY_COLOR_NAMES.find(
      (name) => name !== deriveIdentityColorName("srv-1"),
    )!;
    const presentation = resolveHostGlyphPresentation({
      serverId: "srv-1",
      label: "work server",
      override: { color: overrideColor },
    });
    expect(presentation.colorName).toBe(overrideColor);
  });

  it("ignores an invalid override color, keeping the deterministic one", () => {
    const presentation = resolveHostGlyphPresentation({
      serverId: "srv-1",
      label: "work server",
      override: { color: "chartreuse" },
    });
    expect(presentation.colorName).toBe(deriveIdentityColorName("srv-1"));
  });
});

describe("hostGlyphStatusSignal", () => {
  it("maps connection status to the same signals the status dot used", () => {
    expect(hostGlyphStatusSignal("online")).toBe("none");
    expect(hostGlyphStatusSignal("connecting")).toBe("warning");
    expect(hostGlyphStatusSignal("offline")).toBe("danger");
    expect(hostGlyphStatusSignal("error")).toBe("danger");
    expect(hostGlyphStatusSignal("idle")).toBe("danger");
  });
});
