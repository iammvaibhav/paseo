import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Logger } from "pino";
import type { MissionControlPeerStatus } from "@getpaseo/protocol/mission-control/types";

// Structural slice of PeerManager the media fetch needs, so tests and the
// session can hand it a fake without a PeerManager instance.
export interface ProofMediaPeerManager {
  getPeerStatus(name: string): MissionControlPeerStatus | null;
  getPeerClient(name: string): DaemonClient | null;
}

// ============================================================================
// Proof media fetch (mission_control.media.fetch) — the ONE server addition
// this wave. The app resolves proof.path through this RPC on the proof's own
// host (host "local"); cross-host calls proxy over peering like the other
// fleet RPCs. Session auth covers the client; the caps below bound what any
// authenticated caller can pull.
//
// Retention tie-in: retention prunes cards (events), never files. When the
// card is gone the path is simply a file on disk — either still readable or
// a 404 — so there is nothing app-side to prune. This module only serves.
// ============================================================================

/** Size cap: proof media is a preview surface, not a file transfer. */
export const MEDIA_FETCH_MAX_BYTES = 10 * 1024 * 1024;

/** Mime allowlist — images/video/text per spec; text covers api/code excerpts. */
const MEDIA_ALLOWED_MIME_PREFIXES = ["image/", "video/", "text/"] as const;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "text/json",
  ".log": "text/plain",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".css": "text/css",
  ".html": "text/html",
  ".diff": "text/plain",
  ".patch": "text/plain",
};

function mimeTypeForPath(filePath: string): string | null {
  const mime = EXTENSION_MIME_TYPES[extname(filePath).toLowerCase()];
  if (!mime) {
    return null;
  }
  return MEDIA_ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) ? mime : null;
}

export interface ProofMediaFetchResult {
  ok: boolean;
  error?: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  data?: string;
}

/** Serve a proof file from this daemon's filesystem. Paths must be absolute. */
export async function fetchProofMediaLocal(input: {
  path: string;
}): Promise<ProofMediaFetchResult> {
  const { path } = input;
  if (!path || !isAbsolute(path)) {
    return { ok: false, error: "Proof path must be absolute" };
  }
  const resolved = resolve(path);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    return { ok: false, error: `Proof file not found: ${path}` };
  }
  if (!fileStat.isFile()) {
    return { ok: false, error: `Proof path is not a file: ${path}` };
  }
  if (fileStat.size > MEDIA_FETCH_MAX_BYTES) {
    return {
      ok: false,
      error: `Proof file exceeds the ${MEDIA_FETCH_MAX_BYTES / 1024 / 1024}MB media cap`,
    };
  }
  const mimeType = mimeTypeForPath(resolved);
  if (!mimeType) {
    return { ok: false, error: `Proof file type is not allowed: ${path}` };
  }
  const data = await readFile(resolved);
  return {
    ok: true,
    mimeType,
    fileName: resolved.split("/").pop() ?? resolved,
    sizeBytes: fileStat.size,
    data: data.toString("base64"),
  };
}

/**
 * Resolve a media fetch against this daemon ("local") or a named peer
 * (proxied over peering, same payload shape back). Mirrors the fleet tool
 * host resolution: unknown or unreachable hosts fail loudly.
 */
export async function resolveMissionControlMediaFetch(input: {
  host: string;
  path: string;
  peerManager: ProofMediaPeerManager | null;
  logger: Logger;
}): Promise<ProofMediaFetchResult> {
  const { host, path, peerManager, logger } = input;
  if (host === "local") {
    return fetchProofMediaLocal({ path });
  }
  if (!peerManager) {
    return { ok: false, error: "Peering is not configured on this host" };
  }
  const peerStatus = peerManager.getPeerStatus(host);
  if (!peerStatus) {
    return { ok: false, error: `Host "${host}" is not a configured peer` };
  }
  if (peerStatus.state !== "online") {
    return { ok: false, error: `Host "${host}" is unreachable` };
  }
  const client: DaemonClient | null = peerManager.getPeerClient(host);
  if (!client) {
    return { ok: false, error: `Host "${host}" has no peer client` };
  }
  try {
    const payload = await client.missionControlMediaFetch({ host: "local", path });
    return {
      ok: payload.ok,
      ...(payload.error ? { error: payload.error } : {}),
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
      ...(payload.fileName ? { fileName: payload.fileName } : {}),
      ...(typeof payload.sizeBytes === "number" ? { sizeBytes: payload.sizeBytes } : {}),
      ...(payload.data ? { data: payload.data } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, host, path }, "mission_control.media.fetch.peer_failed");
    return { ok: false, error: `Peer media fetch failed: ${message}` };
  }
}
