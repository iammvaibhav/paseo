import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";

/**
 * Node.js WebSocket factory for DaemonClient.
 */
export function createNodeWebSocketFactory() {
  return (url, options) =>
    new WebSocket(url, options?.protocols, {
      headers: options?.headers,
      ...(options?.socketPath ? { socketPath: options.socketPath } : {}),
    });
}

/**
 * Instantiate a DaemonClient connected to the specified wsUrl.
 */
export function createDaemonClient(
  wsUrl,
  clientId = "verify-stack-client",
  password = null,
  options = {},
) {
  return new DaemonClient({
    url: wsUrl,
    clientId,
    clientType: "cli",
    ...(password ? { password } : {}),
    webSocketFactory: createNodeWebSocketFactory(),
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
    reconnect: options.reconnect ?? {
      enabled: true,
      baseDelayMs: 200,
      maxDelayMs: 1000,
    },
    ...options,
  });
}

/**
 * Fetch the peers list from a commander daemon over its WebSocket.
 */
export async function fetchPeersList(wsUrl, password = null) {
  const client = createDaemonClient(wsUrl, `fetch-peers-${Date.now()}`, password);
  try {
    await client.connect();
    return await client.missionControlPeersList();
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Verify peering is live between commander and a named peer.
 * Polls until the peer reports state: "online".
 */
export async function verifyPeeringLive({
  commanderWsUrl,
  peerName = "peer-b",
  timeoutMs = 15000,
  pollIntervalMs = 200,
  password = null,
}) {
  const client = createDaemonClient(
    commanderWsUrl,
    `verify-peer-${peerName}-${Date.now()}`,
    password,
  );
  const start = Date.now();
  let lastPayload = null;
  try {
    await client.connect();

    while (Date.now() - start < timeoutMs) {
      try {
        const payload = await client.missionControlPeersList();
        lastPayload = payload;
        const peer = payload.peers?.find((p) => p.name === peerName);
        if (peer && peer.state === "online") {
          return {
            ok: true,
            peer,
            peers: payload.peers,
            payload,
          };
        }
      } catch {
        // Retry until timeout
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `Peering check timed out after ${timeoutMs}ms waiting for peer "${peerName}" to become online. Last payload: ${JSON.stringify(lastPayload)}`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
