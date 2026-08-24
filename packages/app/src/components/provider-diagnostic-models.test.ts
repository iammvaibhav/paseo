import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

const piModel: AgentModelDefinition = {
  provider: "pi",
  id: "pi/model",
  label: "Pi Model",
};

const grokModel: AgentModelDefinition = {
  provider: "grok",
  id: "grok-build",
  label: "Grok Build",
};

function resolveModels(input: {
  serverId?: string;
  provider: string;
  currentModels?: AgentModelDefinition[];
  hiddenModels?: readonly string[];
  loading?: boolean;
  cache?: ProviderDiscoveredModelsCache | null;
}) {
  return resolveProviderDiscoveredModels({
    serverId: input.serverId ?? "local",
    provider: input.provider,
    currentModels: input.currentModels,
    hiddenModels: input.hiddenModels,
    providerSnapshotRefreshing: input.loading === true,
    previousCache: input.cache ?? null,
  });
}

describe("resolveProviderDiscoveredModels", () => {
  it("keeps a provider's cached discovered models visible while that provider refreshes", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([grokModel]);
  });

  it("excludes compatibility-only models from display and cache", () => {
    const compatibilityModel: AgentModelDefinition = {
      ...piModel,
      id: "pi/model-legacy",
      label: "Pi Model legacy",
      isSelectable: false,
    };

    const result = resolveModels({
      provider: "pi",
      currentModels: [piModel, compatibilityModel],
    });

    expect(result.models).toEqual([piModel]);
    expect(result.cache?.models).toEqual([piModel]);
  });
  it("includes user-hidden models that have isSelectable: false", () => {
    const hiddenModel: AgentModelDefinition = {
      ...piModel,
      id: "pi/model-hidden",
      label: "Pi Hidden",
      isSelectable: false,
    };

    const result = resolveModels({
      provider: "pi",
      currentModels: [piModel, hiddenModel],
      hiddenModels: ["pi/model-hidden"],
    });

    expect(result.models).toEqual([piModel, hiddenModel]);
  });

  it("does not show one provider's cached models while another provider loads", () => {
    const ready = resolveModels({ provider: "pi", currentModels: [piModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([]);
  });

  it("does not show another server's cached models while the same provider loads", () => {
    const ready = resolveModels({
      serverId: "server-a",
      provider: "grok",
      currentModels: [grokModel],
    });

    const refreshing = resolveModels({
      serverId: "server-b",
      provider: "grok",
      loading: true,
      cache: ready.cache,
    });

    expect(refreshing.models).toEqual([]);
  });
});
