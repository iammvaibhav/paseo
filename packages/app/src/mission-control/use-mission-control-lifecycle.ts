import { useMemo, useRef } from "react";
import equal from "fast-deep-equal";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useAggregatedMissionControlEvents } from "@/hooks/use-aggregated-mission-control-events";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import { isCommanderAgent } from "./labels";
import {
  DEFAULT_RETENTION_DAYS,
  countLifecycle,
  deriveAgentLifecycle,
  groupLifecycleRows,
  toLifecycleRow,
  type LifecycleBucketGroup,
  type LifecycleCounts,
  type LifecycleRow,
} from "./lifecycle";

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_EVENTS: readonly MissionControlEvent[] = [];

export interface MissionControlLifecycleOptions {
  /** "All unarchived" toggle: reveal dormant + out-of-window rows. */
  showAll?: boolean;
  /** Central-config retention window; defaults to the spec's 30 days. */
  retentionDays?: number;
  /** Gate the underlying per-host event queries (off for hidden surfaces). */
  enabled?: boolean;
}

export interface MissionControlLifecycleResult {
  /** Every non-commander agent with its derived lifecycle state. */
  rows: LifecycleRow[];
  /** Non-empty bucket sections in board order, already sorted + filtered. */
  groups: LifecycleBucketGroup[];
  counts: LifecycleCounts;
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
}

/**
 * The board's data model: every agent on every host with its derived
 * lifecycle position (Needs you → Running → Ready for review → Done, plus
 * Dormant), sourced from the agent directory + the mission-control event
 * feed. Row objects are identity-preserved across renders so memoized rows
 * skip re-rendering when nothing about them changed.
 */
export function useMissionControlLifecycle(
  options?: MissionControlLifecycleOptions,
): MissionControlLifecycleResult {
  const showAll = options?.showAll ?? false;
  const retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const enabled = options?.enabled ?? true;
  const agentsResult = useAggregatedAgents();
  const { agents } = agentsResult;
  const eventsResult = useAggregatedMissionControlEvents({ enabled });

  // Keyed by "serverId:agentId" — reuse the previous LifecycleRow when neither
  // the agent nor its derived state changed, so downstream memo/shallow
  // comparisons (React.memo rows) can bail early.
  const prevRowsRef = useRef<Map<string, LifecycleRow>>(new Map());

  const rows = useMemo<LifecycleRow[]>(() => {
    const eventsByAgent = new Map<string, MissionControlEvent[]>();
    for (const event of eventsResult.events) {
      const key = `${event.serverId}:${event.agentId}`;
      const bucket = eventsByAgent.get(key);
      if (bucket) {
        bucket.push(event);
      } else {
        eventsByAgent.set(key, [event]);
      }
    }

    const nextRows: LifecycleRow[] = [];
    for (const agent of agents) {
      // The Commander (label `paseo.mission-control=*`) is invisible on the
      // board — it lives in the Mission Control thread, never in a bucket.
      if (isCommanderAgent(agent.labels)) {
        continue;
      }
      const state = deriveAgentLifecycle({
        agent,
        events: eventsByAgent.get(`${agent.serverId}:${agent.id}`) ?? EMPTY_EVENTS,
        now: Date.now(),
        retentionMs: retentionDays * DAY_MS,
      });
      const next = toLifecycleRow(agent, state);
      const cacheKey = `${agent.serverId}:${agent.id}`;
      const prev = prevRowsRef.current.get(cacheKey);
      nextRows.push(prev !== undefined && equal(prev, next) ? prev : next);
    }

    const nextCache = new Map<string, LifecycleRow>();
    for (const row of nextRows) {
      nextCache.set(`${row.agent.serverId}:${row.agent.id}`, row);
    }
    prevRowsRef.current = nextCache;
    return nextRows;
  }, [agents, eventsResult.events, retentionDays]);

  const groups = useMemo(() => groupLifecycleRows(rows, showAll), [rows, showAll]);

  const counts = useMemo(() => countLifecycle(rows), [rows]);

  const isLoading = agentsResult.isLoading || eventsResult.isLoading;
  const hasAnyData = rows.length > 0;
  const isInitialLoad = isLoading && !hasAnyData;
  const isRevalidating = isLoading && hasAnyData;

  return {
    rows,
    groups,
    counts,
    isLoading,
    isInitialLoad,
    isRevalidating,
  };
}
