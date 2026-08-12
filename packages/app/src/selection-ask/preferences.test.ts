import { describe, expect, it } from "vitest";
import {
  mergeSelectionAskPreference,
  parseFormPreferences,
  resolveEffectiveSelectionAskPreference,
} from "@/create-agent-preferences/preferences";
import type { FormPreferences } from "@/create-agent-preferences/preferences";

describe("selection ask model preferences", () => {
  it("stores the choice under the project scope", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { projectKey: "proj-1" },
    });
    expect(next.byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
  });

  it("merges partial updates without clobbering siblings", () => {
    const first = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5" },
      scope: { projectKey: "proj-1" },
    });
    const second = mergeSelectionAskPreference({
      preferences: first,
      selectionAsk: { thinkingOptionId: "low" },
      scope: { projectKey: "proj-1" },
    });
    expect(second.byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
  });

  it("keeps sibling projects isolated", () => {
    const seeded = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex" },
      scope: { projectKey: "proj-1" },
    });
    const next = mergeSelectionAskPreference({
      preferences: seeded,
      selectionAsk: { provider: "anthropic" },
      scope: { projectKey: "proj-2" },
    });
    expect(next.byProject?.["proj-1"]?.selectionAsk?.provider).toBe("codex");
    expect(next.byProject?.["proj-2"]?.selectionAsk?.provider).toBe("anthropic");
  });

  it("ignores empty values and does not store empty fields", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "  ", model: "gpt-5", thinkingOptionId: "" },
      scope: { projectKey: "proj-1" },
    });
    expect(next.byProject?.["proj-1"]?.selectionAsk).toEqual({ model: "gpt-5" });
  });

  it("does not write when no project key is known", () => {
    const next = mergeSelectionAskPreference({
      preferences: { provider: "codex" },
      selectionAsk: { model: "gpt-5" },
      scope: { projectKey: null },
    });
    expect(next).toEqual({ provider: "codex" });
  });

  it("round-trips through the parser so writes never drop the choice", () => {
    const merged = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { projectKey: "proj-1" },
    });
    expect(parseFormPreferences(merged).byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
  });

  it("resolves the remembered choice for a project", () => {
    const preferences: FormPreferences = {
      byProject: {
        "proj-1": {
          selectionAsk: { provider: "openai", model: "gpt-5", thinkingOptionId: "low" },
        },
      },
    };
    expect(resolveEffectiveSelectionAskPreference(preferences, { projectKey: "proj-1" })).toEqual({
      provider: "openai",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
  });

  it("resolves to an empty choice for projects without one", () => {
    expect(resolveEffectiveSelectionAskPreference({}, { projectKey: "proj-1" })).toEqual({});
    expect(resolveEffectiveSelectionAskPreference({}, { projectKey: null })).toEqual({});
  });
});
