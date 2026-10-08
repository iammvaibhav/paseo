import { useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

export type TicketsHostStatus = "ready" | "no_board_host" | "offline";

export interface TicketsHost {
  serverId: string | null;
  client: DaemonClient | null;
  status: TicketsHostStatus;
  /** Display label of the board host, when one is known. */
  hostLabel: string | null;
  /** True while a host is still connecting, so "offline" can still change. */
  isConnecting: boolean;
}

export interface TicketsHostCandidate {
  serverId: string;
  label: string;
}

export interface ResolvedTicketsHost {
  serverId: string | null;
  status: TicketsHostStatus;
  hostLabel: string | null;
  isConnecting: boolean;
}

/**
 * The board host is the one host that advertises `features.tickets` (the
 * Commander host). A host keeps its last server info while it is offline, so
 * an offline board host is still found and reported as "offline". When no
 * host is online, the app cannot know where the board lives: that is
 * "offline" too, not "no_board_host".
 */
export function resolveTicketsHost(input: {
  hosts: readonly TicketsHostCandidate[];
  ticketsFeature: ReadonlyMap<string, boolean>;
  connectionStatuses: ReadonlyMap<string, HostRuntimeConnectionStatus>;
}): ResolvedTicketsHost {
  const statusOf = (serverId: string) => input.connectionStatuses.get(serverId) ?? "connecting";
  const isConnecting = input.hosts.some((host) => {
    const status = statusOf(host.serverId);
    return status === "connecting" || status === "idle";
  });
  const boardHosts = input.hosts.filter((host) => input.ticketsFeature.get(host.serverId) === true);
  const onlineBoardHost = boardHosts.find((host) => statusOf(host.serverId) === "online");
  if (onlineBoardHost) {
    return {
      serverId: onlineBoardHost.serverId,
      status: "ready",
      hostLabel: onlineBoardHost.label,
      isConnecting,
    };
  }
  const knownBoardHost = boardHosts[0];
  if (knownBoardHost) {
    return {
      serverId: knownBoardHost.serverId,
      status: "offline",
      hostLabel: knownBoardHost.label,
      isConnecting,
    };
  }
  const hasOnlineHost = input.hosts.some((host) => statusOf(host.serverId) === "online");
  return {
    serverId: null,
    status: hasOnlineHost ? "no_board_host" : "offline",
    hostLabel: null,
    isConnecting,
  };
}

export function useTicketsHost(): TicketsHost {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const ticketsFeature = useHostFeatureMap(serverIds, "tickets");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const resolved = useMemo(
    () =>
      resolveTicketsHost({
        hosts: hosts.map((host) => ({ serverId: host.serverId, label: host.label })),
        ticketsFeature,
        connectionStatuses,
      }),
    [connectionStatuses, hosts, ticketsFeature],
  );
  const runtimeClient = useHostRuntimeClient(resolved.serverId ?? "");
  const client = resolved.status === "ready" ? runtimeClient : null;
  return useMemo(() => ({ ...resolved, client }), [client, resolved]);
}
