import type { HostProfile } from "@/types/host-connection";
import { resolvePlannotatorEmbedHost } from "@/workspace/plannotator-embed-host";

/**
 * Port the itsaplan HTTPS proxy listens on in the default dev setup. Only used
 * when the user has not configured an explicit origin — a configured origin
 * always wins, including its scheme and port.
 */
export const ITSAPLAN_DEFAULT_PORT = 8443;

export type ItsaplanOriginSource = "override" | "derived";

export interface ItsaplanEmbedInput {
  isLocalDaemon: boolean;
  /**
   * Per-device override configured in Settings → General ("itsaplan URL"),
   * e.g. `https://10.7.0.1:8443`. Empty/unset falls back to deriving the origin
   * from the host the way Plannotator resolves its embed host.
   */
  configuredOrigin?: string | null;
  browserEditorUrl?: string | null;
  hostProfile?: HostProfile | null;
}

export interface ItsaplanEmbedOrigin {
  /** Bare origin (`https://host:port`) — the WebView/iframe entry point. */
  origin: string;
  source: ItsaplanOriginSource;
}

const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "0.0.0.0": true,
  "::1": true,
};

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return LOOPBACK_HOSTNAMES[normalized] === true || normalized.endsWith(".localhost");
}

/**
 * Parse a user-configured itsaplan origin. Accepts values with or without an
 * explicit scheme (https assumed); anything that is not http(s), or that does
 * not parse, is treated as unconfigured rather than guessed at.
 */
export function normalizeItsaplanOrigin(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Origin the embedded browser surface should load itsaplan from.
 *
 * Mirrors resolvePlannotatorEmbedHost / buildPlannotatorEmbedUrl: on a local
 * daemon the tool lives on loopback; for a remote daemon the hostname is lifted
 * from the host profile (browser editor URL → direct-TCP endpoint → SSH host →
 * label). A loopback override seen from a remote desktop is rewritten to the
 * resolved embed hostname, keeping the override's scheme and port — same
 * rewrite Plannotator applies to daemon-reported loopback URLs. Null means the
 * tool cannot be located at all (no hosts, or a remote daemon with no
 * resolvable address and no override): the caller shows the not-configured
 * state.
 */
export function resolveItsaplanEmbedOrigin(input: ItsaplanEmbedInput): ItsaplanEmbedOrigin | null {
  const override = normalizeItsaplanOrigin(input.configuredOrigin);
  const embedHost = input.isLocalDaemon
    ? null
    : resolvePlannotatorEmbedHost({
        isLocalDaemon: false,
        // resolvePlannotatorEmbedHost only sees an explicitly passed URL;
        // callers like diff-pane pass the profile's browserEditorUrl alongside
        // the profile, so mirror that here.
        browserEditorUrl: input.browserEditorUrl ?? input.hostProfile?.browserEditorUrl ?? null,
        hostProfile: input.hostProfile,
      });

  if (override) {
    if (!input.isLocalDaemon && embedHost) {
      try {
        const url = new URL(override);
        if (isLoopbackHostname(url.hostname)) {
          url.hostname = embedHost;
          return { origin: url.origin, source: "override" };
        }
      } catch {
        // Unreachable: normalizeItsaplanOrigin already validated this URL.
      }
    }
    return { origin: override, source: "override" };
  }

  if (input.isLocalDaemon) {
    return { origin: `https://localhost:${ITSAPLAN_DEFAULT_PORT}`, source: "derived" };
  }
  if (!embedHost) {
    return null;
  }
  return { origin: `https://${embedHost}:${ITSAPLAN_DEFAULT_PORT}`, source: "derived" };
}
