import { useMemo, useCallback, useRef, useSyncExternalStore } from "react";
import equal from "fast-deep-equal";
import { useShallow } from "zustand/shallow";
import { isCommanderOrMachineryLabels } from "@getpaseo/protocol/mission-control/system-owned";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { Agent } from "@/stores/session-store";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import { deriveSidebarLifecycleBucket } from "@/utils/sidebar-agent-state";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";

export interface AggregatedAgent extends AgentDirectoryEntry {
  serverId: string;
  serverLabel: string;
  /** Canonical lifecycle bucket; payload field or old-daemon fallback. */
  bucket: LifecycleBucket;
}

export interface AggregatedAgentsResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

function toAggregatedAgent(agent: Agent, serverId: string, serverLabel: string): AggregatedAgent {
  return {
    id: agent.id,
    serverId,
    serverLabel,
    title: agent.title ?? null,
    name: agent.name ?? null,
    shortDescription: agent.shortDescription ?? null,
    status: agent.status,
    lastActivityAt: agent.lastActivityAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    provider: agent.provider,
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    attentionTimestamp: agent.attentionTimestamp,
    stoppedBy: agent.stoppedBy ?? null,
    bucket: deriveSidebarLifecycleBucket({
      bucket: agent.bucket,
      status: agent.status,
      pendingPermissionCount: agent.pendingPermissions.length,
      attentionReason: agent.attentionReason,
      stoppedBy: agent.stoppedBy,
    }),
    archivedAt: agent.archivedAt,
    createdAt: agent.createdAt,
    labels: agent.labels,
    projectPlacement: agent.projectPlacement,
  };
}

export function useAggregatedAgents(options?: {
  includeArchived?: boolean;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const includeArchived = options?.includeArchived ?? false;
  // Mission Control verbose is THE debug gate: the Commander itself and
  // non-verifier machinery (monitors, build-hash stamps) are hidden from
  // every list/board/badge surface while it is OFF, and visible everywhere
  // when it is ON. Verifiers, Commander workers, and subagents are tracked —
  // their lifecycle shows on the board like any root agent. One filter here
  // so no surface keeps its own variant.
  const [verbose] = useMissionControlVerbose();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );

  const sessionAgents = useSessionStore(
    useShallow((state) => {
      const result: Record<string, Map<string, Agent> | undefined> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.agents;
      }
      return result;
    }),
  );

  const refreshAll = useCallback(() => {
    runtime.refreshAllAgentDirectories();
  }, [runtime]);

  // Keyed by "serverId:agentId" — reuse the previous AggregatedAgent object when
  // none of its fields changed, so downstream memo/shallow comparisons can bail early.
  const prevAgentsRef = useRef<Map<string, AggregatedAgent>>(new Map());
  // Preserved sorted array — returned as-is when every element kept its identity
  // and order, so callers using reference equality skip re-renders entirely.
  const prevSortedRef = useRef<AggregatedAgent[]>([]);

  const result = useMemo(() => {
    // runtimeVersion is referenced so the memo recomputes when runtime state changes.
    void runtimeVersion;
    const allAgents: AggregatedAgent[] = [];
    const serverLabelById = new Map(
      daemons.map((daemon) => [daemon.serverId, daemon.label] as const),
    );

    // Derive agent directory from all sessions
    for (const [serverId, agents] of Object.entries(sessionAgents)) {
      if (!agents || agents.size === 0) {
        continue;
      }
      const serverLabel = serverLabelById.get(serverId) ?? serverId;
      for (const agent of agents.values()) {
        if (!includeArchived && agent.archivedAt) {
          continue;
        }
        if (!verbose && isCommanderOrMachineryLabels(agent.labels)) {
          continue;
        }
        const nextAgent = toAggregatedAgent(agent, serverId, serverLabel);
        const cacheKey = `${serverId}:${agent.id}`;
        const prev = prevAgentsRef.current.get(cacheKey);
        // Preserve object identity when fields are unchanged so callers can use
        // reference equality (useShallow, memo) to skip re-renders.
        allAgents.push(prev !== undefined && equal(prev, nextAgent) ? prev : nextAgent);
      }
    }

    // Sort by: running agents first, then by most recent activity. Running
    // agents sort by name ascending — a running agent's lastActivityAt ticks
    // on every timeline row, so sorting it by activity would reorder the board
    // mid-stream. Name (then id) is a total order: stable while the set of
    // running agents changes. Non-running agents keep recency order, with the
    // same deterministic tiebreaks so the whole sort is a strict total order.
    allAgents.sort((left, right) => {
      const leftRunning = left.status === "running";
      const rightRunning = right.status === "running";
      if (leftRunning !== rightRunning) {
        return leftRunning ? -1 : 1;
      }
      if (leftRunning) {
        const leftKey = left.name ?? left.title ?? left.id;
        const rightKey = right.name ?? right.title ?? right.id;
        const nameCmp = leftKey.localeCompare(rightKey);
        if (nameCmp !== 0) {
          return nameCmp;
        }
        return `${left.serverId}:${left.id}`.localeCompare(`${right.serverId}:${right.id}`);
      }
      const leftTime = left.lastActivityAt.getTime();
      const rightTime = right.lastActivityAt.getTime();
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      const leftKey = left.name ?? left.title ?? left.id;
      const rightKey = right.name ?? right.title ?? right.id;
      const nameCmp = leftKey.localeCompare(rightKey);
      if (nameCmp !== 0) {
        return nameCmp;
      }
      return `${left.serverId}:${left.id}`.localeCompare(`${right.serverId}:${right.id}`);
    });

    // Update the identity cache for the next render pass.
    const nextCache = new Map<string, AggregatedAgent>();
    for (const agent of allAgents) {
      nextCache.set(`${agent.serverId}:${agent.id}`, agent);
    }
    prevAgentsRef.current = nextCache;

    // If every element kept its reference identity and the order is the same,
    // return the previous array so downstream reference comparisons can bail.
    const prevSorted = prevSortedRef.current;
    const stableAgents =
      allAgents.length === prevSorted.length &&
      allAgents.every((agent, i) => agent === prevSorted[i])
        ? prevSorted
        : allAgents;
    prevSortedRef.current = stableAgents;

    // Check if we have any cached data
    const hasAnyData = stableAgents.length > 0;

    // Align list loading with the runtime directory-sync machine.
    const isLoading = daemons.some((daemon) => {
      const status =
        runtime.getSnapshot(daemon.serverId)?.agentDirectoryStatus ?? "initial_loading";
      return status === "initial_loading" || status === "revalidating";
    });
    const isInitialLoad = isLoading && !hasAnyData;
    const isRevalidating = isLoading && hasAnyData;

    return {
      agents: stableAgents,
      isLoading,
      isInitialLoad,
      isRevalidating,
    };
  }, [daemons, includeArchived, runtime, runtimeVersion, sessionAgents, verbose]);

  return {
    ...result,
    refreshAll,
  };
}
