import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { queryClient as singletonQueryClient } from "@/data/query-client";
import {
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  fetchProvidersSnapshot,
  refreshAndApplyProvidersSnapshot,
  type Snapshot,
} from "@/data/providers-snapshot";

export {
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  fetchProvidersSnapshot,
  refreshAndApplyProvidersSnapshot,
};

export type ProvidersSnapshotClient = Pick<
  DaemonClient,
  "getProvidersSnapshot" | "refreshProvidersSnapshot"
>;

export type SelectorOpenRefetchDecision = "refetch-stale" | "refetch-always";

export function selectorOpenRefetchDecision(input: {
  entries: ProviderSnapshotEntry[] | undefined;
  selectedProvider: AgentProvider | null | undefined;
}): SelectorOpenRefetchDecision {
  if (!input.selectedProvider) {
    return "refetch-stale";
  }
  const selectedEntry = input.entries?.find((entry) => entry.provider === input.selectedProvider);
  if (!selectedEntry || selectedEntry.status === "loading") {
    return "refetch-always";
  }
  return "refetch-stale";
}

interface UseProvidersSnapshotResult {
  entries: ProviderSnapshotEntry[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isRefreshing: boolean;
  error: string | null;
  supportsSnapshot: boolean;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
  refetchIfStale: (selectedProvider?: AgentProvider | null) => void;
}

interface UseProvidersSnapshotOptions {
  enabled?: boolean;
  cwd?: string | null;
}

export function useProvidersSnapshot(
  serverId: string | null,
  options: UseProvidersSnapshotOptions = {},
): UseProvidersSnapshotResult {
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const enabled = (options.enabled ?? true) && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const supportsSnapshot = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providersSnapshot === true,
  );

  const queryKey = useMemo(() => providersSnapshotQueryKey(serverId, cwd), [cwd, serverId]);

  const placeholderData = useMemo<Snapshot | undefined>(() => {
    if (!serverId) return undefined;
    const rootKey = providersSnapshotQueryRoot(serverId);
    const siblingData = queryClient.getQueriesData<Snapshot>({ queryKey: rootKey });
    const homeData = siblingData.find(([key]) => key.length === 3 && key[2] === "home")?.[1];
    if (homeData) return homeData;

    const mostRecentlyUpdated = siblingData
      .filter(([, data]) => data !== undefined)
      .sort(([leftKey], [rightKey]) => {
        const leftUpdatedAt = queryClient.getQueryState<Snapshot>(leftKey)?.dataUpdatedAt ?? 0;
        const rightUpdatedAt = queryClient.getQueryState<Snapshot>(rightKey)?.dataUpdatedAt ?? 0;
        return rightUpdatedAt - leftUpdatedAt;
      });
    return mostRecentlyUpdated[0]?.[1];
  }, [queryClient, serverId]);

  const snapshotQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(enabled && supportsSnapshot && serverId && client && isConnected),
    pushEvent: "providers_snapshot_update",
    placeholderData,
    queryFn: async ({ signal }) => {
      if (!client || !serverId) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return fetchProvidersSnapshot({ client, serverId, cwd, queryClient, signal });
    },
  });

  const isPlaceholderData = snapshotQuery.isPlaceholderData === true;

  const refreshMutation = useMutation({
    mutationFn: async (providers?: AgentProvider[]) => {
      if (!client || !serverId) {
        return;
      }
      await refreshAndApplyProvidersSnapshot({
        client,
        queryClient,
        serverId,
        cwd,
        providers,
      });
    },
  });
  const { mutateAsync: refreshSnapshot, isPending: isRefreshing } = refreshMutation;

  const refresh = useCallback(
    async (providers?: AgentProvider[]) => {
      await refreshSnapshot(providers);
    },
    [refreshSnapshot],
  );

  const refetchIfStale = useCallback(
    (selectedProvider?: AgentProvider | null) => {
      const decision = selectorOpenRefetchDecision({
        entries: snapshotQuery.data?.entries,
        selectedProvider,
      });
      if (decision === "refetch-always") {
        void queryClient.refetchQueries({ queryKey, type: "active" });
        return;
      }
      void queryClient.refetchQueries({ queryKey, type: "active", stale: true });
    },
    [queryClient, queryKey, snapshotQuery.data?.entries],
  );

  return {
    entries: snapshotQuery.data?.entries,
    isLoading: snapshotQuery.isLoading && !isPlaceholderData,
    isFetching: snapshotQuery.isFetching && !isPlaceholderData,
    isRefreshing,
    error: snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null,
    supportsSnapshot,
    refresh,
    refetchIfStale,
  };
}

export function prefetchProvidersSnapshot(
  serverId: string,
  client: DaemonClient,
  options: { cwd?: string | null } = {},
): void {
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const queryKey = providersSnapshotQueryKey(serverId, cwd);
  void singletonQueryClient.prefetchQuery({
    queryKey,
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      fetchProvidersSnapshot({ client, serverId, cwd, queryClient: singletonQueryClient, signal }),
  });
}
