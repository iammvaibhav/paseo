import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { HostProfile } from "@/types/host-connection";

export interface MacWakeDraft {
  host: string;
  mac: string;
  token: string;
}

export interface MacWakeDraftErrors {
  host?: "required";
  mac?: "invalid";
  token?: "required";
}

const MAC_PATTERN = /^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i;

/** An empty token is allowed only when one is already saved (it then stays). */
export function validateMacWakeDraft(draft: MacWakeDraft, hasToken: boolean): MacWakeDraftErrors {
  const errors: MacWakeDraftErrors = {};
  const host = draft.host.trim();
  if (host.length === 0 || /\s/.test(host)) errors.host = "required";
  if (!MAC_PATTERN.test(draft.mac.trim())) errors.mac = "invalid";
  if (!hasToken && draft.token.trim().length === 0) errors.token = "required";
  return errors;
}

function isPrivateLanIPv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * The Mac's Wi-Fi address from the host record, when one of its direct connections uses a home
 * LAN address. NetBird (100.64/10) addresses are skipped: a sleeping Mac's VPN is down.
 */
export function lanAddressFromHost(host: HostProfile): string | null {
  for (const connection of host.connections) {
    if (connection.type !== "directTcp") continue;
    try {
      const { host: address } = parseHostPort(connection.endpoint);
      if (isPrivateLanIPv4(address)) return address;
    } catch {
      // A malformed endpoint offers no default.
    }
  }
  return null;
}
