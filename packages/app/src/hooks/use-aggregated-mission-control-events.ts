import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import equal from "fast-deep-equal";
import { useFetchQueries } from "@/data/query";
import {
  fetchMissionControlEvents,
  missionControlEventsQueryKey,
} from "@/data/mission-control-events";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";

/** A mission control event tagged with the host it came from, so the feed can
 * render per-host chips and the board can scope lookups without extra state. */
export interface AggregatedMissionControlEvent extends MissionControlEvent {
  serverId: string;
  serverLabel: string;
}

export interface AggregatedMissionControlEventsResult {
  events: AggregatedMissionControlEvent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
  /** True while the thread is fetching an older page of events. */
  isLoadingOlder: boolean;
  /** True when at least one host still has cursor-paged history to load. */
  hasOlderEvents: boolean;
  /**
   * Cursor-page the feed backward (events strictly older than the oldest
   * loaded seq per host). Resolves true when any host returned new events.
   */
  loadOlderEvents: () => Promise<boolean>;
}

/** Initial page per host (spec: no more hardcoded 200-and-done — paging pages
 * backward from here). */
const DEFAULT_EVENT_FETCH_LIMIT = 200;
/** Backward page size when the thread scrolls up to load older events. */
const OLDER_EVENTS_PAGE_SIZE = 120;
/** Windowed memory: the merged feed keeps at most this many events; older rows
 * unload beyond the window (refetchable via the cursor). */
const EVENTS_MEMORY_WINDOW = 600;
const EVENTS_STALE_TIME_MS = 15_000;

interface HostQueryLike {
  data?: MissionControlEvent[];
}

/** Oldest seq per host across the live query pages + accumulated older pages. */
function oldestSeqPerHost(
  hosts: { serverId: string }[],
  hostQueries: readonly HostQueryLike[],
  olderEvents: readonly AggregatedMissionControlEvent[],
): Map<string, number> {
  const oldestSeqByHost = new Map<string, number>();
  const consider = (serverId: string, seq: number | null | undefined) => {
    if (typeof seq !== "number") {
      return;
    }
    const current = oldestSeqByHost.get(serverId);
    if (current === undefined || seq < current) {
      oldestSeqByHost.set(serverId, seq);
    }
  };
  for (let index = 0; index < hosts.length; index += 1) {
    for (const event of hostQueries[index]?.data ?? []) {
      consider(hosts[index].serverId, event.seq);
    }
  }
  for (const event of olderEvents) {
    consider(event.serverId, event.seq);
  }
  return oldestSeqByHost;
}

/** Append a fetched older page, deduping against what's already merged, and
 * bound the accumulated history to the same memory window as the merged view. */
function mergeOlderEvents(
  current: readonly AggregatedMissionControlEvent[],
  fetched: readonly AggregatedMissionControlEvent[],
): AggregatedMissionControlEvent[] {
  const seenIds = new Set(current.map((event) => `${event.serverId}:${event.id}`));
  const additions = fetched.filter((event) => !seenIds.has(`${event.serverId}:${event.id}`));
  const merged = [...current, ...additions];
  if (merged.length > EVENTS_MEMORY_WINDOW) {
    merged.length = EVENTS_MEMORY_WINDOW;
  }
  return merged;
}

/**
 * Merge mission control events across all connected hosts into one feed.
 * Connectivity is checked at query time per host (mirrors use-schedules):
 * offline hosts keep their last-known events but stop refetching; the push
 * router invalidates the per-host query when `mission_control_event` arrives.
 *
 * v3 paging: the query holds the latest page per host; `loadOlderEvents`
 * cursor-pages backward through `mission_control.events.fetch beforeSeq` and
 * accumulates the older pages in local state. The merged feed windows memory
 * to `EVENTS_MEMORY_WINDOW` rows (oldest unloads, re-fetchable on demand).
 */
export function useAggregatedMissionControlEvents(options?: {
  enabled?: boolean;
}): AggregatedMissionControlEventsResult {
  const enabled = options?.enabled ?? true;
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);

  const hostQueries = useFetchQueries(
    hosts.map((host) => ({
      queryKey: missionControlEventsQueryKey(host.serverId),
      queryFn: async (): Promise<MissionControlEvent[]> => {
        const client = runtime.getClient(host.serverId);
        if (!client) {
          return [];
        }
        return fetchMissionControlEvents({ client, limit: DEFAULT_EVENT_FETCH_LIMIT });
      },
      enabled: enabled && connectionStatuses.get(host.serverId) === "online",
      staleTimeMs: EVENTS_STALE_TIME_MS,
      dataShape: "list",
    })),
  );

  // Older pages accumulated by cursor paging, tagged with their host. Strictly
  // older than anything the live query returns, so push-invalidation never
  // replaces them; the merge below dedupes by id anyway.
  const [olderEvents, setOlderEvents] = useState<AggregatedMissionControlEvent[]>([]);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // Per-host "is there more history" flag; starts optimistic (true) so the
  // first scroll-up attempt probes, and flips false when a page comes back
  // empty or the host's events carry no seq cursor.
  const [hasMoreByHost, setHasMoreByHost] = useState<Record<string, boolean>>({});

  const hasOlderEvents = useMemo(
    () => enabled && hosts.some((host) => hasMoreByHost[host.serverId] !== false),
    [enabled, hasMoreByHost, hosts],
  );

  // Keyed by "serverId:eventId" — reuse the previous AggregatedMissionControlEvent
  // object when none of its fields changed, so downstream memo/shallow comparisons
  // can bail early (same pattern as use-aggregated-agents).
  const prevEventsRef = useRef<Map<string, AggregatedMissionControlEvent>>(new Map());
  // Preserved sorted array — returned as-is when every element kept its identity
  // and order, so callers using reference equality skip re-renders entirely.
  const prevSortedRef = useRef<AggregatedMissionControlEvent[]>([]);

  // Connection-generation scoping (rule: client caches die on reconnect): when
  // a host cycles offline -> online, its accumulated pages came from the old
  // connection — the daemon may have truncated or superseded events while
  // disconnected, and `olderEvents` would resurrect them into the merged feed.
  // On the transition, drop that host's paged state (older pages + has-more
  // flags) and clear the identity caches so nothing from the previous
  // connection leaks into the new one. The live query page refetches itself:
  // the runtime invalidates the per-host events query on reconnect.
  const prevConnectionStatusesRef = useRef<Map<string, HostRuntimeConnectionStatus>>(new Map());
  useEffect(() => {
    const previous = prevConnectionStatusesRef.current;
    const next = new Map<string, HostRuntimeConnectionStatus>();
    const reconnectedHostIds: string[] = [];
    for (const host of hosts) {
      const status = connectionStatuses.get(host.serverId) ?? "connecting";
      next.set(host.serverId, status);
      const previousStatus = previous.get(host.serverId);
      if (previousStatus !== undefined && previousStatus !== "online" && status === "online") {
        reconnectedHostIds.push(host.serverId);
      }
    }
    prevConnectionStatusesRef.current = next;
    if (reconnectedHostIds.length === 0) {
      return;
    }
    const reconnected = new Set(reconnectedHostIds);
    setOlderEvents((current) =>
      current.some((event) => reconnected.has(event.serverId))
        ? current.filter((event) => !reconnected.has(event.serverId))
        : current,
    );
    setHasMoreByHost((current) => {
      if (!reconnectedHostIds.some((serverId) => current[serverId] !== undefined)) {
        return current;
      }
      const nextHasMore = { ...current };
      for (const serverId of reconnectedHostIds) {
        delete nextHasMore[serverId];
      }
      return nextHasMore;
    });
    prevEventsRef.current = new Map();
    prevSortedRef.current = [];
  }, [connectionStatuses, hosts]);

  const result = useMemo(() => {
    const allEvents: AggregatedMissionControlEvent[] = [...olderEvents];
    const serverLabelById = new Map(hosts.map((host) => [host.serverId, host.label] as const));
    const seen = new Set<string>();
    for (const event of olderEvents) {
      seen.add(`${event.serverId}:${event.id}`);
    }

    for (let index = 0; index < hosts.length; index += 1) {
      const host = hosts[index];
      const events = hostQueries[index]?.data;
      if (!events) {
        continue;
      }
      const serverLabel = serverLabelById.get(host.serverId) ?? host.serverId;
      for (const event of events) {
        const cacheKey = `${host.serverId}:${event.id}`;
        if (seen.has(cacheKey)) {
          continue;
        }
        seen.add(cacheKey);
        const nextEvent: AggregatedMissionControlEvent = {
          ...event,
          serverId: host.serverId,
          serverLabel,
        };
        const prev = prevEventsRef.current.get(cacheKey);
        allEvents.push(prev !== undefined && equal(prev, nextEvent) ? prev : nextEvent);
      }
    }

    allEvents.sort((left, right) => right.ts.localeCompare(left.ts));

    // Windowed memory: drop the oldest rows beyond the window (they remain
    // reachable through the beforeSeq cursor).
    if (allEvents.length > EVENTS_MEMORY_WINDOW) {
      allEvents.length = EVENTS_MEMORY_WINDOW;
    }

    const nextCache = new Map<string, AggregatedMissionControlEvent>();
    for (const event of allEvents) {
      nextCache.set(`${event.serverId}:${event.id}`, event);
    }
    prevEventsRef.current = nextCache;

    // If every element kept its reference identity and the order is the same,
    // return the previous array so downstream reference comparisons can bail.
    const prevSorted = prevSortedRef.current;
    const stableEvents =
      allEvents.length === prevSorted.length &&
      allEvents.every((event, index) => event === prevSorted[index])
        ? prevSorted
        : allEvents;
    prevSortedRef.current = stableEvents;

    const hasAnyData = stableEvents.length > 0;
    const isLoading = hostQueries.some((query) => query.isLoading);
    return {
      events: stableEvents,
      isLoading,
      isInitialLoad: isLoading && !hasAnyData,
      isRevalidating: isLoading && hasAnyData,
    };
  }, [hostQueries, hosts, olderEvents]);

  const refreshAll = useCallback(() => {
    for (const query of hostQueries) {
      void query.refetch();
    }
  }, [hostQueries]);

  const loadOlderEvents = useCallback(async (): Promise<boolean> => {
    if (!enabled || isLoadingOlder) {
      return false;
    }
    // Oldest cursor per host from everything currently loaded (live query +
    // accumulated older pages). A host with no seq-carrying events cannot be
    // paged (legacy persisted events sort as seq -1); it reports no more.
    const oldestSeqByHost = oldestSeqPerHost(hosts, hostQueries, olderEvents);
    const pageableHosts = hosts.filter(
      (host) =>
        hasMoreByHost[host.serverId] !== false &&
        typeof oldestSeqByHost.get(host.serverId) === "number",
    );
    if (pageableHosts.length === 0) {
      // Nothing cursor-pages (hosts with loaded events predate seq, or all are
      // already exhausted): report no more history instead of probing forever.
      const nextHasMore: Record<string, boolean> = {};
      for (const host of hosts) {
        if (oldestSeqByHost.has(host.serverId)) {
          nextHasMore[host.serverId] = hasMoreByHost[host.serverId] !== false;
        } else {
          nextHasMore[host.serverId] = false;
        }
      }
      setHasMoreByHost((current) =>
        Object.keys(nextHasMore).some((serverId) => nextHasMore[serverId] !== current[serverId])
          ? nextHasMore
          : current,
      );
      return false;
    }

    setIsLoadingOlder(true);
    try {
      const fetched: AggregatedMissionControlEvent[] = [];
      const nextHasMore = { ...hasMoreByHost };
      const serverLabelById = new Map(hosts.map((host) => [host.serverId, host.label] as const));

      for (const host of pageableHosts) {
        const client = runtime.getClient(host.serverId);
        const beforeSeq = oldestSeqByHost.get(host.serverId);
        if (!client || typeof beforeSeq !== "number") {
          continue;
        }
        const events = await fetchMissionControlEvents({
          client,
          beforeSeq,
          limit: OLDER_EVENTS_PAGE_SIZE,
        });
        const serverLabel = serverLabelById.get(host.serverId) ?? host.serverId;
        for (const event of events) {
          fetched.push({ ...event, serverId: host.serverId, serverLabel });
        }
        if (events.length === 0) {
          nextHasMore[host.serverId] = false;
        }
      }

      if (fetched.length > 0) {
        setOlderEvents((current) => mergeOlderEvents(current, fetched));
      }
      setHasMoreByHost(nextHasMore);
      return fetched.length > 0;
    } finally {
      setIsLoadingOlder(false);
    }
  }, [enabled, hasMoreByHost, hostQueries, hosts, isLoadingOlder, olderEvents, runtime]);

  return {
    ...result,
    refreshAll,
    isLoadingOlder,
    hasOlderEvents,
    loadOlderEvents,
  };
}
