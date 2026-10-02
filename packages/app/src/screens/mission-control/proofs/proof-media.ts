import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/session-store";

// ============================================================================
// Proof media loading. Proofs with a `path` are files on the agent's host;
// the app resolves them through the mission_control.media.fetch RPC (uniform
// path — always the RPC, never a guessed URL). The daemon serves host "local"
// and proxies to peers, so the app asks the proof's own host client with
// host "local".
//
// Fetching is lazy: the collapsed proof sections mount their body only when
// expanded, so the RPC fires once per expand. Results are cached per
// (serverId, path) so collapsing/expanding does not refetch. Entries are
// scoped to the host's connection generation (the session store's
// historySyncGeneration, bumped on every offline -> online transition): an
// entry fetched under an older generation is treated as a miss, so a host
// reconnect always refetches — the file behind `path` may be gone or
// different on the other side of the reconnect.
// ============================================================================

export type ProofMediaState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: string; mimeType: string; fileName: string }
  | { status: "error"; error: string };

interface ProofMediaCacheEntry {
  data: string;
  mimeType: string;
  fileName: string;
  /** Host connection generation the entry was fetched under; entries from an
   * older generation (pre-reconnect) are never served. */
  connectionGeneration: number;
}

const proofMediaCache = new Map<string, ProofMediaCacheEntry>();

function proofMediaCacheKey(serverId: string, path: string): string {
  return `${serverId}:${path}`;
}

export function useProofMedia(input: { serverId: string; path: string }): ProofMediaState {
  const { serverId, path } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // Per-host connection generation: the runtime bumps the session's
  // historySyncGeneration exactly when this host transitions offline -> online
  // (host-runtime's didTransitionOnline), so a bump means every cached entry
  // for the host came from the previous connection. Tagging entries with the
  // generation and rejecting mismatches at read time invalidates the cache on
  // reconnect even when no proof section was mounted to observe the
  // transition.
  const connectionGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0,
  );

  const [state, setState] = useState<ProofMediaState>(() => {
    const cached = proofMediaCache.get(proofMediaCacheKey(serverId, path));
    return cached && cached.connectionGeneration === connectionGeneration
      ? { status: "ready", ...cached }
      : { status: "idle" };
  });

  useEffect(() => {
    const cacheKey = proofMediaCacheKey(serverId, path);
    const cached = proofMediaCache.get(cacheKey);
    if (cached && cached.connectionGeneration === connectionGeneration) {
      setState({ status: "ready", ...cached });
      return;
    }
    if (!path) {
      // No path — nothing to fetch. Callers render nothing for empty paths.
      setState({ status: "idle" });
      return;
    }
    if (!client) {
      setState({ status: "error", error: "Host not connected" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void client
      .missionControlMediaFetch({ host: "local", path })
      .then((payload) => {
        if (cancelled) {
          return { ok: false };
        }
        if (payload.ok && payload.data && payload.mimeType) {
          const entry: ProofMediaCacheEntry = {
            data: payload.data,
            mimeType: payload.mimeType,
            fileName: payload.fileName ?? path.split("/").pop() ?? path,
            connectionGeneration,
          };
          proofMediaCache.set(cacheKey, entry);
          setState({ status: "ready", ...entry });
          return { ok: true };
        }
        setState({ status: "error", error: payload.error ?? "Unable to fetch proof" });
        return { ok: false };
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { ok: false };
      });
    return () => {
      cancelled = true;
    };
  }, [client, connectionGeneration, path, serverId]);

  return state;
}
