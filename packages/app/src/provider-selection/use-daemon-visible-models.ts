import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildHiddenModelKey, useHiddenModelKeys, useHiddenModelsStore } from "./hidden-models";

export interface UseDaemonVisibleModelsResult {
  /** Hidden keys derived from the daemon allow-list, or the local store fallback. */
  hiddenKeys: ReadonlySet<string>;
  setModelHidden: (provider: string, modelId: string, hidden: boolean) => void;
  setModelsHidden: (
    models: readonly { provider: string; modelId: string }[],
    hidden: boolean,
  ) => void;
  /** True when the daemon allow-list is authoritative. */
  isDaemon: boolean;
}

/**
 * Per-host model visibility, stored as a daemon-side allow-list
 * (`daemon.visibleModels`) so every client on the host sees the same picker.
 * The outward shape stays hidden-keys so pickers keep denylist filtering:
 * hidden is the universe minus visible. IDs outside the allow-list default
 * hidden, so a newly added provider stays out until checked.
 */
export function useDaemonVisibleModels(
  serverId?: string | null,
  allKeys: readonly string[] = [],
): UseDaemonVisibleModelsResult {
  const normalizedServerId = serverId ?? null;
  const { config, patchConfig } = useDaemonConfig(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId ?? "");
  const daemonList = config?.visibleModels;

  const localHiddenKeys = useHiddenModelKeys();
  const localSetModelsHidden = useHiddenModelsStore((state) => state.setModelsHidden);

  const connected = Boolean(normalizedServerId && isConnected);
  const isDaemon = connected && daemonList !== undefined;

  const universeKey = useMemo(() => [...allKeys].sort().join("\n"), [allKeys]);
  const universe = useMemo(
    () => (universeKey === "" ? [] : universeKey.split("\n")),
    [universeKey],
  );

  const uploadedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!connected || daemonList !== undefined) return;
    if (!normalizedServerId || uploadedRef.current.has(normalizedServerId)) return;
    if (universe.length === 0) return;
    const localKeys = useHiddenModelsStore.getState().hiddenKeys;
    if (localKeys.size === 0) return;
    uploadedRef.current.add(normalizedServerId);
    const next = universe.filter((key) => !localKeys.has(key));
    void (async () => {
      try {
        await patchConfig({ visibleModels: next });
      } catch (error) {
        console.warn("Failed to upload visible models to host", error);
      }
    })();
  }, [connected, daemonList, normalizedServerId, patchConfig, localHiddenKeys, universe]);

  const hiddenKeys = useMemo<ReadonlySet<string>>(() => {
    if (daemonList === undefined) return localHiddenKeys;
    const visible = new Set(daemonList);
    return new Set(universe.filter((key) => !visible.has(key)));
  }, [daemonList, localHiddenKeys, universe]);

  const setModelsHidden = useCallback(
    (models: readonly { provider: string; modelId: string }[], hidden: boolean) => {
      if (!connected) {
        localSetModelsHidden(models, hidden);
        return;
      }
      const keys = models.map((model) => buildHiddenModelKey(model.provider, model.modelId));
      const base =
        daemonList !== undefined
          ? new Set(daemonList)
          : new Set(universe.filter((key) => !useHiddenModelsStore.getState().hiddenKeys.has(key)));
      let changed = false;
      for (const key of keys) {
        if (hidden) {
          if (base.has(key)) {
            base.delete(key);
            changed = true;
          }
        } else if (!base.has(key)) {
          base.add(key);
          changed = true;
        }
      }
      if (!changed) return;
      localSetModelsHidden(models, hidden);
      const next = [...base].sort();
      void patchConfig({ visibleModels: next }).catch((error) => {
        console.warn("Failed to update visible models on host", error);
      });
    },
    [connected, daemonList, localSetModelsHidden, patchConfig, universe],
  );

  const setModelHidden = useCallback(
    (provider: string, modelId: string, hidden: boolean) => {
      setModelsHidden([{ provider, modelId }], hidden);
    },
    [setModelsHidden],
  );

  return { hiddenKeys, setModelHidden, setModelsHidden, isDaemon };
}
