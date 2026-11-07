import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
import { resolveEffectiveFormPreferences } from "@/create-agent-preferences/preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import {
  loadHistoryAskHostPreferences,
  resolveHistoryAskHostSelection,
  updateHistoryAskHostSelection,
} from "./host-preferences";
import type { HistoryAskScope } from "./scope";

/**
 * Per-host provider/model selection for History Ask.
 * Seeds from host prefs → create-form prefs; persists on change.
 */
export function useHistoryAskModelSelection(input: {
  scope: HistoryAskScope | null;
  needsHostSelection: boolean;
  snapshotCwd: string | null;
}) {
  const serverId = input.scope?.serverId ?? null;
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [prefsHydratedForHost, setPrefsHydratedForHost] = useState<string | null>(null);

  const providerSnapshot = useProvidersSnapshot(serverId, {
    enabled: Boolean(serverId && !input.needsHostSelection),
    cwd: input.snapshotCwd,
  });

  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(providerSnapshot.entries),
    [providerSnapshot.entries],
  );

  useEffect(() => {
    if (!serverId || input.needsHostSelection) {
      setPrefsHydratedForHost(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const hostPrefs = await loadHistoryAskHostPreferences();
      const hostSelection = resolveHistoryAskHostSelection(hostPrefs, serverId);
      const createPrefs = await createAgentPreferencesService.load();
      const effective = resolveEffectiveFormPreferences(createPrefs, {
        workspaceId: input.scope?.workspaceId ?? null,
        projectKey: input.scope?.projectId ?? null,
      });
      if (cancelled) {
        return;
      }
      const provider = hostSelection.provider?.trim() || effective.provider?.trim() || "";
      const model =
        hostSelection.model?.trim() ||
        (provider ? effective.providerPreferences?.[provider]?.model?.trim() : undefined) ||
        "";
      setSelectedProvider(provider);
      setSelectedModel(model);
      setPrefsHydratedForHost(serverId);
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, input.needsHostSelection, input.scope?.workspaceId, input.scope?.projectId]);

  useEffect(() => {
    if (!serverId || prefsHydratedForHost !== serverId || modelSelectorProviders.length === 0) {
      return;
    }
    const providerEntry =
      modelSelectorProviders.find((entry) => entry.id === selectedProvider) ??
      modelSelectorProviders[0];
    if (!providerEntry) {
      return;
    }
    const rows =
      providerEntry.modelSelection.kind === "models" ? providerEntry.modelSelection.rows : [];
    const modelRow =
      rows.find((row) => row.modelId === selectedModel) ??
      rows.find((row) => row.isDefault) ??
      rows[0];
    const nextProvider = providerEntry.id;
    const nextModel = modelRow?.modelId ?? "";
    if (nextProvider !== selectedProvider || nextModel !== selectedModel) {
      setSelectedProvider(nextProvider);
      setSelectedModel(nextModel);
    }
  }, [serverId, prefsHydratedForHost, modelSelectorProviders, selectedProvider, selectedModel]);

  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      setSelectedProvider(provider);
      setSelectedModel(modelId);
      if (serverId) {
        void updateHistoryAskHostSelection(serverId, { provider, model: modelId });
      }
    },
    [serverId],
  );

  const handleModelOpen = useCallback(() => {
    providerSnapshot.refetchIfStale(selectedProvider || null);
  }, [providerSnapshot, selectedProvider]);

  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void providerSnapshot.refresh([provider]);
    },
    [providerSnapshot],
  );

  const persistCurrentSelection = useCallback(() => {
    if (!serverId || !selectedProvider) {
      return;
    }
    void updateHistoryAskHostSelection(serverId, {
      provider: selectedProvider,
      model: selectedModel,
    });
  }, [serverId, selectedProvider, selectedModel]);

  return {
    serverId,
    selectedProvider,
    selectedModel,
    modelSelectorProviders,
    isLoading: providerSnapshot.isLoading || providerSnapshot.isFetching,
    isRetrying: providerSnapshot.isRefreshing,
    handleSelectModel,
    handleModelOpen,
    handleRetryProvider,
    persistCurrentSelection,
  };
}
