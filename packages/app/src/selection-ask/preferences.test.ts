import { describe, expect, it } from "vitest";
import {
  mergeSelectionAskPreference,
  parseFormPreferences,
  resolveEffectiveSelectionAskPreference,
} from "@/create-agent-preferences/preferences";
import type { FormPreferences } from "@/create-agent-preferences/preferences";

describe("selection ask model preferences", () => {
  it("stores the choice globally regardless of scope", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(next.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
    expect(next.byWorkspace).toBeUndefined();
    expect(next.byProject).toBeUndefined();
  });

  it("persists with only a workspace id (no project key)", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5" },
      scope: { workspaceId: "ws-1" },
    });
    expect(next.selectionAsk).toEqual({ provider: "codex", model: "gpt-5" });
    expect(next.byWorkspace).toBeUndefined();
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

  it("merges partial updates into the global choice", () => {
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
    expect(second.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
    expect(second.byWorkspace).toBeUndefined();
    expect(second.byProject).toBeUndefined();
  });

  it("shares the last choice across projects", () => {
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
    expect(next.selectionAsk?.provider).toBe("anthropic");
    expect(next.byProject).toBeUndefined();
  });

  it("ignores empty values and does not store empty fields", () => {
    const next = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "  ", model: "gpt-5", thinkingOptionId: "" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(next.selectionAsk).toEqual({ model: "gpt-5" });
  });

  it("clears a stored field globally when passed empty", () => {
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
    expect(cleared.selectionAsk).toEqual({ provider: "codex", thinkingOptionId: "high" });
  });

  it("prunes legacy scoped Ask copies on write", () => {
    const next = mergeSelectionAskPreference({
      preferences: {
        byWorkspace: { "ws-1": { selectionAsk: { provider: "codex", model: "old" } } },
        byProject: {
          "proj-1": { selectionAsk: { provider: "codex", model: "old" }, isolation: "worktree" },
        },
      },
      selectionAsk: { provider: "anthropic", model: "new" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    expect(next.selectionAsk).toEqual({ provider: "anthropic", model: "new" });
    expect(next.byWorkspace).toBeUndefined();
    expect(next.byProject).toEqual({ "proj-1": { isolation: "worktree" } });
  });

  it("round-trips through the parser so writes never drop the choice", () => {
    const merged = mergeSelectionAskPreference({
      preferences: {},
      selectionAsk: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
      scope: { workspaceId: "ws-1", projectKey: "proj-1" },
    });
    const parsed = parseFormPreferences(merged);
    expect(parsed.selectionAsk).toEqual({
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
    });
  });

  it("resolves the global choice regardless of scope", () => {
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
    ).toEqual({ provider: "openai", model: "gpt-5", thinkingOptionId: "low" });
    expect(resolveEffectiveSelectionAskPreference(preferences, { projectKey: "proj-1" })).toEqual({
      provider: "openai",
      model: "gpt-5",
      thinkingOptionId: "low",
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
