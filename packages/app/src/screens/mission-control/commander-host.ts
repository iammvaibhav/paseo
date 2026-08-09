import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";

// Per-server identity fields the central-config commanderHost designation may
// name: the daemon's server_info hostname or its missionControl.hostAlias.
export interface CommanderHostInfo {
  hostname: string | null;
  hostAlias: string | null;
}

export type HostInfoByServerId = Record<string, CommanderHostInfo>;

interface HostInfoSource {
  serverInfo: { hostname: string | null; missionControlHostAlias: string | null } | null;
}

/**
 * Derives the { hostname, hostAlias } map from the session store's sessions
 * dict. Pure and deliberately dumb: it always allocates fresh objects, so
 * callers MUST memoize on a reference-stable input (`state.sessions`) — do
 * NOT feed this through a Zustand selector, or the fresh objects defeat
 * shallow equality and loop the render (React 19: "The result of getSnapshot
 * should be cached" / "Maximum update depth exceeded").
 */
export function buildHostInfoByServerId(
  sessions: Readonly<Record<string, HostInfoSource>>,
): HostInfoByServerId {
  return Object.fromEntries(
    Object.entries(sessions).map(([serverId, session]) => [
      serverId,
      {
        hostname: session.serverInfo?.hostname ?? null,
        hostAlias: session.serverInfo?.missionControlHostAlias ?? null,
      },
    ]),
  );
}

export interface CommanderHostLike {
  serverId: string;
}

/**
 * Resolves the central-config commanderHost designation to a connected host's
 * serverId: by serverId first, then by server_info hostname, then by
 * missionControlHostAlias. Designation is required, never defaulted: no
 * designation → null (no host is selected).
 */
export function resolveCommanderServerId(
  centralCommanderHost: string | null,
  hosts: readonly CommanderHostLike[],
  hostInfoByServerId: Readonly<HostInfoByServerId>,
): string | null {
  if (!centralCommanderHost) {
    return null;
  }
  const direct = hosts.find((host) => host.serverId === centralCommanderHost);
  if (direct) {
    return direct.serverId;
  }
  return (
    hosts.find((host) => {
      const info = hostInfoByServerId[host.serverId];
      return (
        info?.hostname === centralCommanderHost ||
        (info?.hostAlias !== null && info?.hostAlias === centralCommanderHost)
      );
    })?.serverId ?? null
  );
}

/**
 * Reference-stable access to per-server host identity: selects the sessions
 * dict itself (a store reference that only changes when sessions actually
 * change) and derives the map in useMemo. Never put buildHostInfoByServerId
 * inside a Zustand selector — its fresh nested objects break shallow equality
 * on every getSnapshot call and crash the screen.
 */
export function useHostInfoByServerId(): HostInfoByServerId {
  const sessions = useSessionStore((state) => state.sessions);
  return useMemo(() => buildHostInfoByServerId(sessions), [sessions]);
}
