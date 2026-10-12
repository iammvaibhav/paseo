import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import {
  agentSearchWords,
  matchesAgentSearchWords,
  type AgentSearchResponse,
} from "@getpaseo/protocol/agent-search";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarSearchStore } from "@/stores/sidebar-search-store";

/** Long enough that a typed word is one jev pass, short enough to feel live. */
const REMOTE_SEARCH_DEBOUNCE_MS = 250;

const EMPTY_KEYS: readonly string[] = [];
const KEY_SEPARATOR = "\u0000";

export interface SidebarSearchArchivedMatch {
  serverId: string;
  agentId: string;
  title: string | null;
  cwd: string;
  score: number | null;
}

export interface SidebarSearch {
  /** A non-blank query is narrowing the sidebar. */
  active: boolean;
  words: readonly string[];
  /** `serverId:agentId` of every matching active agent. */
  agentKeys: ReadonlySet<string>;
  /** `serverId:workspaceId` of every workspace holding a matching agent. */
  workspaceKeys: ReadonlySet<string>;
  /** Archived matches, best first; empty unless archived agents are included. */
  archivedMatches: SidebarSearchArchivedMatch[];
  /** A host has not answered the current query yet. */
  pending: boolean;
  /** At least one host ranked with jev; false = word matches only. */
  semantic: boolean;
  /** Slowest host's daemon-side search time for the current query. */
  latencyMs: number | null;
}

interface RemoteState {
  query: string;
  includeArchived: boolean;
  byServer: ReadonlyMap<string, AgentSearchResponse["payload"]>;
  pendingServerIds: ReadonlySet<string>;
}

const EMPTY_REMOTE: RemoteState = {
  query: "",
  includeArchived: false,
  byServer: new Map(),
  pendingServerIds: new Set(),
};

/**
 * What the sidebar search bar matches. Word matches over the agents already in
 * the session store show instantly; each host's jev search (agent.search.*)
 * widens them about half a second later with agents whose launch prompt or
 * reported status fits the query without sharing its words.
 */
export function useSidebarSearch(): SidebarSearch {
  const query = useSidebarSearchStore((state) => state.query.trim());
  const includeArchived = useSidebarSearchStore((state) => state.includeArchived);
  const words = useMemo(() => agentSearchWords(query), [query]);

  // Flat `serverId␀agentId␀workspaceId` strings so useShallow can keep the
  // previous array while the store churns on unrelated agent updates.
  const localEntries = useSessionStore(
    useShallow((state) => {
      if (words.length === 0) return EMPTY_KEYS;
      const entries: string[] = [];
      for (const [serverId, session] of Object.entries(state.sessions)) {
        for (const agent of session.agents.values()) {
          if (agent.archivedAt) continue;
          if (!matchesAgentSearchWords(words, [agent.title, agent.name, agent.shortDescription])) {
            continue;
          }
          entries.push([serverId, agent.id, agent.workspaceId ?? ""].join(KEY_SEPARATOR));
        }
      }
      return entries;
    }),
  );

  const remote = useRemoteAgentSearch(query, includeArchived);

  return useMemo(() => {
    const agentKeys = new Set<string>();
    const workspaceKeys = new Set<string>();
    const addMatch = (serverId: string, agentId: string, workspaceId: string | null) => {
      agentKeys.add(`${serverId}:${agentId}`);
      if (workspaceId) workspaceKeys.add(`${serverId}:${workspaceId}`);
    };
    for (const entry of localEntries) {
      const [serverId, agentId, workspaceId] = entry.split(KEY_SEPARATOR);
      addMatch(serverId!, agentId!, workspaceId || null);
    }

    const current = remote.query === query && remote.includeArchived === includeArchived;
    const archivedMatches: SidebarSearchArchivedMatch[] = [];
    let semantic = false;
    let latencyMs: number | null = null;
    if (current) {
      for (const [serverId, payload] of remote.byServer) {
        semantic ||= payload.semantic;
        latencyMs = Math.max(latencyMs ?? 0, payload.latencyMs);
        for (const match of payload.matches) {
          if (match.archivedAt) {
            archivedMatches.push({
              serverId,
              agentId: match.agentId,
              title: match.title,
              cwd: match.cwd,
              score: match.score,
            });
          } else {
            addMatch(serverId, match.agentId, match.workspaceId);
          }
        }
      }
    }
    archivedMatches.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));

    return {
      active: words.length > 0,
      words,
      agentKeys,
      workspaceKeys,
      archivedMatches,
      pending: words.length > 0 && (!current || remote.pendingServerIds.size > 0),
      semantic,
      latencyMs,
    };
  }, [includeArchived, localEntries, query, remote, words]);
}

function useRemoteAgentSearch(query: string, includeArchived: boolean): RemoteState {
  const debouncedQuery = useDebouncedValue(query, REMOTE_SEARCH_DEBOUNCE_MS);
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportByServerId = useHostFeatureMap(serverIds, "agentSearch");
  const searchServerIds = useMemo(
    () => serverIds.filter((serverId) => supportByServerId.get(serverId)),
    [serverIds, supportByServerId],
  );
  const [state, setState] = useState<RemoteState>(EMPTY_REMOTE);
  const isOpen = useSidebarSearchStore((store) => store.isOpen);

  // Opening the bar warms each host (vault key, launch prompts) before the first query lands.
  useEffect(() => {
    if (!isOpen) return;
    const runtime = getHostRuntimeStore();
    for (const serverId of searchServerIds) {
      const client = runtime.getClient(serverId);
      if (client?.isConnected) void client.searchAgents({ query: "" }).catch(() => null);
    }
  }, [isOpen, searchServerIds]);

  useEffect(() => {
    if (agentSearchWords(debouncedQuery).length === 0) {
      setState(EMPTY_REMOTE);
      return;
    }
    let cancelled = false;
    const runtime = getHostRuntimeStore();
    const clients = searchServerIds.flatMap((serverId) => {
      const client = runtime.getClient(serverId);
      return client?.isConnected ? [{ serverId, client }] : [];
    });
    setState({
      query: debouncedQuery,
      includeArchived,
      byServer: new Map(),
      pendingServerIds: new Set(clients.map(({ serverId }) => serverId)),
    });
    const searchHost = async (serverId: string, client: (typeof clients)[number]["client"]) => {
      const payload = await client
        .searchAgents({ query: debouncedQuery, includeArchived })
        .catch(() => null);
      if (cancelled) return;
      setState((previous) => {
        const pendingServerIds = new Set(previous.pendingServerIds);
        pendingServerIds.delete(serverId);
        const byServer = new Map(previous.byServer);
        if (payload) byServer.set(serverId, payload);
        return { ...previous, byServer, pendingServerIds };
      });
    };
    for (const { serverId, client } of clients) void searchHost(serverId, client);
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, includeArchived, searchServerIds]);

  return state;
}
