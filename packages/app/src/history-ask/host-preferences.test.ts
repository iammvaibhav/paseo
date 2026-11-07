import { describe, expect, it } from "vitest";
import {
  parseHistoryAskHostPreferences,
  resolveHistoryAskHostSelection,
  setHistoryAskHostSelection,
} from "./host-preferences";

describe("history-ask host preferences", () => {
  it("parses and resolves per-host selection", () => {
    const prefs = parseHistoryAskHostPreferences({
      byHost: {
        srv_a: { provider: "claude", model: "sonnet" },
        srv_b: { provider: "codex" },
      },
    });
    expect(resolveHistoryAskHostSelection(prefs, "srv_a")).toEqual({
      provider: "claude",
      model: "sonnet",
    });
    expect(resolveHistoryAskHostSelection(prefs, "srv_b")).toEqual({
      provider: "codex",
    });
    expect(resolveHistoryAskHostSelection(prefs, "missing")).toEqual({});
  });

  it("updates one host without clobbering others", () => {
    const base = parseHistoryAskHostPreferences({
      byHost: { srv_a: { provider: "claude", model: "sonnet" } },
    });
    const next = setHistoryAskHostSelection(base, "srv_b", {
      provider: "grok",
      model: "grok-4",
    });
    expect(next.byHost?.srv_a).toEqual({ provider: "claude", model: "sonnet" });
    expect(next.byHost?.srv_b).toEqual({ provider: "grok", model: "grok-4" });
  });
});
