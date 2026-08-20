import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { queryClient as sharedQueryClient } from "@/data/query-client";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
  type HostRuntimeStore,
} from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";
import { computeSortOrder, WORK_COLUMN_IDS } from "@getpaseo/protocol/work/state";
import type { WorkColumnId } from "@getpaseo/protocol/work/state";
import type {
  WorkComment,
  WorkDraft,
  WorkItem,
  WorkItemDetail,
  WorkLabel,
  WorkPage,
  WorkProject,
  WorkSticky,
  WorkView,
} from "@getpaseo/protocol/work/types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  useSelectedWorkProjectKey,
  setSelectedWorkProjectKey,
} from "@/screens/work/selection-store";

export const workProjectsQueryBaseKey = ["workProjects"] as const;
export const workItemsQueryBaseKey = ["workItems"] as const;
export const workItemDetailQueryBaseKey = ["workItemDetail"] as const;
export const workPagesQueryBaseKey = ["workPages"] as const;
export const workDraftsQueryBaseKey = ["workDrafts"] as const;
export const workStickiesQueryBaseKey = ["workStickies"] as const;
export const workViewsQueryBaseKey = ["workViews"] as const;

function toErrorString(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

export class WorkHostResolutionError extends Error {
  code = "work_host_unresolvable" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkHostResolutionError";
  }
}

function buildByColumn(items: WorkItem[]): Record<WorkColumnId, WorkItem[]> {
  const byColumn = {} as Record<WorkColumnId, WorkItem[]>;
  for (const id of WORK_COLUMN_IDS) {
    byColumn[id] = [];
  }
  for (const item of items) {
    const col = item.column;
    if (col === "cancelled") continue;
    if ((WORK_COLUMN_IDS as readonly string[]).includes(col)) {
      byColumn[col as WorkColumnId].push(item);
    }
  }
  for (const id of WORK_COLUMN_IDS) {
    byColumn[id].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return byColumn;
}

// Module-level maps: projectKey -> serverId (owning host). Populated by the
// useWorkProjects fan-out; item/draft/page/sticky/view id maps are populated by
// the per-project list queries so mutations resolve the owning host.
const projectHostByKey = new Map<string, string>();
const draftProjectById = new Map<string, string>();
const pageProjectById = new Map<string, string>();
const stickyProjectById = new Map<string, string>();
const viewProjectById = new Map<string, string>();

function normalizeHostKey(value: string): string {
  return value.trim().toLowerCase();
}

interface HostLabelIndexes {
  labelByServerId: Map<string, string>;
  serverIdByLowerLabel: Map<string, string>;
  serverIdByLowerId: Map<string, string>;
  hostnameByLower: Map<string, string>;
}

// Builds a normalized (case-insensitive) alias index over host profiles and
// session server_info so "MacBook" (client profile label), "macbook" (daemon
// peer name), and the daemon hostname all collapse onto one serverId.
function buildHostLabelIndexes(hosts: readonly HostProfile[]): HostLabelIndexes {
  const labelByServerId = new Map<string, string>();
  const serverIdByLowerLabel = new Map<string, string>();
  const serverIdByLowerId = new Map<string, string>();
  const hostnameByLower = new Map<string, string>();
  for (const host of hosts) {
    labelByServerId.set(host.serverId, host.label);
    serverIdByLowerLabel.set(normalizeHostKey(host.label), host.serverId);
    serverIdByLowerId.set(normalizeHostKey(host.serverId), host.serverId);
  }
  const sessions = useSessionStore.getState().sessions;
  for (const serverId of Object.keys(sessions)) {
    const info = sessions[serverId]?.serverInfo;
    const hostname = info?.hostname?.trim();
    if (hostname) hostnameByLower.set(normalizeHostKey(hostname), serverId);
    const advertisedServerId = info?.serverId?.trim();
    if (advertisedServerId) serverIdByLowerId.set(normalizeHostKey(advertisedServerId), serverId);
  }
  return { labelByServerId, serverIdByLowerLabel, serverIdByLowerId, hostnameByLower };
}

function resolveServerIdForHostName(name: string, indexes: HostLabelIndexes): string | null {
  const lower = normalizeHostKey(name);
  return (
    indexes.serverIdByLowerLabel.get(lower) ??
    indexes.serverIdByLowerId.get(lower) ??
    indexes.hostnameByLower.get(lower) ??
    null
  );
}

// De-duplicates host labels on the stable server identity (not the display
// string) and prefers the client profile label over daemon peer names.
function dedupeHostLabels(raw: string[], hosts: readonly HostProfile[]): string[] {
  const indexes = buildHostLabelIndexes(hosts);
  const seenServerIds = new Set<string>();
  const seenNormalized = new Set<string>();
  const result: string[] = [];
  for (const name of raw) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const lower = normalizeHostKey(trimmed);
    const serverId = resolveServerIdForHostName(trimmed, indexes);
    if (serverId) {
      if (seenServerIds.has(serverId)) continue;
      seenServerIds.add(serverId);
      result.push(indexes.labelByServerId.get(serverId) ?? trimmed);
    } else {
      if (seenNormalized.has(lower)) continue;
      result.push(trimmed);
    }
    seenNormalized.add(lower);
  }
  return result;
}

function resolveOwnerServerId(
  entryHost: string,
  indexes: HostLabelIndexes,
  fallbackServerId: string,
): string {
  return resolveServerIdForHostName(entryHost, indexes) ?? fallbackServerId;
}

function getClientForServerId(serverId: string): DaemonClient {
  const runtime = getHostRuntimeStore();
  const snap = runtime.getSnapshot(serverId);
  if (!snap || snap.connectionStatus !== "online") {
    throw new WorkHostResolutionError(`Host ${serverId} is not connected`);
  }
  const client = runtime.getClient(serverId);
  if (!client) {
    throw new WorkHostResolutionError(`No client for host ${serverId}`);
  }
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.serverInfo?.features?.workBoard !== true) {
    throw new WorkHostResolutionError(`Host ${serverId} needs update to use Work`);
  }
  return client;
}

function getClientForProjectKey(projectKey: string): DaemonClient {
  const serverId = projectHostByKey.get(projectKey);
  if (!serverId) {
    throw new WorkHostResolutionError(
      `Cannot resolve host for project ${projectKey}: project not found`,
    );
  }
  return getClientForServerId(serverId);
}

function findProjectKeyForItemId(itemId: string): string | null {
  const queries = sharedQueryClient.getQueriesData<{
    items?: WorkItem[];
    unreachableHosts?: string[];
  }>({ queryKey: workItemsQueryBaseKey });
  for (const [, data] of queries) {
    if (!data || typeof data !== "object") continue;
    const items = (data as unknown as { items?: WorkItem[] }).items;
    if (!Array.isArray(items)) continue;
    const found = items.find((it) => it.id === itemId);
    if (found) return found.projectKey;
  }
  const detailQueries = sharedQueryClient.getQueriesData<WorkItemDetail | null>({
    queryKey: workItemDetailQueryBaseKey,
  });
  for (const [, data] of detailQueries) {
    if (!data || typeof data !== "object") continue;
    const item = (data as unknown as WorkItemDetail | null)?.item;
    if (item?.id === itemId) return item.projectKey;
  }
  return null;
}

function scanListForProjectKey<T extends { id: string; projectKey: string }>(
  baseKey: readonly unknown[],
  id: string,
): string | null {
  const queries = sharedQueryClient.getQueriesData<T[]>({ queryKey: baseKey });
  for (const [, data] of queries) {
    if (!Array.isArray(data)) continue;
    const found = data.find((entry) => entry.id === id);
    if (found) return found.projectKey;
  }
  return null;
}

function findProjectKeyForEntityId(id: string): string | null {
  const fromMaps =
    draftProjectById.get(id) ??
    pageProjectById.get(id) ??
    stickyProjectById.get(id) ??
    viewProjectById.get(id);
  if (fromMaps) return fromMaps;
  return (
    findProjectKeyForItemId(id) ??
    scanListForProjectKey(workPagesQueryBaseKey, id) ??
    scanListForProjectKey(workDraftsQueryBaseKey, id) ??
    scanListForProjectKey(workStickiesQueryBaseKey, id) ??
    scanListForProjectKey(workViewsQueryBaseKey, id)
  );
}

function getClientForItemId(itemId: string): DaemonClient {
  const projectKey = findProjectKeyForItemId(itemId);
  if (!projectKey) {
    throw new WorkHostResolutionError(`Cannot resolve host for item ${itemId}: item not found`);
  }
  return getClientForProjectKey(projectKey);
}

function getClientForEntityId(id: string, projectKeyHint?: string | null): DaemonClient {
  if (projectKeyHint) {
    const serverId = projectHostByKey.get(projectKeyHint);
    if (serverId) return getClientForServerId(serverId);
  }
  const projectKey = findProjectKeyForEntityId(id);
  if (projectKey) return getClientForProjectKey(projectKey);
  if (projectKeyHint) return getClientForProjectKey(projectKeyHint);
  throw new WorkHostResolutionError(`Cannot resolve host for entity ${id}: no project mapping`);
}

export function getWorkProjectHostServerId(projectKey: string): string | null {
  return projectHostByKey.get(projectKey) ?? null;
}

export function useWorkProjectHost(projectKey: string | null): {
  serverId: string | null;
  isCapable: boolean | null;
  hostLabel: string | null;
} {
  const hosts = useHosts();
  const derivedServerId = projectKey ? (projectHostByKey.get(projectKey) ?? null) : null;
  const sessions = useSessionStore((state) => state.sessions);
  const hostLabel =
    derivedServerId !== null
      ? (hosts.find((host) => host.serverId === derivedServerId)?.label ?? derivedServerId)
      : null;
  const featureFlag =
    derivedServerId !== null
      ? sessions[derivedServerId]?.serverInfo?.features?.workBoard === true
      : null;
  const isCapable = featureFlag === null ? null : featureFlag === true;
  return { serverId: derivedServerId, isCapable, hostLabel };
}

// ---------------------------------------------------------------------------
// Per-host fleet reads
// ---------------------------------------------------------------------------

interface HostClassified {
  unreachable: string[];
  needsUpdate: string[];
  capableHosts: HostProfile[];
}

// One pass classifies every host into: offline (unreachable), online but no
// workBoard (needs update), and online + workBoard (capable). Never labels a
// stale-but-online host as unreachable.
function classifyHosts(
  hosts: readonly HostProfile[],
  runtime: HostRuntimeStore,
  workFeatureMap: ReadonlyMap<string, boolean>,
): HostClassified {
  const unreachable: string[] = [];
  const needsUpdate: string[] = [];
  const capableHosts: HostProfile[] = [];
  for (const host of hosts) {
    const isOnline = runtime.getSnapshot(host.serverId)?.connectionStatus === "online";
    if (!isOnline) {
      unreachable.push(host.label ?? host.serverId);
      continue;
    }
    if (workFeatureMap.get(host.serverId) !== true) {
      needsUpdate.push(host.label ?? host.serverId);
      continue;
    }
    capableHosts.push(host);
  }
  return { unreachable, needsUpdate, capableHosts };
}

interface ProjectEntryFromHost {
  host: string;
  project: WorkProject;
}

async function fetchProjectsFromHost(client: DaemonClient): Promise<{
  entries: ProjectEntryFromHost[];
  unreachable: string[];
}> {
  const payload = await (
    client as unknown as {
      workProjectList: () => Promise<{
        hosts: Array<{ host: string; reachable: boolean; projects: WorkProject[] }>;
      }>;
    }
  ).workProjectList();
  const entries: ProjectEntryFromHost[] = [];
  const unreachable: string[] = [];
  for (const entry of payload.hosts ?? []) {
    if (!entry.reachable) {
      unreachable.push(entry.host);
      continue;
    }
    for (const project of entry.projects ?? []) {
      entries.push({ host: entry.host, project });
    }
  }
  return { entries, unreachable };
}

async function fetchProjectsForHost(
  runtime: HostRuntimeStore,
  serverId: string,
): Promise<{ entries: ProjectEntryFromHost[]; unreachable: string[]; ok: boolean }> {
  const client = runtime.getClient(serverId) as DaemonClient | null;
  if (!client) return { entries: [], unreachable: [], ok: false };
  try {
    const { entries, unreachable } = await fetchProjectsFromHost(client);
    return { entries, unreachable, ok: true };
  } catch {
    return { entries: [], unreachable: [], ok: false };
  }
}

interface ItemsFromHost {
  items: WorkItem[];
  unreachable: string[];
}

async function fetchItemsFromHost(
  client: DaemonClient,
  projectKey: string,
): Promise<ItemsFromHost> {
  const payload = await (
    client as unknown as {
      workItemList: (arg: { projectKey: string }) => Promise<{
        projectKey: string;
        hosts: Array<{ host: string; reachable: boolean; items: WorkItem[] }>;
      }>;
    }
  ).workItemList({ projectKey });
  const items: WorkItem[] = [];
  const unreachable: string[] = [];
  for (const entry of payload.hosts ?? []) {
    if (!entry.reachable) {
      unreachable.push(entry.host);
      continue;
    }
    items.push(...(entry.items ?? []));
  }
  return { items, unreachable };
}

async function fetchItemsForProject(
  runtime: HostRuntimeStore,
  serverId: string,
  projectKey: string,
): Promise<{ items: WorkItem[]; unreachable: string[]; ok: boolean }> {
  const client = runtime.getClient(serverId) as DaemonClient | null;
  if (!client) return { items: [], unreachable: [], ok: false };
  try {
    const { items, unreachable } = await fetchItemsFromHost(client, projectKey);
    return { items, unreachable, ok: true };
  } catch {
    return { items: [], unreachable: [], ok: false };
  }
}

async function fetchDetailFromHost(
  client: DaemonClient,
  itemId: string,
): Promise<WorkItemDetail | null> {
  const payload = await (
    client as unknown as {
      workItemGet: (arg: { id: string }) => Promise<{ detail: WorkItemDetail | null }>;
    }
  ).workItemGet({ id: itemId });
  return payload.detail ?? null;
}

async function fetchDetailFromServer(
  runtime: HostRuntimeStore,
  serverId: string,
  itemId: string,
): Promise<WorkItemDetail | null> {
  const client = runtime.getClient(serverId) as DaemonClient | null;
  if (!client) return null;
  try {
    return await fetchDetailFromHost(client, itemId);
  } catch {
    return null;
  }
}

async function fetchRowsFromHost<T>(
  runtime: HostRuntimeStore,
  serverId: string,
  projectKey: string,
  fetcher: (client: DaemonClient, projectKey: string) => Promise<T[]>,
): Promise<T[]> {
  const client = runtime.getClient(serverId) as DaemonClient | null;
  if (!client) return [];
  try {
    return await fetcher(client, projectKey);
  } catch {
    return [];
  }
}

function rememberRowForRouting(
  baseKey: readonly unknown[],
  projectKey: string,
  row: { id: string },
): void {
  if (baseKey === workPagesQueryBaseKey) pageProjectById.set(row.id, projectKey);
  else if (baseKey === workDraftsQueryBaseKey) draftProjectById.set(row.id, projectKey);
  else if (baseKey === workStickiesQueryBaseKey) stickyProjectById.set(row.id, projectKey);
  else if (baseKey === workViewsQueryBaseKey) viewProjectById.set(row.id, projectKey);
}

// ---------------------------------------------------------------------------
// Aggregated queries
// ---------------------------------------------------------------------------

export function useWorkProjects(): {
  projects: WorkProject[];
  unreachableHosts: string[];
  hostsNeedingUpdate: string[];
  isLoading: boolean;
  error: string | null;
} {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const workFeatureMap = useHostFeatureMap(serverIds, "workBoard");
  const workFeatureKey = useMemo(
    () => serverIds.map((id) => (workFeatureMap.get(id) === true ? "1" : "0")).join("|"),
    [serverIds, workFeatureMap],
  );

  const query = useFetchQuery<{
    projects: WorkProject[];
    unreachableHosts: string[];
    hostsNeedingUpdate: string[];
  }>({
    queryKey: [
      ...workProjectsQueryBaseKey,
      serverIds.join("|"),
      connectionStatusKey,
      workFeatureKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      const classified = classifyHosts(hosts, runtime, workFeatureMap);
      const projectMap = new Map<string, WorkProject>();
      const nextProjectHost = new Map<string, string>();
      const unreachableRaw = [...classified.unreachable];
      const needsUpdateRaw = classified.needsUpdate;
      const indexes = buildHostLabelIndexes(hosts);

      await Promise.all(
        classified.capableHosts.map(async (host) => {
          const result = await fetchProjectsForHost(runtime, host.serverId);
          if (!result.ok) {
            unreachableRaw.push(host.label ?? host.serverId);
            return;
          }
          unreachableRaw.push(...result.unreachable);
          for (const { host: entryHost, project } of result.entries) {
            if (projectMap.has(project.projectKey)) continue;
            projectMap.set(project.projectKey, project);
            nextProjectHost.set(
              project.projectKey,
              resolveOwnerServerId(entryHost, indexes, host.serverId),
            );
          }
        }),
      );

      projectHostByKey.clear();
      for (const [key, serverId] of nextProjectHost) projectHostByKey.set(key, serverId);

      return {
        projects: Array.from(projectMap.values()),
        unreachableHosts: dedupeHostLabels(unreachableRaw, hosts),
        hostsNeedingUpdate: dedupeHostLabels(needsUpdateRaw, hosts),
      };
    },
  });

  const projects = useMemo(() => query.data?.projects ?? [], [query.data?.projects]);
  const unreachableHosts = useMemo(
    () => query.data?.unreachableHosts ?? [],
    [query.data?.unreachableHosts],
  );
  const hostsNeedingUpdate = useMemo(
    () => query.data?.hostsNeedingUpdate ?? [],
    [query.data?.hostsNeedingUpdate],
  );

  const selectedKey = useSelectedWorkProjectKey();
  useEffect(() => {
    if (selectedKey) return;
    if (projects.length === 0) return;
    if (query.isLoading) return;
    setSelectedWorkProjectKey(projects[0]!.projectKey);
  }, [projects, query.isLoading, selectedKey]);

  return {
    projects,
    unreachableHosts,
    hostsNeedingUpdate,
    isLoading: query.isLoading,
    error: toErrorString(query.error),
  };
}

export function useWorkItems(projectKey: string | null): {
  items: WorkItem[];
  byColumn: Record<WorkColumnId, WorkItem[]>;
  unreachableHosts: string[];
  hostsNeedingUpdate: string[];
  isLoading: boolean;
  error: string | null;
} {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const workFeatureMap = useHostFeatureMap(serverIds, "workBoard");
  const workFeatureKey = useMemo(
    () => serverIds.map((id) => (workFeatureMap.get(id) === true ? "1" : "0")).join("|"),
    [serverIds, workFeatureMap],
  );

  const enabled = projectKey !== null && projectKey.length > 0;

  const query = useFetchQuery<{
    items: WorkItem[];
    unreachableHosts: string[];
    hostsNeedingUpdate: string[];
  }>({
    queryKey: [
      ...workItemsQueryBaseKey,
      projectKey ?? "__none__",
      serverIds.join("|"),
      connectionStatusKey,
      workFeatureKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!projectKey) return { items: [], unreachableHosts: [], hostsNeedingUpdate: [] };
      const classified = classifyHosts(hosts, runtime, workFeatureMap);
      const unreachableRaw = [...classified.unreachable];
      const needsUpdateRaw = classified.needsUpdate;
      const itemMap = new Map<string, WorkItem>();
      const owningServerId = projectHostByKey.get(projectKey) ?? null;
      if (owningServerId) {
        const snap = runtime.getSnapshot(owningServerId);
        const isOnline = snap?.connectionStatus === "online";
        const capable = workFeatureMap.get(owningServerId) === true;
        if (isOnline && capable) {
          const result = await fetchItemsForProject(runtime, owningServerId, projectKey);
          unreachableRaw.push(...result.unreachable);
          if (!result.ok) {
            unreachableRaw.push(
              hosts.find((host) => host.serverId === owningServerId)?.label ?? owningServerId,
            );
          }
          for (const item of result.items) itemMap.set(item.id, item);
        }
        return {
          items: Array.from(itemMap.values()),
          unreachableHosts: dedupeHostLabels(unreachableRaw, hosts),
          hostsNeedingUpdate: dedupeHostLabels(needsUpdateRaw, hosts),
        };
      }
      await Promise.all(
        classified.capableHosts.map(async (host) => {
          const result = await fetchItemsForProject(runtime, host.serverId, projectKey);
          if (!result.ok) {
            unreachableRaw.push(host.label ?? host.serverId);
            return;
          }
          unreachableRaw.push(...result.unreachable);
          for (const item of result.items) itemMap.set(item.id, item);
        }),
      );
      return {
        items: Array.from(itemMap.values()),
        unreachableHosts: dedupeHostLabels(unreachableRaw, hosts),
        hostsNeedingUpdate: dedupeHostLabels(needsUpdateRaw, hosts),
      };
    },
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const unreachableHosts = useMemo(
    () => query.data?.unreachableHosts ?? [],
    [query.data?.unreachableHosts],
  );
  const hostsNeedingUpdate = useMemo(
    () => query.data?.hostsNeedingUpdate ?? [],
    [query.data?.hostsNeedingUpdate],
  );
  const byColumn = useMemo(() => {
    if (!enabled) {
      const m = {} as Record<WorkColumnId, WorkItem[]>;
      for (const id of WORK_COLUMN_IDS) m[id] = [];
      return m;
    }
    return buildByColumn(items);
  }, [enabled, items]);

  if (!enabled) {
    return {
      items: [],
      byColumn,
      unreachableHosts: [],
      hostsNeedingUpdate: [],
      isLoading: false,
      error: null,
    };
  }

  return {
    items,
    byColumn,
    unreachableHosts,
    hostsNeedingUpdate,
    isLoading: query.isLoading,
    error: toErrorString(query.error),
  };
}

export function useWorkItemDetail(itemId: string | null): {
  detail: WorkItemDetail | null;
  isLoading: boolean;
  error: string | null;
} {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const enabled = itemId !== null && itemId.length > 0;

  const query = useFetchQuery<WorkItemDetail | null>({
    queryKey: [
      ...workItemDetailQueryBaseKey,
      itemId ?? "__none__",
      serverIds.join("|"),
      connectionStatusKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!itemId) return null;
      const projectKey = findProjectKeyForItemId(itemId);
      const owningServerId = projectKey ? (projectHostByKey.get(projectKey) ?? null) : null;
      if (owningServerId) {
        const detail = await fetchDetailFromServer(runtime, owningServerId, itemId);
        if (detail) return detail;
      }
      for (const host of hosts) {
        const isOnline = runtime.getSnapshot(host.serverId)?.connectionStatus === "online";
        if (!isOnline) continue;
        const capable =
          useSessionStore.getState().sessions[host.serverId]?.serverInfo?.features?.workBoard ===
          true;
        if (!capable) continue;
        const detail = await fetchDetailFromServer(runtime, host.serverId, itemId);
        if (detail) return detail;
      }
      return null;
    },
  });

  if (!enabled) {
    return { detail: null, isLoading: false, error: null };
  }

  return {
    detail: query.data ?? null,
    isLoading: query.isLoading,
    error: toErrorString(query.error),
  };
}

function useWorkListQuery<T extends { id: string; projectKey: string }>(
  baseKey: readonly string[],
  projectKey: string | null,
  fetcher: (client: DaemonClient, projectKey: string) => Promise<T[]>,
): { rows: T[]; isLoading: boolean; error: string | null } {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const workFeatureMap = useHostFeatureMap(serverIds, "workBoard");
  const workFeatureKey = useMemo(
    () => serverIds.map((id) => (workFeatureMap.get(id) === true ? "1" : "0")).join("|"),
    [serverIds, workFeatureMap],
  );
  const enabled = projectKey !== null && projectKey.length > 0;

  const query = useFetchQuery<T[]>({
    queryKey: [
      ...baseKey,
      projectKey ?? "__none__",
      serverIds.join("|"),
      connectionStatusKey,
      workFeatureKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!projectKey) return [];
      const owningServerId = projectHostByKey.get(projectKey) ?? null;
      if (owningServerId) {
        const snap = runtime.getSnapshot(owningServerId);
        const isOnline = snap?.connectionStatus === "online";
        const capable = workFeatureMap.get(owningServerId) === true;
        if (!isOnline || !capable) return [];
        const rows = await fetchRowsFromHost(runtime, owningServerId, projectKey, fetcher);
        for (const row of rows) rememberRowForRouting(baseKey, projectKey, row);
        return rows;
      }
      const seen = new Map<string, T>();
      const capableHosts = hosts.filter((host) => {
        const snap = runtime.getSnapshot(host.serverId);
        return snap?.connectionStatus === "online" && workFeatureMap.get(host.serverId) === true;
      });
      await Promise.all(
        capableHosts.map(async (host) => {
          const rows = await fetchRowsFromHost(runtime, host.serverId, projectKey, fetcher);
          for (const row of rows) {
            if (seen.has(row.id)) continue;
            seen.set(row.id, row);
            rememberRowForRouting(baseKey, projectKey, row);
          }
        }),
      );
      return Array.from(seen.values());
    },
  });

  if (!enabled) {
    return { rows: [], isLoading: false, error: null };
  }
  return { rows: query.data ?? [], isLoading: query.isLoading, error: toErrorString(query.error) };
}

export function useWorkPages(projectKey: string | null): {
  rows: WorkPage[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkPage & { projectKey: string }>(
    workPagesQueryBaseKey,
    projectKey,
    async (client, pk) => {
      const payload = await (
        client as unknown as {
          workPageList: (arg: { projectKey: string }) => Promise<{ pages: WorkPage[] }>;
        }
      ).workPageList({ projectKey: pk });
      return (payload.pages ?? []) as Array<WorkPage & { projectKey: string }>;
    },
  );
}

export function useWorkDrafts(projectKey: string | null): {
  rows: WorkDraft[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkDraft & { projectKey: string }>(
    workDraftsQueryBaseKey,
    projectKey,
    async (client, pk) => {
      const payload = await (
        client as unknown as {
          workDraftList: (arg: { projectKey: string }) => Promise<{ drafts: WorkDraft[] }>;
        }
      ).workDraftList({ projectKey: pk });
      return (payload.drafts ?? []) as Array<WorkDraft & { projectKey: string }>;
    },
  );
}

export function useWorkStickies(projectKey: string | null): {
  rows: WorkSticky[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkSticky & { projectKey: string }>(
    workStickiesQueryBaseKey,
    projectKey,
    async (client, pk) => {
      const payload = await (
        client as unknown as {
          workStickyList: (arg: { projectKey: string }) => Promise<{ stickies: WorkSticky[] }>;
        }
      ).workStickyList({ projectKey: pk });
      return (payload.stickies ?? []) as Array<WorkSticky & { projectKey: string }>;
    },
  );
}

export function useWorkViews(projectKey: string | null): {
  rows: WorkView[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkView & { projectKey: string }>(
    workViewsQueryBaseKey,
    projectKey,
    async (client, pk) => {
      const payload = await (
        client as unknown as {
          workViewList: (arg: { projectKey: string }) => Promise<{ views: WorkView[] }>;
        }
      ).workViewList({ projectKey: pk });
      return (payload.views ?? []) as Array<WorkView & { projectKey: string }>;
    },
  );
}

export function useWorkMutations(): {
  createItem: (input: {
    projectKey: string;
    title: string;
    description?: string;
    priority?: WorkItem["priority"];
    labelIds?: string[];
    parentId?: string | null;
    lane?: WorkItem["lane"];
    assignment?: WorkItem["assignment"];
  }) => Promise<WorkItem | null>;
  updateItem: (input: {
    id: string;
    patch: {
      title?: string;
      description?: string;
      priority?: WorkItem["priority"];
      labelIds?: string[];
      parentId?: string | null;
      assignment?: WorkItem["assignment"] | null;
      lane?: WorkItem["lane"];
    };
  }) => Promise<WorkItem | null>;
  deleteItem: (input: { id: string }) => Promise<void>;
  moveItem: (input: {
    itemId: string;
    targetColumn: WorkColumnId;
    prevSortOrder: number | null;
    nextSortOrder: number | null;
  }) => Promise<WorkItem | null>;
  dispatchItem: (input: { id: string }) => Promise<void>;
  createComment: (input: { itemId: string; body: string }) => Promise<WorkComment | null>;
  upsertLabel: (input: {
    projectKey: string;
    name: string;
    color?: string;
    newName?: string;
  }) => Promise<WorkLabel | null>;
  deleteLabel: (input: { id: string; projectKey?: string }) => Promise<void>;
  upsertPage: (input: {
    projectKey: string;
    page: { id?: string; title: string; body: string; parentId?: string | null };
  }) => Promise<WorkPage | null>;
  deletePage: (input: { id: string; projectKey?: string }) => Promise<void>;
  createDraft: (input: {
    projectKey: string;
    title: string;
    description?: string;
    priority?: WorkItem["priority"];
    labelIds?: string[];
    parentId?: string | null;
    assignment?: WorkItem["assignment"] | null;
  }) => Promise<WorkDraft | null>;
  promoteDraft: (input: { id: string }) => Promise<WorkItem | null>;
  upsertSticky: (input: {
    projectKey: string;
    sticky: { id?: string; body: string };
  }) => Promise<WorkSticky | null>;
  deleteSticky: (input: { id: string; projectKey?: string }) => Promise<void>;
  upsertView: (input: {
    projectKey: string;
    view: { id?: string; name: string; filters?: unknown; groupBy?: unknown; orderBy?: unknown };
  }) => Promise<WorkView | null>;
} {
  const qc = useQueryClient();

  const invalidateAllWork = useCallback(() => {
    void qc.invalidateQueries({ queryKey: workProjectsQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workItemsQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workItemDetailQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workPagesQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workDraftsQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workStickiesQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workViewsQueryBaseKey });
  }, [qc]);

  const invalidateItems = useCallback(() => {
    void qc.invalidateQueries({ queryKey: workItemsQueryBaseKey });
    void qc.invalidateQueries({ queryKey: workItemDetailQueryBaseKey });
  }, [qc]);

  const createItem = useCallback(
    async (input: {
      projectKey: string;
      title: string;
      description?: string;
      priority?: WorkItem["priority"];
      labelIds?: string[];
      parentId?: string | null;
      lane?: WorkItem["lane"];
      assignment?: WorkItem["assignment"];
    }): Promise<WorkItem | null> => {
      const client = getClientForProjectKey(input.projectKey);
      const payload = await (
        client as unknown as {
          workItemCreate: (
            arg: unknown,
          ) => Promise<{ item: WorkItem | null; error?: string | null }>;
        }
      ).workItemCreate({
        projectKey: input.projectKey,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.lane !== undefined ? { lane: input.lane } : {}),
        ...(input.assignment !== undefined ? { assignment: input.assignment } : {}),
      });
      if (payload.error) throw new Error(payload.error);
      invalidateItems();
      void qc.invalidateQueries({ queryKey: workProjectsQueryBaseKey });
      return payload.item ?? null;
    },
    [invalidateItems, qc],
  );

  const updateItem = useCallback(
    async (input: {
      id: string;
      patch: {
        title?: string;
        description?: string;
        priority?: WorkItem["priority"];
        labelIds?: string[];
        parentId?: string | null;
        assignment?: WorkItem["assignment"] | null;
        lane?: WorkItem["lane"];
      };
    }): Promise<WorkItem | null> => {
      const client = getClientForItemId(input.id);
      const payload = await (
        client as unknown as {
          workItemUpdate: (
            arg: unknown,
          ) => Promise<{ item: WorkItem | null; error?: string | null }>;
        }
      ).workItemUpdate({
        id: input.id,
        ...input.patch,
      });
      if (payload.error) throw new Error(payload.error);
      invalidateItems();
      return payload.item ?? null;
    },
    [invalidateItems],
  );

  const deleteItem = useCallback(
    async (input: { id: string }): Promise<void> => {
      const client = getClientForItemId(input.id);
      const payload = await (
        client as unknown as {
          workItemDelete: (arg: unknown) => Promise<{ success: boolean; error?: string | null }>;
        }
      ).workItemDelete({ id: input.id });
      if (payload.error) throw new Error(payload.error);
      invalidateItems();
    },
    [invalidateItems],
  );

  type MoveCacheSnapshot = Array<[readonly unknown[], unknown]>;
  const moveMutation = useMutation<
    WorkItem | null,
    Error,
    {
      itemId: string;
      targetColumn: WorkColumnId;
      prevSortOrder: number | null;
      nextSortOrder: number | null;
    },
    MoveCacheSnapshot
  >({
    mutationFn: async (input) => {
      const sortOrder = computeSortOrder({
        prevSortOrder: input.prevSortOrder,
        nextSortOrder: input.nextSortOrder,
      });
      const client = getClientForItemId(input.itemId);
      const payload = await (
        client as unknown as {
          workItemMove: (arg: unknown) => Promise<{ item: WorkItem | null; error?: string | null }>;
        }
      ).workItemMove({
        id: input.itemId,
        targetColumn: input.targetColumn,
        sortOrder,
      });
      if (payload.error) throw new Error(payload.error);
      return payload.item ?? null;
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: workItemsQueryBaseKey });
      const snapshot: MoveCacheSnapshot = qc.getQueriesData({
        queryKey: workItemsQueryBaseKey,
      }) as MoveCacheSnapshot;
      const sortOrder = computeSortOrder({
        prevSortOrder: input.prevSortOrder,
        nextSortOrder: input.nextSortOrder,
      });
      for (const [key, data] of snapshot) {
        if (!data || typeof data !== "object") continue;
        const d = data as { items?: WorkItem[] };
        if (!Array.isArray(d.items)) continue;
        const nextItems = d.items.map((it) =>
          it.id === input.itemId ? { ...it, sortOrder, column: input.targetColumn } : it,
        );
        qc.setQueryData(key, { ...d, items: nextItems });
      }
      return snapshot;
    },
    onError: (_err, _vars, context) => {
      if (context) {
        for (const [key, data] of context) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      invalidateItems();
    },
  });

  const moveItem = useCallback(
    async (input: {
      itemId: string;
      targetColumn: WorkColumnId;
      prevSortOrder: number | null;
      nextSortOrder: number | null;
    }): Promise<WorkItem | null> => {
      return moveMutation.mutateAsync(input);
    },
    [moveMutation],
  );

  const dispatchItem = useCallback(
    async (input: { id: string }): Promise<void> => {
      const client = getClientForItemId(input.id);
      const payload = await (
        client as unknown as {
          workItemDispatch: (arg: unknown) => Promise<{ error?: string | null }>;
        }
      ).workItemDispatch({ id: input.id });
      if (payload.error) throw new Error(payload.error);
      invalidateItems();
    },
    [invalidateItems],
  );

  const createComment = useCallback(
    async (input: { itemId: string; body: string }): Promise<WorkComment | null> => {
      const client = getClientForItemId(input.itemId);
      const payload = await (
        client as unknown as {
          workCommentCreate: (
            arg: unknown,
          ) => Promise<{ comment: WorkComment | null; error?: string | null }>;
        }
      ).workCommentCreate({
        itemId: input.itemId,
        body: input.body,
      });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workItemDetailQueryBaseKey });
      return payload.comment ?? null;
    },
    [qc],
  );

  const upsertLabel = useCallback(
    async (input: {
      projectKey: string;
      name: string;
      color?: string;
      newName?: string;
    }): Promise<WorkLabel | null> => {
      const client = getClientForProjectKey(input.projectKey);
      const payload = await (
        client as unknown as {
          workLabelUpsert: (
            arg: unknown,
          ) => Promise<{ label: WorkLabel | null; error?: string | null }>;
        }
      ).workLabelUpsert({
        projectKey: input.projectKey,
        label: {
          name: input.name,
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.newName !== undefined ? { newName: input.newName } : {}),
        },
      });
      if (payload.error) throw new Error(payload.error);
      invalidateAllWork();
      return payload.label ?? null;
    },
    [invalidateAllWork],
  );

  const deleteLabel = useCallback(
    async (input: { id: string; projectKey?: string }): Promise<void> => {
      const client = getClientForEntityId(input.id, input.projectKey ?? null);
      const payload = await (
        client as unknown as {
          workLabelDelete: (arg: unknown) => Promise<{ success: boolean; error?: string | null }>;
        }
      ).workLabelDelete({ id: input.id });
      if (payload.error) throw new Error(payload.error);
      invalidateAllWork();
    },
    [invalidateAllWork],
  );

  const upsertPage = useCallback(
    async (input: {
      projectKey: string;
      page: { id?: string; title: string; body: string; parentId?: string | null };
    }): Promise<WorkPage | null> => {
      const client = getClientForProjectKey(input.projectKey);
      const payload = await (
        client as unknown as {
          workPageUpsert: (
            arg: unknown,
          ) => Promise<{ page: WorkPage | null; error?: string | null }>;
        }
      ).workPageUpsert({
        projectKey: input.projectKey,
        page: input.page,
      });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workPagesQueryBaseKey });
      return payload.page ?? null;
    },
    [qc],
  );

  const deletePage = useCallback(
    async (input: { id: string; projectKey?: string }): Promise<void> => {
      const client = getClientForEntityId(input.id, input.projectKey ?? null);
      const payload = await (
        client as unknown as {
          workPageDelete: (arg: unknown) => Promise<{ success: boolean; error?: string | null }>;
        }
      ).workPageDelete({ id: input.id });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workPagesQueryBaseKey });
    },
    [qc],
  );

  const createDraft = useCallback(
    async (input: {
      projectKey: string;
      title: string;
      description?: string;
      priority?: WorkItem["priority"];
      labelIds?: string[];
      parentId?: string | null;
      assignment?: WorkItem["assignment"] | null;
    }): Promise<WorkDraft | null> => {
      const client = getClientForProjectKey(input.projectKey);
      const payload = await (
        client as unknown as {
          workDraftCreate: (
            arg: unknown,
          ) => Promise<{ draft: WorkDraft | null; error?: string | null }>;
        }
      ).workDraftCreate({
        projectKey: input.projectKey,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.assignment !== undefined ? { assignment: input.assignment } : {}),
      });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workDraftsQueryBaseKey });
      return payload.draft ?? null;
    },
    [qc],
  );

  const promoteDraft = useCallback(
    async (input: { id: string }): Promise<WorkItem | null> => {
      const client = getClientForEntityId(input.id);
      const payload = await (
        client as unknown as {
          workDraftPromote: (
            arg: unknown,
          ) => Promise<{ item: WorkItem | null; error?: string | null }>;
        }
      ).workDraftPromote({ id: input.id });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workDraftsQueryBaseKey });
      invalidateItems();
      return payload.item ?? null;
    },
    [invalidateItems, qc],
  );

  const upsertSticky = useCallback(
    async (input: {
      projectKey: string;
      sticky: { id?: string; body: string };
    }): Promise<WorkSticky | null> => {
      const client = getClientForProjectKey(input.projectKey);
      const payload = await (
        client as unknown as {
          workStickyUpsert: (
            arg: unknown,
          ) => Promise<{ sticky: WorkSticky | null; error?: string | null }>;
        }
      ).workStickyUpsert({
        projectKey: input.projectKey,
        sticky: input.sticky,
      });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workStickiesQueryBaseKey });
      return payload.sticky ?? null;
    },
    [qc],
  );

  const deleteSticky = useCallback(
    async (input: { id: string; projectKey?: string }): Promise<void> => {
      const client = getClientForEntityId(input.id, input.projectKey ?? null);
      const payload = await (
        client as unknown as {
          workStickyDelete: (arg: unknown) => Promise<{ success: boolean; error?: string | null }>;
        }
      ).workStickyDelete({ id: input.id });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workStickiesQueryBaseKey });
    },
    [qc],
  );

  const upsertView = useCallback(
    async (input: {
      projectKey: string;
      view: { id?: string; name: string; filters?: unknown; groupBy?: unknown; orderBy?: unknown };
    }): Promise<WorkView | null> => {
      const client = getClientForProjectKey(input.projectKey);
      const payload = await (
        client as unknown as {
          workViewUpsert: (
            arg: unknown,
          ) => Promise<{ view: WorkView | null; error?: string | null }>;
        }
      ).workViewUpsert({
        projectKey: input.projectKey,
        view: input.view,
      });
      if (payload.error) throw new Error(payload.error);
      void qc.invalidateQueries({ queryKey: workViewsQueryBaseKey });
      return payload.view ?? null;
    },
    [qc],
  );

  return {
    createItem,
    updateItem,
    deleteItem,
    moveItem,
    dispatchItem,
    createComment,
    upsertLabel,
    deleteLabel,
    upsertPage,
    deletePage,
    createDraft,
    promoteDraft,
    upsertSticky,
    deleteSticky,
    upsertView,
  };
}
