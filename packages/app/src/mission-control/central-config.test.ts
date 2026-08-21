import { describe, expect, it } from "vitest";
import { resolveMissionControlCentralConfig } from "./central-config-resolver";

describe("resolveMissionControlCentralConfig voiceNodeUrl (M9 knob)", () => {
  it("defaults voiceNodeUrl to null when unset", () => {
    expect(resolveMissionControlCentralConfig({}).voiceNodeUrl).toBeNull();
    expect(resolveMissionControlCentralConfig(null).voiceNodeUrl).toBeNull();
  });

  it("resolves a stored voiceNodeUrl (settings field patch round-trips)", () => {
    const resolved = resolveMissionControlCentralConfig({
      voiceNodeUrl: "ws://127.0.0.1:8787/ws",
    });
    expect(resolved.voiceNodeUrl).toBe("ws://127.0.0.1:8787/ws");
  });

  it("keeps unrelated keys intact when voiceNodeUrl is present", () => {
    const resolved = resolveMissionControlCentralConfig({
      commanderHost: "iammvaibhav",
      hindsightUrl: "http://hindsight.test:8890",
      voiceNodeUrl: "ws://127.0.0.1:8787/ws",
    });
    expect(resolved).toMatchObject({
      commanderHost: "iammvaibhav",
      hindsightUrl: "http://hindsight.test:8890",
      voiceNodeUrl: "ws://127.0.0.1:8787/ws",
    });
  });
});

describe("resolveMissionControlCentralConfig voiceMode (M9 knob)", () => {
  it("defaults voiceMode to relay when unset", () => {
    expect(resolveMissionControlCentralConfig({}).voiceMode).toBe("relay");
    expect(resolveMissionControlCentralConfig(null).voiceMode).toBe("relay");
  });

  it("resolves a stored voiceMode (settings dropdown patch round-trips)", () => {
    const resolved = resolveMissionControlCentralConfig({ voiceMode: "direct" });
    expect(resolved.voiceMode).toBe("direct");
  });

  it("keeps unrelated keys intact when voiceMode is present", () => {
    const resolved = resolveMissionControlCentralConfig({
      commanderHost: "iammvaibhav",
      voiceNodeUrl: "ws://127.0.0.1:8787/ws",
      voiceMode: "direct",
    });
    expect(resolved).toMatchObject({
      commanderHost: "iammvaibhav",
      voiceNodeUrl: "ws://127.0.0.1:8787/ws",
      voiceMode: "direct",
    });
  });
});
