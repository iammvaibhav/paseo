import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WebSocketLike } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { MissionControlPeerStatus } from "@getpaseo/protocol/mission-control/types";
import {
  buildDaemonWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";
import { WebSocket } from "ws";
import type { Logger } from "pino";

import type { PeerConfig } from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * WebSocket factory for Node.js, mirroring the CLI's peer connections
 * (packages/cli/src/utils/client.ts createNodeWebSocketFactory).
 */
function createNodeWebSocketFactory() {
  return (
    url: string,
    options?: { headers?: Record<string, string>; protocols?: string[]; socketPath?: string },
  ): WebSocketLike => {
    return new WebSocket(url, options?.protocols, {
      headers: options?.headers,
      ...(options?.socketPath ? { socketPath: options.socketPath } : {}),
    }) as unknown as WebSocketLike;
  };
}

/**
 * Convert a peer config URL (e.g. tcp://host:6767) into a ws:// URL the
 * DaemonClient can dial, mirroring resolveDaemonTarget in the CLI.
 */
function resolvePeerWebSocketUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("tcp://")) {
    const parsed = parseConnectionUri(trimmed);
    const endpoint = normalizeHostPort(
      parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
    );
    return buildDaemonWebSocketUrl(endpoint, { useTls: parsed.useTls });
  }
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  return `ws://${trimmed}/ws`;
}

function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) {
    return "never";
  }
  const parsed = Date.parse(lastSeenAt);
  if (Number.isNaN(parsed)) {
    return lastSeenAt;
  }
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function buildPeerUnreachableError(name: string, lastSeenAt: string | null): Error {
  return new Error(
    `Host "${name}" unreachable since ${formatLastSeen(lastSeenAt)} (likely asleep). ` +
      "Work queued for other hosts is unaffected; retry after it wakes.",
  );
}

export interface PeerManagerOptions {
  peers: PeerConfig[];
  logger: Logger;
  appVersion?: string;
  /**
   * Called whenever a peer connection transitions to online (hello complete).
   * Used for central-config sync-on-connect: the commander host pushes its
   * current snapshot to the peer that just connected so a fresh or
   * restarted peer never serves stale fleet policy. The callback receives
   * the peer's configured name.
   */
  onPeerOnline?: (peerName: string) => void;
}

interface PeerConnection {
  config: PeerConfig;
  client: DaemonClient;
  status: MissionControlPeerStatus;
  serverId: string | null;
  /** Peer daemon's own hostname (server_info), captured at setPeerOnline. */
  hostname: string | null;
  /** Peer daemon's missionControl.hostAlias (server_info), captured at setPeerOnline. */
  missionControlHostAlias: string | null;
}

/**
 * Pure peer-identity matcher (exported for unit tests): resolves a
 * commanderHost-style designation to the peer's configured name. Mirrors
 * isDesignatedCommanderHost semantics — trimmed, case-sensitive, alias only
 * when non-null — and matches (in order): configured name, serverId,
 * hostname, missionControl hostAlias. Runtime-only: a stored designation
 * that names a peer's hostname/alias (e.g. "vaibhav-dev" naming the peer
 * iammvaibhav) resolves without rewriting central config.
 */
export function resolvePeerIdentityName(
  peers: readonly PeerIdentity[],
  name: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") {
    return null;
  }
  const peer =
    peers.find((p) => p.config.name === trimmed) ??
    peers.find((p) => p.serverId === trimmed) ??
    peers.find((p) => p.hostname === trimmed) ??
    peers.find(
      (p) => p.missionControlHostAlias !== null && p.missionControlHostAlias === trimmed,
    ) ??
    null;
  return peer?.config.name ?? null;
}

export interface PeerIdentity {
  config: { name: string };
  serverId: string | null;
  hostname: string | null;
  missionControlHostAlias: string | null;
}

export class PeerManager {
  private readonly peers: PeerConnection[] = [];
  private readonly logger: Logger;
  private readonly appVersion: string | undefined;
  private readonly onPeerOnline: ((peerName: string) => void) | undefined;

  constructor(options: PeerManagerOptions) {
    this.logger = options.logger.child({ module: "peers" });
    this.appVersion = options.appVersion;
    this.onPeerOnline = options.onPeerOnline;
    for (const config of options.peers) {
      this.peers.push(this.createPeer(config));
    }
    for (const peer of this.peers) {
      peer.client.connect().catch((error) => {
        this.logger.warn({ err: error, peer: peer.config.name }, "Peer connection closed");
      });
    }
  }

  getPeerStatuses(): MissionControlPeerStatus[] {
    return this.peers.map((peer) => ({ ...peer.status }));
  }

  /**
   * Resolve a commanderHost-style designation (peer name, serverId, peer
   * hostname, or missionControl hostAlias) to the peer's configured name, or
   * null when nothing matches. Runtime-only: a stored designation naming a
   * peer's hostname/alias resolves without rewriting central config.
   */
  resolvePeerName(name: string): string | null {
    return resolvePeerIdentityName(this.peers, name);
  }

  getPeerStatus(name: string): MissionControlPeerStatus | null {
    return this.findPeer(name)?.status ?? null;
  }

  getPeerClient(name: string): DaemonClient | null {
    return this.findPeer(name)?.client ?? null;
  }

  private findPeer(name: string): PeerConnection | null {
    const resolved = this.resolvePeerName(name);
    if (resolved === null) {
      return null;
    }
    return this.peers.find((peer) => peer.config.name === resolved) ?? null;
  }

  async close(): Promise<void> {
    await Promise.all(this.peers.map((peer) => peer.client.close().catch(() => undefined)));
  }

  private createPeer(config: PeerConfig): PeerConnection {
    const client = new DaemonClient({
      url: resolvePeerWebSocketUrl(config.url),
      clientId: `paseo-peer:${config.name}`,
      clientType: "cli",
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
      ...(config.password ? { password: config.password } : {}),
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      webSocketFactory: createNodeWebSocketFactory(),
      reconnect: {
        enabled: true,
        baseDelayMs: DEFAULT_RECONNECT_BASE_DELAY_MS,
        maxDelayMs: DEFAULT_RECONNECT_MAX_DELAY_MS,
      },
    });
    const peer: PeerConnection = {
      config,
      client,
      status: {
        name: config.name,
        url: config.url,
        state: "unreachable",
        lastSeenAt: null,
      },
      serverId: null,
      hostname: null,
      missionControlHostAlias: null,
    };

    client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        this.setPeerOnline(peer);
      } else if (peer.status.state === "online") {
        peer.status = { ...peer.status, state: "unreachable" };
        this.logger.info({ peer: config.name }, "Peer unreachable");
      }
    });

    return peer;
  }

  private setPeerOnline(peer: PeerConnection): void {
    const serverInfo = peer.client.getLastServerInfoMessage();
    const serverId = serverInfo?.serverId ?? null;
    peer.serverId = serverId;
    peer.hostname = serverInfo?.hostname ?? null;
    peer.missionControlHostAlias = serverInfo?.missionControlHostAlias ?? null;
    peer.status = {
      name: peer.config.name,
      url: peer.config.url,
      state: "online",
      lastSeenAt: new Date().toISOString(),
    };
    this.logger.info({ peer: peer.config.name, serverId }, "Peer online");
    try {
      this.onPeerOnline?.(peer.config.name);
    } catch (error) {
      this.logger.warn({ err: error, peer: peer.config.name }, "Peer online hook failed");
    }
  }
}
