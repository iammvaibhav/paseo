import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export interface ProviderDiscoveredModelsCache {
  serverId: string;
  provider: string;
  models: AgentModelDefinition[];
}

export interface ResolveProviderDiscoveredModelsInput {
  serverId: string;
  provider: string;
  currentModels: AgentModelDefinition[] | undefined;
  hiddenModels?: readonly string[];
  providerSnapshotRefreshing: boolean;
  previousCache: ProviderDiscoveredModelsCache | null;
}

export interface ResolveProviderDiscoveredModelsResult {
  models: AgentModelDefinition[];
  cache: ProviderDiscoveredModelsCache | null;
}

export function resolveProviderDiscoveredModels({
  serverId,
  provider,
  currentModels,
  hiddenModels,
  providerSnapshotRefreshing,
  previousCache,
}: ResolveProviderDiscoveredModelsInput): ResolveProviderDiscoveredModelsResult {
  const hiddenSet = hiddenModels && hiddenModels.length > 0 ? new Set(hiddenModels) : null;
  const discoveredModels = (currentModels ?? []).filter((model) => {
    if (model.isSelectable !== false) {
      return true;
    }
    if (hiddenSet) {
      return (
        hiddenSet.has(model.id) ||
        (model.aliases !== undefined && model.aliases.some((alias) => hiddenSet.has(alias)))
      );
    }
    return false;
  });

  if (discoveredModels.length > 0) {
    const cache = { serverId, provider, models: discoveredModels };
    return { models: discoveredModels, cache };
  }

  if (
    providerSnapshotRefreshing &&
    previousCache?.serverId === serverId &&
    previousCache.provider === provider
  ) {
    return { models: previousCache.models, cache: previousCache };
  }

  return { models: [], cache: previousCache };
}
