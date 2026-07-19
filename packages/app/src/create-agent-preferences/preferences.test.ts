import { describe, expect, it } from "vitest";
import { CreateAgentPreferencesService } from "./service";
import {
  mergeCreateAgentSelectionPreferences,
  mergeProviderPreferences,
  mergeProviderPreferencesWithScope,
  parseFormPreferences,
  resolveEffectiveFormPreferences,
} from "./preferences";
import { FakeCreateAgentPreferenceStorage } from "./test-utils/fake-preference-storage";

describe("create agent preferences", () => {
  it("keeps the selected mode after saving model and thinking", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const modelWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { model: "gpt-5.5", thinkingByModel: { "gpt-5.5": "high" } },
      }),
    );
    await storage.nextWrite();

    const modeWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { mode: "full-access" },
      }),
    );

    expect(storage.pendingWriteCount()).toBe(1);
    storage.finishOldestWrite();
    await modelWrite;

    await storage.nextWrite();
    storage.finishOldestWrite();
    await modeWrite;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          thinkingByModel: { "gpt-5.5": "high" },
          mode: "full-access",
        },
      },
    });
  });

  it("flushes the full create-agent selection into provider preferences", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const saveSelection = preferences.update((current) =>
      mergeCreateAgentSelectionPreferences({
        preferences: current,
        provider: "codex",
        modelId: "gpt-5.5",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    );

    await storage.nextWrite();
    storage.finishOldestWrite();
    await saveSelection;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
          featureValues: { fast_mode: true },
        },
      },
    });
  });

  it("does not erase a saved mode when a later partial update has no mode", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.5",
              mode: "full-access",
              thinkingByModel: { "gpt-5.5": "high" },
            },
          },
        },
        provider: "codex",
        updates: {
          model: "gpt-5.6",
          mode: undefined,
          thinkingByModel: undefined,
          featureValues: undefined,
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.6",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
        },
      },
    });
  });

  it("loads invalid stored preferences as empty preferences", () => {
    expect(parseFormPreferences({ providerPreferences: { codex: { mode: 42 } } })).toEqual({});
  });

  it("persists and reloads the workspace isolation choice", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      isolation: "worktree",
    });
  });

  it("treats stored preferences without an isolation choice as undefined", () => {
    expect(parseFormPreferences({ provider: "codex" }).isolation).toBeUndefined();
  });

  it("rejects an unknown isolation value as invalid stored preferences", () => {
    expect(parseFormPreferences({ provider: "codex", isolation: "sandbox" })).toEqual({});
  });

  it("resolves workspace model over project and global", () => {
    const preferences = {
      provider: "claude",
      providerPreferences: {
        claude: { model: "global-model" },
      },
      byProject: {
        "proj-a": {
          provider: "claude",
          providerPreferences: {
            claude: { model: "project-model" },
          },
        },
      },
      byWorkspace: {
        "ws-1": {
          provider: "codex",
          providerPreferences: {
            codex: { model: "workspace-model" },
          },
        },
      },
    };

    expect(
      resolveEffectiveFormPreferences(preferences, {
        workspaceId: "ws-1",
        projectKey: "proj-a",
      }),
    ).toEqual({
      ...preferences,
      provider: "codex",
      // Workspace provider wins; per-provider models layer global → project → workspace.
      providerPreferences: {
        claude: { model: "project-model" },
        codex: { model: "workspace-model" },
      },
    });
  });

  it("falls back to project selection when the workspace has none", () => {
    const preferences = {
      provider: "claude",
      providerPreferences: {
        claude: { model: "global-model" },
      },
      byProject: {
        "proj-a": {
          provider: "codex",
          providerPreferences: {
            codex: { model: "project-model" },
          },
        },
      },
    };

    expect(
      resolveEffectiveFormPreferences(preferences, {
        workspaceId: "ws-new",
        projectKey: "proj-a",
      }),
    ).toEqual({
      ...preferences,
      provider: "codex",
      providerPreferences: {
        claude: { model: "global-model" },
        codex: { model: "project-model" },
      },
    });
  });

  it("writes model selection into workspace, project, and global scopes", () => {
    expect(
      mergeProviderPreferencesWithScope({
        preferences: {},
        provider: "claude",
        updates: { model: "claude-opus-4-6" },
        scope: { workspaceId: "ws-1", projectKey: "proj-a" },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: { model: "claude-opus-4-6" },
      },
      byProject: {
        "proj-a": {
          provider: "claude",
          providerPreferences: {
            claude: { model: "claude-opus-4-6" },
          },
        },
      },
      byWorkspace: {
        "ws-1": {
          provider: "claude",
          providerPreferences: {
            claude: { model: "claude-opus-4-6" },
          },
        },
      },
    });
  });

  it("keeps sibling workspace selections isolated", () => {
    const afterWorkspaceA = mergeProviderPreferencesWithScope({
      preferences: {},
      provider: "claude",
      updates: { model: "opus" },
      scope: { workspaceId: "ws-a", projectKey: "proj" },
    });
    const afterWorkspaceB = mergeProviderPreferencesWithScope({
      preferences: afterWorkspaceA,
      provider: "claude",
      updates: { model: "sonnet" },
      scope: { workspaceId: "ws-b", projectKey: "proj" },
    });

    expect(
      resolveEffectiveFormPreferences(afterWorkspaceB, {
        workspaceId: "ws-a",
        projectKey: "proj",
      }).providerPreferences?.claude?.model,
    ).toBe("opus");
    expect(
      resolveEffectiveFormPreferences(afterWorkspaceB, {
        workspaceId: "ws-b",
        projectKey: "proj",
      }).providerPreferences?.claude?.model,
    ).toBe("sonnet");
    // New workspace in the project inherits the last project-level choice.
    expect(
      resolveEffectiveFormPreferences(afterWorkspaceB, {
        workspaceId: "ws-new",
        projectKey: "proj",
      }).providerPreferences?.claude?.model,
    ).toBe("sonnet");
  });
});
