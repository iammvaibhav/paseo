import type { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import {
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  type Snapshot,
} from "@/data/providers-snapshot";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { buildHiddenModelKey } from "./hidden-models";

export type VisibleModelsClient = Pick<DaemonClient, "getDaemonConfig" | "patchDaemonConfig">;

/**
 * Apply a check/uncheck to one host's `daemon.visibleModels` allow-list.
 *
 * The list is read fresh from the daemon right before the write. The patch
 * replaces the whole array, so computing it from a client cache (still loading,
 * or stale because another client changed it) would overwrite the host's real
 * choices.
 *
 * A host with no list yet is written only when `seed` is given: the seed is its
 * starting list (the legacy client-side choices). Without a seed it is skipped.
 * Returns the config the host now has, or null when nothing was read or written.
 */
export async function updateHostVisibleModels(input: {
  client: VisibleModelsClient;
  keys: readonly string[];
  hidden: boolean;
  seed?: () => string[];
}): Promise<MutableDaemonConfig | null> {
  const { config } = await input.client.getDaemonConfig();
  const current = config.visibleModels;
  if (current === undefined && !input.seed) return null;
  const seeded = current === undefined;
  const next = new Set(current ?? input.seed?.() ?? []);
  let changed = seeded;
  for (const key of input.keys) {
    if (input.hidden === !next.has(key)) continue;
    if (input.hidden) next.delete(key);
    else next.add(key);
    changed = true;
  }
  if (!changed) return config;
  const result = await input.client.patchDaemonConfig({ visibleModels: [...next].sort() });
  return result.config;
}

function snapshotModelKeys(snapshot: Snapshot): Set<string> {
  const keys = new Set<string>();
  for (const entry of snapshot.entries ?? []) {
    for (const model of entry.models ?? []) keys.add(buildHiddenModelKey(entry.provider, model.id));
  }
  return keys;
}

/**
 * Mirror a check/uncheck onto every other connected host that offers the same
 * model, so a fleet keeps one set of chosen models without visiting each host.
 * A host that does not list the model is left alone; a host with no allow-list
 * yet is skipped. Per-host failures are logged and do not stop the others.
 */
export async function propagateVisibleModels(input: {
  originServerId: string;
  keys: readonly string[];
  hidden: boolean;
  queryClient: QueryClient;
}): Promise<void> {
  const store = getHostRuntimeStore();
  await Promise.all(
    store.getHosts().map(async ({ serverId }) => {
      if (serverId === input.originServerId) return;
      const client = store.getClient(serverId);
      if (!client || !isHostRuntimeConnected(store.getSnapshot(serverId))) return;
      try {
        const snapshot = await input.queryClient.fetchQuery({
          queryKey: providersSnapshotQueryKey(serverId),
          staleTime: 60_000,
          queryFn: ({ signal }) =>
            fetchProvidersSnapshot({
              client,
              serverId,
              cwd: null,
              queryClient: input.queryClient,
              signal,
            }),
        });
        const offered = snapshotModelKeys(snapshot);
        const keys = input.keys.filter((key) => offered.has(key));
        if (keys.length === 0) return;
        const config = await updateHostVisibleModels({ client, keys, hidden: input.hidden });
        if (config) input.queryClient.setQueryData(daemonConfigQueryKey(serverId), config);
      } catch (error) {
        console.warn(`Failed to sync visible models to host ${serverId}`, error);
      }
    }),
  );
}
