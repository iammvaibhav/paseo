import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  getHostRuntimeStore,
  isHostRuntimeDirectoryLoading,
  useHosts,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import {
  useSessionStore,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  isSystemOwnedWorkspace,
  type WorkspaceAgentForSidebar,
} from "@/projects/workspace-structure";
import { useMissionControlVerbose } from "@/mission-control/use-mission-control-verbose";
import { buildProjects, type ProjectHost, type ProjectSummary } from "@/utils/projects";

export interface ProjectHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface ProjectHostReplica {
  serverId: string;
  serverName: string;
  workspaces: WorkspaceDescriptor[];
  projects: ProjectDescriptor[];
}

export interface ProjectHostRuntimeState {
  serverId: string;
  isOnline: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
}

export interface DerivedProjectsResult {
  projects: ProjectSummary[];
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
}

export interface UseProjectsResult {
  projects: ProjectSummary[];
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export interface UseProjectsOptions {
  enabled?: boolean;
}

const EMPTY_PROJECT_HOST_REPLICAS: ProjectHostReplica[] = [];
const EMPTY_PROJECT_HOST_RUNTIME_STATES: ProjectHostRuntimeState[] = [];

function toProjectHostRuntimeState(
  serverId: string,
  snapshot: HostRuntimeSnapshot | null,
): ProjectHostRuntimeState {
  const isFetching =
    snapshot?.agentDirectoryStatus === "initial_loading" ||
    snapshot?.agentDirectoryStatus === "revalidating";
  return {
    serverId,
    isOnline: snapshot?.connectionStatus === "online",
    isLoading: isHostRuntimeDirectoryLoading(snapshot),
    isFetching,
    error: snapshot?.agentDirectoryError ?? null,
  };
}

function selectProjectHostReplicas(
  hosts: readonly { serverId: string; label: string }[],
  enabled: boolean,
  hideSystemOwnedWorkspaces: boolean,
): (state: ReturnType<typeof useSessionStore.getState>) => ProjectHostReplica[] {
  if (!enabled) {
    return () => EMPTY_PROJECT_HOST_REPLICAS;
  }
  return (state) =>
    hosts.map((host) => {
      const session = state.sessions[host.serverId];
      const allWorkspaces = session?.workspaces ?? undefined;
      let workspaces: WorkspaceDescriptor[];
      if (!allWorkspaces) {
        workspaces = [];
      } else if (!hideSystemOwnedWorkspaces) {
        workspaces = Array.from(allWorkspaces.values());
      } else {
        // Mission Control verbose gate: system-owned workspaces (Commander's
        // reserved home dir + machinery-only workspaces) are hidden from
        // project lists and search-like pickers while verbose is OFF.
        const agentsByWorkspaceId = new Map<string, WorkspaceAgentForSidebar[]>();
        for (const agent of session?.agents?.values() ?? []) {
          if (!agent.workspaceId) {
            continue;
          }
          const existing = agentsByWorkspaceId.get(agent.workspaceId);
          if (existing) {
            existing.push(agent);
          } else {
            agentsByWorkspaceId.set(agent.workspaceId, [agent]);
          }
        }
        workspaces = Array.from(allWorkspaces.values()).filter(
          (workspace) =>
            !isSystemOwnedWorkspace({
              agentsInWorkspace: agentsByWorkspaceId.get(workspace.id) ?? [],
              workspaceDirectory: workspace.workspaceDirectory,
            }),
        );
      }
      return {
        serverId: host.serverId,
        serverName: host.label,
        workspaces,
        projects: Array.from(session?.projects.values() ?? []),
      };
    });
}

export function deriveProjectsFromReplica(input: {
  replicas: readonly ProjectHostReplica[];
  runtimeStates: readonly ProjectHostRuntimeState[];
  hideSystemOwnedWorkspaces?: boolean;
}): DerivedProjectsResult {
  const runtimeByServerId = new Map(
    input.runtimeStates.map((state) => [state.serverId, state] as const),
  );
  const hosts: ProjectHost[] = input.replicas.map((replica) => {
    const runtimeState = runtimeByServerId.get(replica.serverId);
    return {
      serverId: replica.serverId,
      serverName: replica.serverName,
      isOnline: runtimeState?.isOnline ?? false,
      workspaces: replica.workspaces,
      projects: replica.projects,
    };
  });
  const hostErrors = input.replicas.flatMap((replica) => {
    const message = runtimeByServerId.get(replica.serverId)?.error;
    return message
      ? [
          {
            serverId: replica.serverId,
            serverName: replica.serverName,
            message,
          },
        ]
      : [];
  });

  return {
    ...buildProjects({
      hosts,
      // Same Mission Control verbose gate the replica selector applied — the
      // grouped-project derivation must not re-hide system-owned workspaces
      // when verbose is ON (its own default is "hidden").
      hideSystemOwnedWorkspaces: input.hideSystemOwnedWorkspaces,
    }),
    hostErrors,
    isLoading: input.runtimeStates.some((state) => state.isLoading),
    isFetching: input.runtimeStates.some((state) => state.isFetching),
  };
}

function useProjectHostRuntimeStates(
  serverIds: readonly string[],
  enabled: boolean,
): ProjectHostRuntimeState[] {
  const runtime = getHostRuntimeStore();
  const previousStatesRef = useRef<ProjectHostRuntimeState[]>([]);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      enabled ? runtime.subscribeAll(onStoreChange) : () => undefined,
    [enabled, runtime],
  );
  const getSnapshot = useCallback(() => (enabled ? runtime.getVersion() : 0), [enabled, runtime]);
  const runtimeSnapshotTick = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (!enabled) {
      previousStatesRef.current = EMPTY_PROJECT_HOST_RUNTIME_STATES;
      return EMPTY_PROJECT_HOST_RUNTIME_STATES;
    }
    void runtimeSnapshotTick;
    const nextStates = serverIds.map((serverId) =>
      toProjectHostRuntimeState(serverId, runtime.getSnapshot(serverId)),
    );
    if (equal(previousStatesRef.current, nextStates)) {
      return previousStatesRef.current;
    }
    previousStatesRef.current = nextStates;
    return nextStates;
  }, [enabled, runtime, runtimeSnapshotTick, serverIds]);
}

export function useProjects(options: UseProjectsOptions = {}): UseProjectsResult {
  const enabled = options.enabled ?? true;
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const [verbose] = useMissionControlVerbose();
  const hideSystemOwnedWorkspaces = !verbose;
  const serverIds = useMemo(
    () => (enabled ? hosts.map((host) => host.serverId) : []),
    [enabled, hosts],
  );
  const replicaSelector = useMemo(
    () => selectProjectHostReplicas(hosts, enabled, hideSystemOwnedWorkspaces),
    [enabled, hideSystemOwnedWorkspaces, hosts],
  );
  const replicas = useStoreWithEqualityFn(useSessionStore, replicaSelector, equal);
  const runtimeStates = useProjectHostRuntimeStates(serverIds, enabled);
  const derived = useMemo(
    () =>
      deriveProjectsFromReplica({
        replicas,
        runtimeStates,
        hideSystemOwnedWorkspaces,
      }),
    [hideSystemOwnedWorkspaces, replicas, runtimeStates],
  );
  const refetch = useCallback(() => {
    if (!enabled) return;
    runtime.refreshAllAgentDirectories({ serverIds });
  }, [enabled, runtime, serverIds]);

  return {
    ...derived,
    refetch,
  };
}
