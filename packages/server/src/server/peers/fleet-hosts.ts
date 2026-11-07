import { isIP } from "node:net";
import type { MissionControlPeerStatus } from "@getpaseo/protocol/mission-control/types";

/**
 * Fleet host names: the one place that decides which host a `host` argument
 * means. Every fleet tool, the meta executor and placement resolve through it,
 * so a name works the same in every tool and on every daemon.
 *
 * A host answers to the names it declares itself (serverId, OS hostname,
 * missionControl.hostAlias, the DNS names in daemon.hostnames) plus the extra
 * names central config gives it (routing.hostAliases). A peer also answers to
 * its name in this daemon's peers config. Daemons advertise their DNS names in
 * server_info.hostNames, so a peer accepts the same names the host accepts for
 * itself. Nothing here invents a name: a host the configs do not name is
 * unknown, and a name that fits more than one host is refused.
 */

/** The name fleet tools always accept for the daemon answering the call. */
export const LOCAL_FLEET_HOST = "local";

/** Every name a fleet host declares or is configured with. */
export interface FleetHostIdentity {
  serverId?: string | null;
  /** The daemon's OS hostname (server_info.hostname). */
  hostname?: string | null;
  /** The daemon's missionControl.hostAlias. */
  hostAlias?: string | null;
  /**
   * DNS names the daemon serves (its daemon.hostnames, advertised as
   * server_info.hostNames). A dotted name also answers to its first label
   * ("prod" for prod.netbird.cloud), the short name the fleet's search domain
   * resolves.
   */
  hostNames?: readonly string[] | null;
  /** Extra names from central config: routing.hostAliases[serverId]. */
  aliases?: readonly string[] | null;
}

export interface FleetPeerHost extends FleetHostIdentity {
  /** The peer's name in this daemon's peers config; fleet results show it. */
  name: string;
  state: MissionControlPeerStatus["state"];
  lastSeenAt: string | null;
}

export interface FleetHostDirectory {
  /** How fleet results label this daemon: missionControl.hostAlias, else "local". */
  selfLabel: string;
  self: FleetHostIdentity;
  peers: readonly FleetPeerHost[];
}

export type FleetHostResolution =
  | { ok: true; kind: "local"; label: string }
  | { ok: true; kind: "peer"; peerName: string; label: string }
  | { ok: false; reason: "unknown" | "ambiguous"; error: string };

/** One host as fleet_list_hosts shows it. */
export interface FleetHostListing {
  /** The name fleet results use for this host. */
  host: string;
  /** True for the daemon answering the call ("local"). */
  self: boolean;
  state: MissionControlPeerStatus["state"];
  lastSeenAt: string | null;
  /** Every name a `host` argument may use for this host. */
  names: string[];
  serverId: string | null;
}

/**
 * The names in a daemon.hostnames value that name this host: exact names
 * only. Wildcard patterns, IP literals and loopback names are dropped; they
 * either match many hosts or mean "whichever host you ask".
 */
export function fleetHostNamesFromConfig(
  hostnames: true | readonly string[] | null | undefined,
): string[] {
  if (!Array.isArray(hostnames)) {
    return [];
  }
  const names = new Set<string>();
  for (const entry of hostnames as readonly string[]) {
    const name = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!name || name.startsWith(".") || name.includes("*") || name.includes("/")) {
      continue;
    }
    if (isIP(name) !== 0 || name === "localhost" || name.endsWith(".localhost")) {
      continue;
    }
    names.add(name);
  }
  return [...names];
}

/**
 * Every name a host answers to, most recognisable first: the primary names,
 * the alias, short names (single-label DNS names and the first label of dotted
 * ones), the OS hostname, configured aliases, full DNS names, then the
 * serverId. Case-insensitive duplicates are dropped.
 */
function fleetHostNames(identity: FleetHostIdentity, primary: readonly string[] = []): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    names.push(trimmed);
  };
  const dnsNames = fleetHostNamesFromConfig(identity.hostNames ?? []);
  for (const name of primary) add(name);
  add(identity.hostAlias);
  for (const name of dnsNames) add(name.split(".")[0]);
  add(identity.hostname);
  for (const name of identity.aliases ?? []) add(name);
  for (const name of dnsNames) add(name);
  add(identity.serverId);
  return names;
}

export function listFleetHosts(directory: FleetHostDirectory): FleetHostListing[] {
  return [
    {
      host: directory.selfLabel,
      self: true,
      state: "online",
      lastSeenAt: null,
      names: fleetHostNames(directory.self, [directory.selfLabel, LOCAL_FLEET_HOST]),
      serverId: directory.self.serverId ?? null,
    },
    ...directory.peers.map((peer) => ({
      host: peer.name,
      self: false,
      state: peer.state,
      lastSeenAt: peer.lastSeenAt,
      names: fleetHostNames(peer, [peer.name]),
      serverId: peer.serverId ?? null,
    })),
  ];
}

/** Every host and a few of its names, for errors that have to teach the fix. */
export function describeFleetHosts(directory: FleetHostDirectory): string {
  const entries = listFleetHosts(directory).map((entry) => {
    const others = entry.names
      .filter((name) => name !== entry.host && name !== entry.serverId)
      .slice(0, 4);
    const state = entry.self ? "this host" : entry.state;
    return `${entry.host} (${state}${others.length > 0 ? `; also ${others.join(", ")}` : ""})`;
  });
  return `Known hosts: ${entries.join(", ")}. fleet_list_hosts lists every name each host answers to.`;
}

/**
 * Which host a `host` argument names. Absent and "local" mean this daemon.
 * Matching is case-insensitive. A name that fits this daemon and a peer, or
 * two peers, is refused rather than guessed.
 */
function resolveFleetHostName(
  directory: FleetHostDirectory,
  raw: string | null | undefined,
): FleetHostResolution {
  const name = raw?.trim() ?? "";
  if (!name || name.toLowerCase() === LOCAL_FLEET_HOST) {
    return { ok: true, kind: "local", label: LOCAL_FLEET_HOST };
  }
  const key = name.toLowerCase();
  // The listing is the resolver's only source of names, so fleet_list_hosts
  // shows exactly what a host argument may use.
  const matched = listFleetHosts(directory).filter((entry) =>
    entry.names.some((candidate) => candidate.toLowerCase() === key),
  );
  if (matched.length > 1) {
    const hosts = matched.map((entry) => (entry.self ? `this host (${entry.host})` : entry.host));
    return {
      ok: false,
      reason: "ambiguous",
      error:
        `Host "${name}" is ambiguous: it names ${hosts.join(" and ")}. ` +
        "Pass another name of the host you mean; fleet_list_hosts lists them.",
    };
  }
  const entry = matched[0];
  if (entry?.self) {
    return { ok: true, kind: "local", label: name };
  }
  if (entry) {
    return { ok: true, kind: "peer", peerName: entry.host, label: entry.host };
  }
  return {
    ok: false,
    reason: "unknown",
    error: `Host "${name}" is not a configured peer or this host. ${describeFleetHosts(directory)}`,
  };
}

/** A peer's identity as captured from its server_info at hello. */
export interface FleetPeerIdentity {
  name: string;
  serverId: string | null;
  hostname: string | null;
  missionControlHostAlias: string | null;
  hostNames: readonly string[];
}

/** The peer-manager surface the directory reads; every method is optional. */
export interface FleetHostPeerSource {
  getPeerStatuses?(): readonly Pick<MissionControlPeerStatus, "name" | "state" | "lastSeenAt">[];
  getPeerIdentities?(): readonly FleetPeerIdentity[];
  getPeerServerId?(name: string): string | null;
  getPeerStatus?(name: string): Pick<MissionControlPeerStatus, "name"> | null;
}

export interface FleetHostSources {
  selfLabel: string;
  serverId?: string | null;
  hostname?: string | null;
  hostAlias?: string | null;
  /** This daemon's DNS names (daemon.hostnames), read per call so config reloads apply. */
  hostNames?: (() => readonly string[] | null | undefined) | null;
  /** Central routing.hostAliases (serverId → names), read per call. */
  hostAliases?: (() => Readonly<Record<string, readonly string[]>> | null | undefined) | null;
  peerManager?: FleetHostPeerSource | null;
}

function buildFleetHostDirectory(sources: FleetHostSources): FleetHostDirectory {
  const aliases = sources.hostAliases?.() ?? {};
  const peerManager = sources.peerManager ?? null;
  const identities = new Map(
    (peerManager?.getPeerIdentities?.() ?? []).map((identity) => [identity.name, identity]),
  );
  const peers = (peerManager?.getPeerStatuses?.() ?? []).map((status): FleetPeerHost => {
    const identity = identities.get(status.name);
    const serverId = identity?.serverId ?? peerManager?.getPeerServerId?.(status.name) ?? null;
    return {
      name: status.name,
      state: status.state,
      lastSeenAt: status.lastSeenAt ?? null,
      serverId,
      hostname: identity?.hostname ?? null,
      hostAlias: identity?.missionControlHostAlias ?? null,
      hostNames: identity?.hostNames ?? [],
      aliases: serverId ? (aliases[serverId] ?? []) : [],
    };
  });
  return {
    selfLabel: sources.selfLabel,
    self: {
      serverId: sources.serverId ?? null,
      hostname: sources.hostname ?? null,
      hostAlias: sources.hostAlias ?? null,
      hostNames: sources.hostNames?.() ?? [],
      aliases: sources.serverId ? (aliases[sources.serverId] ?? []) : [],
    },
    peers,
  };
}

export interface FleetHostResolver {
  directory(): FleetHostDirectory;
  resolve(raw: string | null | undefined): FleetHostResolution;
}

export function createFleetHostResolver(sources: FleetHostSources): FleetHostResolver {
  return {
    directory: () => buildFleetHostDirectory(sources),
    resolve(raw) {
      const resolution = resolveFleetHostName(buildFleetHostDirectory(sources), raw);
      if (resolution.ok || resolution.reason === "ambiguous") {
        return resolution;
      }
      // A peer manager that cannot list its peers still knows its own names.
      const status = sources.peerManager?.getPeerStatus?.(raw?.trim() ?? "") ?? null;
      return status
        ? { ok: true, kind: "peer", peerName: status.name, label: status.name }
        : resolution;
    },
  };
}

/**
 * Whether two host arguments name the same host. Falls back to
 * case-insensitive equality when either name does not resolve, so a host
 * hint never silently matches an unknown name.
 */
export function isSameFleetHost(
  resolver: Pick<FleetHostResolver, "resolve">,
  hostA: string,
  hostB: string,
): boolean {
  const a = resolver.resolve(hostA);
  const b = resolver.resolve(hostB);
  if (a.ok && b.ok) {
    return a.kind === "local" ? b.kind === "local" : b.kind === "peer" && a.peerName === b.peerName;
  }
  return hostA.trim().toLowerCase() === hostB.trim().toLowerCase();
}

/** The `host` description on tools that take a fleet-wide id (the host is only a hint). */
export const FLEET_HOST_HINT_DESCRIPTION =
  "Optional host hint; the id is fleet-wide, so you can omit it. Any name fleet_list_hosts lists " +
  "for the host works ('local' is the host answering this call).";

/** The `host` description on tools that act on one host the caller picks. */
export const FLEET_HOST_DESCRIPTION =
  "Any name fleet_list_hosts lists for the host: its name in fleet results, an alias, a short DNS " +
  "name, its OS hostname or serverId ('local' is the host answering this call).";
