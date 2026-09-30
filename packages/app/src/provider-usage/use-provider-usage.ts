import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { providerUsagePushRoute } from "@/data/push-router";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import { providerUsageQueryKey } from "./query-key";
import type { ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

export function useProviderUsage(serverId: string | null | undefined): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
  isRefreshing: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  // COMPAT(providerUsageEventSubscription): added 2026-09-30, remove gate after 2027-03-30.
  const supportsProviderUsagePush = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageEventSubscription === true,
  );
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    // Always force the daemon past its 5m cache so tooltip/settings refreshes
    // return live provider limits instead of a stale server snapshot.
    return client.listProviderUsage({ forceRefresh: true });
  }, [client]);

  // Not hover-gated: the cache is warm before a popover opens, so a freshly created
  // agent tab renders plan usage on the first hover instead of a loading line.
  // The daemon refreshes usage on its own schedule; the push route folds those
  // pushes into this cache entry so open popovers update without a round trip.
  const query = useQuery({
    queryKey,
    queryFn,
    enabled: canFetch,
    meta: providerUsagePushRoute({
      enabled: canFetch && supportsProviderUsagePush,
      serverId: serverId ?? "",
    }),
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    // Keep showing cached data while a forced refetch is in flight.
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, queryClient, queryFn, queryKey]);

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
  ]);

  return { view, refresh, canFetch, isRefreshing: query.isFetching };
}
