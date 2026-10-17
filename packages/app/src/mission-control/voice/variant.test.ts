import { describe, expect, it } from "vitest";
import { resolveComposerVoiceVariant } from "./variant";

describe("resolveComposerVoiceVariant (M9 composer swap gating)", () => {
  it("shows Commander Voice on web when voiceNodeUrl is set", () => {
    expect(
      resolveComposerVoiceVariant({ isWeb: true, voiceNodeUrl: "ws://127.0.0.1:8787/ws" }),
    ).toBe("commander");
  });

  it("falls back to stock when voiceNodeUrl is empty on web (feature hidden)", () => {
    expect(resolveComposerVoiceVariant({ isWeb: true, voiceNodeUrl: null })).toBe("stock");
    expect(resolveComposerVoiceVariant({ isWeb: true, voiceNodeUrl: "" })).toBe("stock");
    expect(resolveComposerVoiceVariant({ isWeb: true, voiceNodeUrl: "   " })).toBe("stock");
  });

  it("keeps stock voice mode on native even with a voice node configured", () => {
    expect(
      resolveComposerVoiceVariant({ isWeb: false, voiceNodeUrl: "ws://127.0.0.1:8787/ws" }),
    ).toBe("stock");
  });
});
