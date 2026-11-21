import type { NetworkInterfaceInfo } from "node:os";

const WILDCARD_OR_LOOPBACK: Record<string, true> = {
  "0.0.0.0": true,
  "::": true,
  "[::]": true,
  "127.0.0.1": true,
  "::1": true,
  localhost: true,
};

/** 100.64.0.0/10: the carrier-grade NAT range NetBird and Tailscale assign. */
function isOverlayAddress(address: string): boolean {
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/**
 * The URL itsaplan POSTs this daemon's webhooks to. itsaplan runs on another
 * host, so the URL must name an address that host can reach. A daemon bound to
 * a wildcard (or loopback) address used to register `127.0.0.1`, which is
 * itsaplan's own host: boards created on dev and blrofc3 after itsaplan moved to
 * prod (LLMGATEWAY, SUPPLYGRAP, VIDEOUNDER) delivered to prod's daemon instead.
 * Such a daemon now registers its fleet overlay address; with none, loopback is
 * kept (itsaplan on the same host).
 */
export function createItsaplanWebhookUrl(
  listenTarget:
    | { type: "tcp"; host: string; port: number }
    | { type: "socket" | "pipe"; path: string }
    | null,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  let host = listenTarget.host;
  if (WILDCARD_OR_LOOPBACK[host]) {
    const overlay = Object.values(interfaces)
      .flat()
      .find(
        (entry) => entry?.family === "IPv4" && !entry.internal && isOverlayAddress(entry.address),
      );
    host = overlay?.address ?? (host.includes(":") ? "::1" : "127.0.0.1");
  }
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${listenTarget.port}/api/itsaplan/webhook`;
}
