import { createHash } from "node:crypto";
import { compare } from "bcryptjs";
import type { RemoteMcpClient } from "../persisted-config.js";

// bcryptjs at cost 12 takes ~0.6 s per compare on the ARM hosts, and the MCP
// endpoint is stateless (one HTTP request per tool call). A token that already
// matched is remembered by its SHA-256 together with the stored hash it matched,
// so rotating or removing a client's tokenHash in config.json revokes it on the
// next request. Misses are never cached: a wrong token always pays bcrypt.
const VERIFIED_LIMIT = 64;
const verified = new Map<string, string>();

export async function authenticateRemoteMcpClient(
  token: string | null,
  remoteClients: readonly RemoteMcpClient[],
): Promise<RemoteMcpClient | null> {
  if (!token) {
    return null;
  }
  const digest = createHash("sha256").update(token).digest("hex");
  for (const client of remoteClients) {
    if (verified.get(`${digest}:${client.tokenHash}`) === client.name) {
      return client;
    }
  }
  let matchedClient: RemoteMcpClient | null = null;
  for (const client of remoteClients) {
    const match = await compare(token, client.tokenHash);
    if (match && !matchedClient) {
      matchedClient = client;
    }
  }
  if (matchedClient) {
    if (verified.size >= VERIFIED_LIMIT) verified.clear();
    verified.set(`${digest}:${matchedClient.tokenHash}`, matchedClient.name);
  }
  return matchedClient;
}
