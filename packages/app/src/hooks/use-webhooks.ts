import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  fetchAggregatedWebhooks,
  webhooksQueryBaseKey,
  type AggregateLoadState,
  type AggregatedWebhook,
  type WebhookHostError,
  type WebhookHostInput,
} from "@/webhooks/aggregated-webhooks";

export type {
  AggregateLoadState,
  AggregatedWebhook,
  WebhookHostError,
} from "@/webhooks/aggregated-webhooks";

export function webhooksQueryKey(serverIds: readonly string[]) {
  return [...webhooksQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseWebhooksResult {
  loadState: AggregateLoadState<AggregatedWebhook>;
  hostErrors: WebhookHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

export function useWebhooks(): UseWebhooksResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<WebhookHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery({
    queryKey: [...webhooksQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedWebhooks({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<AggregatedWebhook>;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
