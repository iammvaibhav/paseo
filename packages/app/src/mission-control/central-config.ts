import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { MissionControlCentralConfig } from "@getpaseo/protocol/mission-control/types";
import { useFetchQuery } from "@/data/query";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
// Pure resolution (types + defaults + resolver) lives apart from the hooks so
// it stays unit-testable without the RN/hook import chain. The names are
// imported for in-module use AND re-exported for existing consumers.
import {
  missionControlCentralConfigQueryKey,
  resolveMissionControlCentralConfig,
  type ResolvedMissionControlCentralConfig,
} from "./central-config-resolver";
export * from "./central-config-resolver";

/** Mission Control config reads/writes against one daemon (each host owns its own). */
export interface MissionControlCentralConfigState {
  /** Host that serves the config: the local daemon, else the first host. */
  hostServerId: string | null;
  resolvingHost: boolean;
  config: ResolvedMissionControlCentralConfig | null;
  isLoading: boolean;
  patchConfig: (patch: Partial<MissionControlCentralConfig>) => Promise<void>;
}

/**
 * Resolves the host whose daemon this app talks to for the central Mission
 * Control config: the LOCAL daemon when connected, else the first known host.
 * Each host keeps its own config (Flotilla writes it), so settings edit the
 * host this app talks to.
 */
export function useMissionControlCentralConfigHost(): {
  serverId: string | null;
  resolving: boolean;
} {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();

  return useMemo(() => {
    const known = (id: string | null): string | null =>
      id && hosts.some((host) => host.serverId === id) ? id : null;
    const serverId = known(localServerId) ?? hosts[0]?.serverId ?? null;
    return { serverId, resolving: false };
  }, [hosts, localServerId]);
}

/**
 * Writes a fleet-wide setting to every connected host (each host keeps its own
 * config; the one serving an MCP client decides on its callbacks). Returns the
 * hosts it could not write, offline or rejected, so the caller can say so.
 */
export async function patchMissionControlConfigOnEveryHost(
  hosts: readonly { serverId: string; label: string }[],
  patch: Partial<MissionControlCentralConfig>,
): Promise<string[]> {
  const results = await Promise.all(
    hosts.map(async (host) => {
      const client = getHostRuntimeStore().getClient(host.serverId);
      if (!client?.isConnected) return host.label;
      const result = await client.missionControlConfigPatch(patch).catch(() => null);
      return result?.ok ? null : host.label;
    }),
  );
  return results.filter((label): label is string => label !== null);
}

export function useMissionControlCentralConfig(): MissionControlCentralConfigState {
  const { serverId, resolving } = useMissionControlCentralConfigHost();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const queryKey = useMemo(() => missionControlCentralConfigQueryKey(serverId), [serverId]);

  const configQuery = useFetchQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected && !resolving),
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.hostDisconnected"));
      }
      const result = await client.missionControlConfigGet();
      return result.config;
    },
  });

  const patchConfig = useCallback(
    async (patch: Partial<MissionControlCentralConfig>) => {
      if (!client) {
        throw new Error(t("common.errors.hostDisconnected"));
      }
      const result = await client.missionControlConfigPatch(patch);
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to update Mission Control config");
      }
      queryClient.setQueryData(queryKey, result.config);
    },
    [client, queryClient, queryKey, t],
  );

  return {
    hostServerId: serverId,
    resolvingHost: resolving,
    config: configQuery.data ? resolveMissionControlCentralConfig(configQuery.data) : null,
    isLoading: configQuery.isLoading,
    patchConfig,
  };
}
