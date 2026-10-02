import { useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

export type NotesHostStatus = "ready" | "no_notes_host" | "offline";

export interface NotesHost {
  serverId: string | null;
  client: DaemonClient | null;
  status: NotesHostStatus;
  /** Display label of the notes host, when one is known. */
  hostLabel: string | null;
  /** True while a host is still connecting, so "offline" can still change. */
  isConnecting: boolean;
}

export interface NotesHostCandidate {
  serverId: string;
  label: string;
}

export interface ResolvedNotesHost {
  serverId: string | null;
  status: NotesHostStatus;
  hostLabel: string | null;
  isConnecting: boolean;
}

/**
 * The notes host is the one host that advertises `features.notes` (the
 * Commander host). A host keeps its last server info while it is offline, so
 * an offline notes host is still found and reported as "offline". When no
 * host is online, the app cannot know where notes live: that is "offline"
 * too, not "no_notes_host".
 */
export function resolveNotesHost(input: {
  hosts: readonly NotesHostCandidate[];
  notesFeature: ReadonlyMap<string, boolean>;
  connectionStatuses: ReadonlyMap<string, HostRuntimeConnectionStatus>;
}): ResolvedNotesHost {
  const statusOf = (serverId: string) => input.connectionStatuses.get(serverId) ?? "connecting";
  const isConnecting = input.hosts.some((host) => {
    const status = statusOf(host.serverId);
    return status === "connecting" || status === "idle";
  });
  const notesHosts = input.hosts.filter((host) => input.notesFeature.get(host.serverId) === true);
  const onlineNotesHost = notesHosts.find((host) => statusOf(host.serverId) === "online");
  if (onlineNotesHost) {
    return {
      serverId: onlineNotesHost.serverId,
      status: "ready",
      hostLabel: onlineNotesHost.label,
      isConnecting,
    };
  }
  const knownNotesHost = notesHosts[0];
  if (knownNotesHost) {
    return {
      serverId: knownNotesHost.serverId,
      status: "offline",
      hostLabel: knownNotesHost.label,
      isConnecting,
    };
  }
  const hasOnlineHost = input.hosts.some((host) => statusOf(host.serverId) === "online");
  return {
    serverId: null,
    status: hasOnlineHost ? "no_notes_host" : "offline",
    hostLabel: null,
    isConnecting,
  };
}

export function useNotesHost(): NotesHost {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const notesFeature = useHostFeatureMap(serverIds, "notes");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const resolved = useMemo(
    () =>
      resolveNotesHost({
        hosts: hosts.map((host) => ({ serverId: host.serverId, label: host.label })),
        notesFeature,
        connectionStatuses,
      }),
    [connectionStatuses, hosts, notesFeature],
  );
  const runtimeClient = useHostRuntimeClient(resolved.serverId ?? "");
  const client = resolved.status === "ready" ? runtimeClient : null;
  return useMemo(() => ({ ...resolved, client }), [client, resolved]);
}
