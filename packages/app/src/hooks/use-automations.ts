import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  automationsQueryBaseKey,
  fetchAggregatedAutomations,
  type AggregatedAutomation,
  type AutomationHostError,
  type AutomationHostInput,
} from "@/automations/aggregated-automations";

export type {
  AggregatedAutomation,
  AutomationHostError,
} from "@/automations/aggregated-automations";
export type AutomationAggregateLoadState =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: AggregatedAutomation[] };

// Shared empty ref so consumers can depend on it in hooks without
// re-evaluating every render.
const EMPTY_AUTOMATION_HOST_ERRORS: AutomationHostError[] = [];

export interface UseAutomationsResult {
  loadState: AutomationAggregateLoadState;
  hostErrors: AutomationHostError[];
  isError: boolean;
  refetch: () => void;
  isRefetching: boolean;
  hasSupportedHost: boolean;
  hasKnownHost: boolean;
}

export function useAutomations(): UseAutomationsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<AutomationHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const featureMap = useHostFeatureMap(serverIds, "automations");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const query = useFetchQuery({
    queryKey: [
      ...automationsQueryBaseKey,
      [...serverIds].sort().join("|"),
      connectionStatusKey,
      ...serverIds.map((id) => featureMap.get(id) ?? null),
    ],
    queryFn: () =>
      fetchAggregatedAutomations({ hosts: hostInputs, runtime, supportedHosts: featureMap }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });
  let loadState: AutomationAggregateLoadState;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }
  return {
    loadState,
    hostErrors:
      query.data?.status === "loaded" ? query.data.hostErrors : EMPTY_AUTOMATION_HOST_ERRORS,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
    hasSupportedHost: serverIds.some((serverId) => featureMap.get(serverId) === true),
    hasKnownHost: serverIds.some((serverId) => featureMap.get(serverId) !== undefined),
  };
}
