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
// (serverId, path) so collapsing/expanding does not refetch.
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
}

const proofMediaCache = new Map<string, ProofMediaCacheEntry>();

function proofMediaCacheKey(serverId: string, path: string): string {
  return `${serverId}:${path}`;
}

export function useProofMedia(input: { serverId: string; path: string }): ProofMediaState {
  const { serverId, path } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  const [state, setState] = useState<ProofMediaState>(() => {
    const cached = proofMediaCache.get(proofMediaCacheKey(serverId, path));
    return cached ? { status: "ready", ...cached } : { status: "idle" };
  });

  useEffect(() => {
    const cacheKey = proofMediaCacheKey(serverId, path);
    const cached = proofMediaCache.get(cacheKey);
    if (cached) {
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
  }, [client, path, serverId]);

  return state;
}
