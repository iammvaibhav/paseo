import { compare } from "bcryptjs";
import type { RemoteMcpClient } from "../persisted-config.js";

export async function authenticateRemoteMcpClient(
  token: string | null,
  remoteClients: readonly RemoteMcpClient[],
): Promise<RemoteMcpClient | null> {
  if (!token) {
    return null;
  }
  let matchedClient: RemoteMcpClient | null = null;
  for (const client of remoteClients) {
    const match = await compare(token, client.tokenHash);
    if (match && !matchedClient) {
      matchedClient = client;
    }
  }
  return matchedClient;
}
