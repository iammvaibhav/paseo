import type { HostConnection, HostProfile } from "@/types/host-connection";

function hostnameFromBrowserEditorUrl(browserEditorUrl: string | null | undefined): string | null {
  const raw = browserEditorUrl?.trim();
  if (!raw) {
    return null;
  }
  try {
    const hostname = new URL(raw).hostname.trim();
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

function hostnameFromDirectTcpEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("]")) {
    // [ipv6]:port
    const end = trimmed.indexOf("]");
    const host = trimmed.slice(1, end).trim();
    return host.length > 0 ? host : null;
  }
  const host = trimmed.split(":")[0]?.trim();
  return host && host.length > 0 ? host : null;
}

function hostnameFromDirectTcpConnections(
  connections: readonly HostConnection[],
  preferredConnectionId: string | null | undefined,
): string | null {
  const preferred = preferredConnectionId
    ? connections.find((c) => c.id === preferredConnectionId)
    : undefined;
  const directTcp =
    (preferred?.type === "directTcp" ? preferred : null) ??
    connections.find((c) => c.type === "directTcp");
  if (!directTcp || directTcp.type !== "directTcp") {
    return null;
  }
  return hostnameFromDirectTcpEndpoint(directTcp.endpoint ?? "");
}

function hostnameFromSshHost(sshHost: string | null | undefined): string | null {
  const trimmed = sshHost?.trim();
  if (!trimmed) {
    return null;
  }
  const at = trimmed.lastIndexOf("@");
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

/**
 * Host address the desktop webview should use to reach a remote Plannotator
 * session (VPN/LAN). Null for local daemons (always 127.0.0.1).
 */
export function resolvePlannotatorEmbedHost(input: {
  isLocalDaemon: boolean;
  browserEditorUrl?: string | null;
  hostProfile?: HostProfile | null;
}): string | null {
  if (input.isLocalDaemon) {
    return null;
  }

  const fromBrowserEditor = hostnameFromBrowserEditorUrl(input.browserEditorUrl);
  if (fromBrowserEditor) {
    return fromBrowserEditor;
  }

  const hostProfile = input.hostProfile ?? null;
  const fromTcp = hostnameFromDirectTcpConnections(
    hostProfile?.connections ?? [],
    hostProfile?.preferredConnectionId,
  );
  if (fromTcp) {
    return fromTcp;
  }

  const fromSsh = hostnameFromSshHost(hostProfile?.sshHost);
  if (fromSsh) {
    return fromSsh;
  }

  return hostProfile?.label?.trim() || null;
}
