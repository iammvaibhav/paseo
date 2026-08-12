import { describe, expect, it } from "vitest";
import {
  mergeSelectionAskPreference,
  parseFormPreferences,
  resolveEffectiveSelectionAskPreference,
} from "@/create-agent-preferences/preferences";
import type { FormPreferences } from "@/create-agent-preferences/preferences";

describe("selection ask model preferences", () => {
  it("stores the choice across workspace, project, and global scopes", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(next.byWorkspace?.["ws-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
    expect(next.byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
    expect(next.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
  });

  it("persists with only a workspace id (no project key)", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5" },
      scope: { workspaceId: "ws-1" },
    });
    expect(next.byWorkspace?.["ws-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
    });
    expect(next.selectionAsk).toEqual({ provider: "codex", model: "gpt-5" });
    expect(next.byProject).toBeUndefined();
  });

  it("persists with no scope at all via the global fallback", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { model: "gpt-5" },
      scope: null,
    });
    expect(next.selectionAsk).toEqual({ model: "gpt-5" });
    expect(next.byWorkspace).toBeUndefined();
    expect(next.byProject).toBeUndefined();
  });

  it("merges partial updates without clobbering siblings in any scope", () => {
    const first = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    const second = mergeSelectionAskPreference({
      preferences: first,
      selectionAsk: { thinkingOptionId: "low" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(second.byWorkspace?.["ws-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
    expect(second.byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
    expect(second.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
  });

  it("keeps sibling projects isolated", () => {
    const seeded = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    const next = mergeSelectionAskPreference({
      preferences: seeded,
      selectionAsk: { provider: "anthropic" },
      scope: { workspaceId: "ws-1", projectKey: "proj-2" },
    });
    expect(next.byProject?.["proj-1"]?.selectionAsk?.provider).toBe("codex");
    expect(next.byProject?.["proj-2"]?.selectionAsk?.provider).toBe("anthropic");
    expect(next.selectionAsk?.provider).toBe("anthropic");
  });

  it("ignores empty values and does not store empty fields", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "  ", model: "gpt-5", thinkingOptionId: "" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(next.byWorkspace?.["ws-1"]?.selectionAsk).toEqual({ model: "gpt-5" });
    expect(next.byProject?.["proj-1"]?.selectionAsk).toEqual({ model: "gpt-5" });
    expect(next.selectionAsk).toEqual({ model: "gpt-5" });
  });

  it("clears a stored field in every scope when passed empty", () => {
    const seeded = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    const cleared = mergeSelectionAskPreference({
      preferences: seeded,
      selectionAsk: { model: "" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(cleared.byWorkspace?.["ws-1"]?.selectionAsk).toEqual({
      provider: "codex",
      thinkingOptionId: "high",
    });
    expect(cleared.byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      thinkingOptionId: "high",
    });
    expect(cleared.selectionAsk).toEqual({ provider: "codex", thinkingOptionId: "high" });
  });

  it("round-trips through the parser so writes never drop the choice", () => {
    const merged = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    const parsed = parseFormPreferences(merged);
    expect(parsed.byWorkspace?.["ws-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
    expect(parsed.byProject?.["proj-1"]?.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
    expect(parsed.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
  });

  it("resolves workspace over project over global", () => {
    const preferences: FormPreferences = {
      selectionAsk: { provider: "openai", model: "gpt-5", thinkingOptionId: "low" },
      byProject: {
        "proj-1": {
          selectionAsk: {
            provider: "anthropic",
            model: "claude-opus-4-6",
            thinkingOptionId: "high",
          },
        },
      },
      byWorkspace: {
        "ws-1": {
          selectionAsk: { provider: "codex", model: "gpt-5" },
        },
      },
    };
    expect(
      resolveEffectiveSelectionAskPreference(preferences, {
        workspaceId: "ws-1",
        projectKey: "proj-1",
      }),
    ).toEqual({ provider: "codex", model: "gpt-5" });
    expect(resolveEffectiveSelectionAskPreference(preferences, { projectKey: "proj-1" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      thinkingOptionId: "high",
    });
  });

  it("resolves project over global when set", () => {
    const preferences: FormPreferences = {
      selectionAsk: { provider: "openai", model: "gpt-5" },
      byProject: {
        "proj-1": {
          selectionAsk: { provider: "anthropic", model: "claude-opus-4-6" },
        },
      },
    };
    expect(resolveEffectiveSelectionAskPreference(preferences, { projectKey: "proj-1" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("falls back to the global choice when no scope has one", () => {
    const preferences: FormPreferences = {
      selectionAsk: { provider: "openai", model: "gpt-5" },
    };
    expect(resolveEffectiveSelectionAskPreference(preferences, { projectKey: "proj-1" })).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(resolveEffectiveSelectionAskPreference(preferences, {})).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(resolveEffectiveSelectionAskPreference(preferences, null)).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("resolves to an empty choice when nothing is stored", () => {
    expect(resolveEffectiveSelectionAskPreference({}, { projectKey: "proj-1" })).toEqual({});
    expect(resolveEffectiveSelectionAskPreference({}, { projectKey: null })).toEqual({});
  });
});
