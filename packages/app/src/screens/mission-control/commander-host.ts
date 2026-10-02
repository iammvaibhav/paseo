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
 * Resolves a host designation (central-config commanderHost, or a spawn plan's
 * target host) to a connected host's serverId: by serverId, then the central
 * `hostAliases` map, then server_info hostname, then missionControlHostAlias.
 *
 * Name matching is case- and whitespace-insensitive. The fleet map the
 * Commander writes from takes its names from the central `hostAliases` map
 * ("macbook"), while a host's own `missionControl.hostAlias` is free text
 * ("MacBook"); an exact comparison silently failed to resolve and callers fell
 * back to the wrong host. Designation is required, never defaulted: no
 * designation → null (no host is selected).
 */
function normalizeHostName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function resolveCommanderServerId(
  centralCommanderHost: string | null,
  hosts: readonly CommanderHostLike[],
  hostInfoByServerId: Readonly<HostInfoByServerId>,
  hostAliases?: Readonly<Record<string, string>>,
): string | null {
  if (!centralCommanderHost) {
    return null;
  }
  const direct = hosts.find((host) => host.serverId === centralCommanderHost);
  if (direct) {
    return direct.serverId;
  }
  const target = normalizeHostName(centralCommanderHost);
  if (!target) {
    return null;
  }
  return (
    hosts.find((host) => {
      const info = hostInfoByServerId[host.serverId];
      // The central alias map is the fleet's own naming, so it wins over the
      // host's self-reported alias.
      return (
        normalizeHostName(hostAliases?.[host.serverId]) === target ||
        normalizeHostName(info?.hostname) === target ||
        normalizeHostName(info?.hostAlias) === target
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
