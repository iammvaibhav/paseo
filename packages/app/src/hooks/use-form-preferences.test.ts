import { describe, expect, it } from "vitest";

import {
  buildFavoriteModelKey,
  isFavoriteModel,
  mergeProviderPreferences,
  resolveFavoriteModels,
  toggleFavoriteModel,
} from "./use-form-preferences";

describe("mergeProviderPreferences", () => {
  it("stores the selected model for a provider", () => {
    expect(
      mergeProviderPreferences({
        preferences: {},
        provider: "claude",
        updates: { model: "claude-opus-4-6" },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-opus-4-6",
        },
      },
    });
  });

  it("merges thinking preferences by model without dropping existing entries", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
              thinkingByModel: {
                "claude-sonnet-4-6": "medium",
              },
            },
          },
        },
        provider: "claude",
        updates: {
          thinkingByModel: {
            "claude-opus-4-6": "high",
          },
        },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
          thinkingByModel: {
            "claude-sonnet-4-6": "medium",
            "claude-opus-4-6": "high",
          },
        },
      },
    });
  });

  it("merges feature values without dropping existing entries", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4",
              featureValues: {
                fast_mode: true,
              },
            },
          },
        },
        provider: "codex",
        updates: {
          featureValues: {
            plan_mode: true,
          },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          featureValues: {
            fast_mode: true,
            plan_mode: true,
          },
        },
      },
    });
  });
});

describe("favorite model preferences", () => {
  it("builds a stable favorite key from provider and model", () => {
    expect(buildFavoriteModelKey({ provider: "claude", modelId: "sonnet-4.6" })).toBe(
      "claude:sonnet-4.6",
    );
  });

  it("adds a model to global favorites when no host is provided", () => {
    expect(
      toggleFavoriteModel({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
            },
          },
        },
        provider: "codex",
        modelId: "gpt-5.4",
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
        },
      },
      favoriteModels: [
        {
          provider: "codex",
          modelId: "gpt-5.4",
        },
      ],
    });
  });

  it("stores favorites per host and leaves sibling hosts alone", () => {
    const afterHostA = toggleFavoriteModel({
      preferences: {},
      provider: "codex",
      modelId: "gpt-5.4",
      serverId: "srv_a",
    });
    const afterHostB = toggleFavoriteModel({
      preferences: afterHostA,
      provider: "claude",
      modelId: "sonnet-4.6",
      serverId: "srv_b",
    });

    expect(resolveFavoriteModels(afterHostB, "srv_a")).toEqual([
      { provider: "codex", modelId: "gpt-5.4" },
    ]);
    expect(resolveFavoriteModels(afterHostB, "srv_b")).toEqual([
      { provider: "claude", modelId: "sonnet-4.6" },
    ]);
    expect(afterHostB.favoriteModels).toBeUndefined();
  });

  it("seeds a host list from legacy global favorites on first toggle", () => {
    const next = toggleFavoriteModel({
      preferences: {
        favoriteModels: [{ provider: "codex", modelId: "gpt-5.4" }],
      },
      provider: "claude",
      modelId: "sonnet-4.6",
      serverId: "srv_a",
    });

    expect(resolveFavoriteModels(next, "srv_a")).toEqual([
      { provider: "codex", modelId: "gpt-5.4" },
      { provider: "claude", modelId: "sonnet-4.6" },
    ]);
    // Legacy global list remains for hosts that have not been customized yet.
    expect(next.favoriteModels).toEqual([{ provider: "codex", modelId: "gpt-5.4" }]);
  });

  it("removes a host favorite when toggled again", () => {
    expect(
      toggleFavoriteModel({
        preferences: {
          favoriteModelsByHost: {
            srv_a: [{ provider: "codex", modelId: "gpt-5.4" }],
          },
        },
        provider: "codex",
        modelId: "gpt-5.4",
        serverId: "srv_a",
      }),
    ).toEqual({
      favoriteModelsByHost: {
        srv_a: [],
      },
    });
  });

  it("reports whether a model is favorited for a host", () => {
    const preferences = {
      favoriteModels: [{ provider: "codex", modelId: "gpt-5.4" }],
      favoriteModelsByHost: {
        srv_a: [{ provider: "claude", modelId: "sonnet-4.6" }],
      },
    };

    expect(
      isFavoriteModel({
        preferences,
        provider: "claude",
        modelId: "sonnet-4.6",
        serverId: "srv_a",
      }),
    ).toBe(true);

    expect(
      isFavoriteModel({
        preferences,
        provider: "codex",
        modelId: "gpt-5.4",
        serverId: "srv_a",
      }),
    ).toBe(false);

    // Host without its own list falls back to legacy global favorites.
    expect(
      isFavoriteModel({
        preferences,
        provider: "codex",
        modelId: "gpt-5.4",
        serverId: "srv_b",
      }),
    ).toBe(true);
  });
});
