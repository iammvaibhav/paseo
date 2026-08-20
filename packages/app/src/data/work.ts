import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
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

function getOnlineClientForMutation(): DaemonClient {
  const runtime = getHostRuntimeStore();
  const state = useSessionStore.getState();
  const serverIds = Object.keys(state.sessions);
  for (const sid of serverIds) {
    const snap = runtime.getSnapshot(sid);
    if (snap?.connectionStatus === "online") {
      const c = runtime.getClient(sid);
      if (c) return c;
    }
  }
  for (const sid of serverIds) {
    const c = runtime.getClient(sid);
    if (c) return c;
  }
  throw new Error("No connected host available");
}

function buildByColumn(items: WorkItem[]): Record<WorkColumnId, WorkItem[]> {
  const byColumn = {} as Record<WorkColumnId, WorkItem[]>;
  for (const id of WORK_COLUMN_IDS) {
    byColumn[id] = [];
  }
  for (const item of items) {
    const col = item.column;
    if (col === "cancelled") continue;
    // column is WorkColumnId | "cancelled" — only bucket WorkColumnIds
    if ((WORK_COLUMN_IDS as readonly string[]).includes(col)) {
      byColumn[col as WorkColumnId].push(item);
    }
  }
  for (const id of WORK_COLUMN_IDS) {
    byColumn[id].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return byColumn;
}

export function useWorkProjects(): {
  projects: WorkProject[];
  unreachableHosts: string[];
  isLoading: boolean;
  error: string | null;
} {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery<{ projects: WorkProject[]; unreachableHosts: string[] }>({
    queryKey: [
      ...workProjectsQueryBaseKey,
      serverIds.join("|"),
      connectionStatusKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      const projectMap = new Map<string, WorkProject>();
      const unreachable = new Set<string>();
      let attemptedOnline = 0;
      let anySuccess = false;

      await Promise.all(
        hosts.map(async (host) => {
          const snap = runtime.getSnapshot(host.serverId);
          const isOnline = snap?.connectionStatus === "online";
          const client = runtime.getClient(host.serverId) as DaemonClient | null;
          if (!isOnline || !client) return;
          attemptedOnline += 1;
          try {
            const payload = await (
              client as unknown as {
                workProjectList: () => Promise<{
                  hosts: Array<{ host: string; reachable: boolean; projects: WorkProject[] }>;
                }>;
              }
            ).workProjectList();
            anySuccess = true;
            for (const entry of payload.hosts ?? []) {
              if (!entry.reachable) {
                unreachable.add(entry.host);
                continue;
              }
              for (const p of entry.projects ?? []) {
                if (!projectMap.has(p.projectKey)) {
                  projectMap.set(p.projectKey, p);
                }
              }
            }
          } catch {
            unreachable.add(host.label ?? host.serverId);
          }
        }),
      );

      // If no online host attempted but there are settling hosts, keep loading state handled by caller via isLoading;
      // Return empty with no error so UI shows loading.
      if (attemptedOnline === 0) {
        return { projects: [], unreachableHosts: [] };
      }
      // If all attempted hosts failed and no success, surface as error via throw
      if (!anySuccess && unreachable.size === attemptedOnline && attemptedOnline > 0) {
        // Return empty but caller will see error from throw alternative; we throw to trigger error state
        // Instead return empty and let error be shown via query error if we throw
        // Choose to throw so error string surfaces
        // But to keep unreachableHosts, we throw with message and let hook map error
        // Return empty projects and unreachable hosts without throwing — error will be null, unreachableHosts shown
        // For strict spec: unreachable hosts are represented, not swallowed, not throwing
      }
      return {
        projects: Array.from(projectMap.values()),
        unreachableHosts: Array.from(unreachable),
      };
    },
  });

  const projects = useMemo(() => query.data?.projects ?? [], [query.data?.projects]);
  const unreachableHosts = useMemo(
    () => query.data?.unreachableHosts ?? [],
    [query.data?.unreachableHosts],
  );

  // Default selection to first project once projects load
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
    isLoading: query.isLoading,
    error: toErrorString(query.error),
  };
}

export function useWorkItems(projectKey: string | null): {
  items: WorkItem[];
  byColumn: Record<WorkColumnId, WorkItem[]>;
  unreachableHosts: string[];
  isLoading: boolean;
  error: string | null;
} {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const enabled = projectKey !== null && projectKey.length > 0;

  const query = useFetchQuery<{ items: WorkItem[]; unreachableHosts: string[] }>({
    queryKey: [
      ...workItemsQueryBaseKey,
      projectKey ?? "__none__",
      serverIds.join("|"),
      connectionStatusKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!projectKey) return { items: [], unreachableHosts: [] };
      const itemMap = new Map<string, WorkItem>();
      const unreachable = new Set<string>();
      await Promise.all(
        hosts.map(async (host) => {
          const snap = runtime.getSnapshot(host.serverId);
          const isOnline = snap?.connectionStatus === "online";
          const client = runtime.getClient(host.serverId) as DaemonClient | null;
          if (!isOnline || !client) return;
          try {
            const payload = await (
              client as unknown as {
                workItemList: (arg: { projectKey: string }) => Promise<{
                  projectKey: string;
                  hosts: Array<{ host: string; reachable: boolean; items: WorkItem[] }>;
                }>;
              }
            ).workItemList({ projectKey });
            for (const entry of payload.hosts ?? []) {
              if (!entry.reachable) {
                unreachable.add(entry.host);
                continue;
              }
              for (const it of entry.items ?? []) {
                if (!itemMap.has(it.id)) {
                  itemMap.set(it.id, it);
                }
              }
            }
          } catch {
            unreachable.add(host.label ?? host.serverId);
          }
        }),
      );
      return { items: Array.from(itemMap.values()), unreachableHosts: Array.from(unreachable) };
    },
    // When disabled, useFetchQuery expects queryFn optional? Provide enabled flag via queryFn returning empty but also disable via staleTime?
    // useFetchQuery doesn't have enabled param in our wrapper; we gate by returning early and relying on queryFn anyway.
    // To truly disable, we rely on caller: when projectKey null, data is empty and we don't want to fetch.
    // Workaround: queryFn already returns empty; isLoading will be false after initial fetch.
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const unreachableHosts = useMemo(
    () => query.data?.unreachableHosts ?? [],
    [query.data?.unreachableHosts],
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
    return { items: [], byColumn, unreachableHosts: [], isLoading: false, error: null };
  }

  return {
    items,
    byColumn,
    unreachableHosts,
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
  const serverIds = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
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
      // Try each online host sequentially; server forwards via fleetIdIndex if needed
      for (const host of hosts) {
        const snap = runtime.getSnapshot(host.serverId);
        const isOnline = snap?.connectionStatus === "online";
        const client = runtime.getClient(host.serverId) as DaemonClient | null;
        if (!isOnline || !client) continue;
        try {
          const payload = await (
            client as unknown as {
              workItemGet: (arg: { id: string }) => Promise<{ detail: WorkItemDetail | null }>;
            }
          ).workItemGet({ id: itemId });
          if (payload.detail) return payload.detail;
        } catch {
          continue;
        }
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

function useWorkListQuery<T>(
  baseKey: readonly string[],
  projectKey: string | null,
  fetcher: (client: DaemonClient, projectKey: string) => Promise<T[]>,
): { rows: T[]; isLoading: boolean; error: string | null } {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((id) => connectionStatuses.get(id) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const enabled = projectKey !== null && projectKey.length > 0;

  const query = useFetchQuery<T[]>({
    queryKey: [
      ...baseKey,
      projectKey ?? "__none__",
      serverIds.join("|"),
      connectionStatusKey,
    ] as unknown as readonly unknown[],
    dataShape: "list",
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!projectKey) return [];
      const seen = new Map<string, T>();
      await Promise.all(
        hosts.map(async (host) => {
          const snap = runtime.getSnapshot(host.serverId);
          const isOnline = snap?.connectionStatus === "online";
          const client = runtime.getClient(host.serverId) as DaemonClient | null;
          if (!isOnline || !client) return;
          try {
            const rows = await fetcher(client, projectKey);
            for (const r of rows) {
              const id = (r as unknown as { id: string }).id;
              if (id && !seen.has(id)) seen.set(id, r);
              else if (!id) seen.set(`${host.serverId}:${Math.random()}`, r);
            }
          } catch {
            // unreachable handled at higher level for items/projects; for pages etc just skip
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
  return useWorkListQuery<WorkPage>(workPagesQueryBaseKey, projectKey, async (client, pk) => {
    const payload = await (
      client as unknown as {
        workPageList: (arg: { projectKey: string }) => Promise<{ pages: WorkPage[] }>;
      }
    ).workPageList({ projectKey: pk });
    return payload.pages ?? [];
  });
}

export function useWorkDrafts(projectKey: string | null): {
  rows: WorkDraft[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkDraft>(workDraftsQueryBaseKey, projectKey, async (client, pk) => {
    const payload = await (
      client as unknown as {
        workDraftList: (arg: { projectKey: string }) => Promise<{ drafts: WorkDraft[] }>;
      }
    ).workDraftList({ projectKey: pk });
    return payload.drafts ?? [];
  });
}

export function useWorkStickies(projectKey: string | null): {
  rows: WorkSticky[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkSticky>(workStickiesQueryBaseKey, projectKey, async (client, pk) => {
    const payload = await (
      client as unknown as {
        workStickyList: (arg: { projectKey: string }) => Promise<{ stickies: WorkSticky[] }>;
      }
    ).workStickyList({ projectKey: pk });
    return payload.stickies ?? [];
  });
}

export function useWorkViews(projectKey: string | null): {
  rows: WorkView[];
  isLoading: boolean;
  error: string | null;
} {
  return useWorkListQuery<WorkView>(workViewsQueryBaseKey, projectKey, async (client, pk) => {
    const payload = await (
      client as unknown as {
        workViewList: (arg: { projectKey: string }) => Promise<{ views: WorkView[] }>;
      }
    ).workViewList({ projectKey: pk });
    return payload.views ?? [];
  });
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
    name: string;
    color?: string;
    newName?: string;
  }) => Promise<WorkLabel | null>;
  deleteLabel: (input: { id: string }) => Promise<void>;
  upsertPage: (input: {
    projectKey: string;
    page: { id?: string; title: string; body: string; parentId?: string | null };
  }) => Promise<WorkPage | null>;
  deletePage: (input: { id: string }) => Promise<void>;
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
  deleteSticky: (input: { id: string }) => Promise<void>;
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
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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

  // Optimistic moveItem
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
      const client = getOnlineClientForMutation();
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
      // Apply optimistic: update each cached aggregated items list
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
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
      name: string;
      color?: string;
      newName?: string;
    }): Promise<WorkLabel | null> => {
      const client = getOnlineClientForMutation();
      const payload = await (
        client as unknown as {
          workLabelUpsert: (
            arg: unknown,
          ) => Promise<{ label: WorkLabel | null; error?: string | null }>;
        }
      ).workLabelUpsert(input);
      if (payload.error) throw new Error(payload.error);
      // labels not yet queried separately; invalidate generically
      invalidateAllWork();
      return payload.label ?? null;
    },
    [invalidateAllWork],
  );

  const deleteLabel = useCallback(
    async (input: { id: string }): Promise<void> => {
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
    async (input: { id: string }): Promise<void> => {
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
    async (input: { id: string }): Promise<void> => {
      const client = getOnlineClientForMutation();
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
      const client = getOnlineClientForMutation();
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
