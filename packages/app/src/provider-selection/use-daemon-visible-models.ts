import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildHiddenModelKey, useHiddenModelKeys, useHiddenModelsStore } from "./hidden-models";
import { propagateVisibleModels, updateHostVisibleModels } from "./visible-models-sync";

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
 * (`daemon.visibleModels` in the host's config.json) so every client on the
 * host sees the same picker. The outward shape stays hidden-keys so pickers
 * keep denylist filtering: hidden is the universe minus visible. IDs outside
 * the allow-list default hidden, so a newly added provider stays out until
 * checked. A check or uncheck is mirrored onto every other connected host that
 * offers the same model.
 */
export function useDaemonVisibleModels(
  serverId?: string | null,
  allKeys: readonly string[] = [],
): UseDaemonVisibleModelsResult {
  const normalizedServerId = serverId ?? null;
  const { config } = useDaemonConfig(normalizedServerId);
  const client = useHostRuntimeClient(normalizedServerId ?? "");
  const isConnected = useHostRuntimeIsConnected(normalizedServerId ?? "");
  const queryClient = useQueryClient();
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
  const localSeed = useCallback(() => {
    const localKeys = useHiddenModelsStore.getState().hiddenKeys;
    return universe.filter((key) => !localKeys.has(key));
  }, [universe]);

  // One write at a time per hook: each write reads the host's list fresh, so
  // two quick toggles must not both start from the same list.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueWrite = useCallback((write: () => Promise<void>) => {
    writeChainRef.current = writeChainRef.current.then(write).catch((error) => {
      console.warn("Failed to update visible models on host", error);
    });
  }, []);

  // Legacy upload: a host without an allow-list adopts this client's old local
  // choices. Waits for the host config to load: before it does, `daemonList`
  // is undefined for every host, and uploading then overwrote real lists.
  const uploadedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!connected || !client || !normalizedServerId || config === null) return;
    if (daemonList !== undefined || uploadedRef.current.has(normalizedServerId)) return;
    if (universe.length === 0 || useHiddenModelsStore.getState().hiddenKeys.size === 0) return;
    uploadedRef.current.add(normalizedServerId);
    enqueueWrite(async () => {
      const next = await updateHostVisibleModels({
        client,
        keys: [],
        hidden: false,
        seed: localSeed,
      });
      if (next) queryClient.setQueryData(daemonConfigQueryKey(normalizedServerId), next);
    });
  }, [
    client,
    config,
    connected,
    daemonList,
    enqueueWrite,
    localHiddenKeys,
    localSeed,
    normalizedServerId,
    queryClient,
    universe,
  ]);

  const hiddenKeys = useMemo<ReadonlySet<string>>(() => {
    if (daemonList === undefined) return localHiddenKeys;
    const visible = new Set(daemonList);
    return new Set(universe.filter((key) => !visible.has(key)));
  }, [daemonList, localHiddenKeys, universe]);

  const setModelsHidden = useCallback(
    (models: readonly { provider: string; modelId: string }[], hidden: boolean) => {
      localSetModelsHidden(models, hidden);
      if (!connected || !client || !normalizedServerId) return;
      const keys = models.map((model) => buildHiddenModelKey(model.provider, model.modelId));
      if (config && daemonList !== undefined) {
        const optimistic = new Set(daemonList);
        for (const key of keys) {
          if (hidden) optimistic.delete(key);
          else optimistic.add(key);
        }
        queryClient.setQueryData(daemonConfigQueryKey(normalizedServerId), {
          ...config,
          visibleModels: [...optimistic].sort(),
        });
      }
      enqueueWrite(async () => {
        const next = await updateHostVisibleModels({ client, keys, hidden, seed: localSeed });
        if (next) queryClient.setQueryData(daemonConfigQueryKey(normalizedServerId), next);
        await propagateVisibleModels({
          originServerId: normalizedServerId,
          keys,
          hidden,
          queryClient,
        });
      });
    },
    [
      client,
      config,
      connected,
      daemonList,
      enqueueWrite,
      localSeed,
      localSetModelsHidden,
      normalizedServerId,
      queryClient,
    ],
  );

  const setModelHidden = useCallback(
    (provider: string, modelId: string, hidden: boolean) => {
      setModelsHidden([{ provider, modelId }], hidden);
    },
    [setModelsHidden],
  );

  return { hiddenKeys, setModelHidden, setModelsHidden, isDaemon };
}
