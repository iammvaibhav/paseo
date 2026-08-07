import { DaemonClient, type WebSocketLike } from "@getpaseo/client";
import type {
  MissionControlEvent,
  MissionControlPeerStatus,
} from "@getpaseo/protocol/mission-control/types";
import {
  buildDaemonWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";
import { WebSocket } from "ws";
import type { Logger } from "pino";

import type { MissionControlDigestSink } from "../mission-control/digest.js";
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
  missionControlDigest?: MissionControlDigestSink;
}

interface PeerConnection {
  config: PeerConfig;
  client: DaemonClient;
  status: MissionControlPeerStatus;
  serverId: string | null;
}

export class PeerManager {
  private readonly peers: PeerConnection[] = [];
  private readonly logger: Logger;
  private readonly appVersion: string | undefined;
  private readonly missionControlDigest: MissionControlDigestSink | undefined;

  constructor(options: PeerManagerOptions) {
    this.logger = options.logger.child({ module: "peers" });
    this.appVersion = options.appVersion;
    this.missionControlDigest = options.missionControlDigest;
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

  getPeerStatus(name: string): MissionControlPeerStatus | null {
    return this.peers.find((peer) => peer.config.name === name)?.status ?? null;
  }

  getPeerClient(name: string): DaemonClient | null {
    return this.peers.find((peer) => peer.config.name === name)?.client ?? null;
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
    };

    client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        this.setPeerOnline(peer);
      } else if (peer.status.state === "online") {
        peer.status = { ...peer.status, state: "unreachable" };
        this.logger.info({ peer: config.name }, "Peer unreachable");
      }
    });

    client.on("mission_control_event", (message) => {
      this.forwardPeerEvent(peer, message.event);
    });

    return peer;
  }

  private setPeerOnline(peer: PeerConnection): void {
    const serverId = peer.client.getLastServerInfoMessage()?.serverId ?? null;
    peer.serverId = serverId;
    peer.status = {
      name: peer.config.name,
      url: peer.config.url,
      state: "online",
      lastSeenAt: new Date().toISOString(),
    };
    this.logger.info({ peer: peer.config.name, serverId }, "Peer online");
  }

  private forwardPeerEvent(peer: PeerConnection, event: MissionControlEvent): void {
    if (!this.missionControlDigest) {
      return;
    }
    const serverId = peer.client.getLastServerInfoMessage()?.serverId ?? peer.serverId;
    if (!serverId) {
      this.logger.warn(
        { peer: peer.config.name, eventId: event.id },
        "Dropping peer event without serverId",
      );
      return;
    }
    this.missionControlDigest.enqueue(event, { serverId, hostName: peer.config.name });
  }
}
