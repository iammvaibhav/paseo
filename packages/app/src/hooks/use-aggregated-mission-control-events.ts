import { useCallback, useMemo, useRef } from "react";
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
}

const DEFAULT_EVENT_FETCH_LIMIT = 200;
const EVENTS_STALE_TIME_MS = 15_000;

/**
 * Merge mission control events across all connected hosts into one feed.
 * Connectivity is checked at query time per host (mirrors use-schedules):
 * offline hosts keep their last-known events but stop refetching; the push
 * router invalidates the per-host query when `mission_control_event` arrives.
 */
export function useAggregatedMissionControlEvents(): AggregatedMissionControlEventsResult {
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
      enabled: connectionStatuses.get(host.serverId) === "online",
      staleTimeMs: EVENTS_STALE_TIME_MS,
      dataShape: "list",
    })),
  );

  // Keyed by "serverId:eventId" — reuse the previous AggregatedMissionControlEvent
  // object when none of its fields changed, so downstream memo/shallow comparisons
  // can bail early (same pattern as use-aggregated-agents).
  const prevEventsRef = useRef<Map<string, AggregatedMissionControlEvent>>(new Map());
  // Preserved sorted array — returned as-is when every element kept its identity
  // and order, so callers using reference equality skip re-renders entirely.
  const prevSortedRef = useRef<AggregatedMissionControlEvent[]>([]);

  const result = useMemo(() => {
    const allEvents: AggregatedMissionControlEvent[] = [];
    const serverLabelById = new Map(hosts.map((host) => [host.serverId, host.label] as const));
    const seen = new Set<string>();

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
  }, [hostQueries, hosts]);

  const refreshAll = useCallback(() => {
    for (const query of hostQueries) {
      void query.refetch();
    }
  }, [hostQueries]);

  return {
    ...result,
    refreshAll,
  };
}
