import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface SubmoduleEntry {
  path: string;
  name: string;
  status: "clean" | "dirty" | "uninitialized";
  headRef: string | null;
  parentPath: string | null;
}

export interface SubmoduleInfo extends SubmoduleEntry {
  children: SubmoduleInfo[];
}

function submodulesQueryKey(serverId: string, cwd: string) {
  return ["checkoutSubmodules", serverId, cwd] as const;
}

function buildTree(flat: SubmoduleEntry[]): SubmoduleInfo[] {
  const byPath = new Map<string, SubmoduleInfo>();
  const roots: SubmoduleInfo[] = [];

  const sorted = [...flat].sort((a, b) => a.path.split("/").length - b.path.split("/").length);

  for (const entry of sorted) {
    const node: SubmoduleInfo = { ...entry, children: [] };
    byPath.set(entry.path, node);

    if (entry.parentPath) {
      const parent = byPath.get(entry.parentPath);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return roots;
}

interface UseSubmodulesQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export function useSubmodulesQuery({ serverId, cwd, enabled = true }: UseSubmodulesQueryOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useFetchQuery({
    dataShape: "list",
    queryKey: submodulesQueryKey(serverId, cwd),
    queryFn: async (): Promise<SubmoduleInfo[]> => {
      if (!client) return [];
      const result = await client.checkoutSubmodules(cwd);
      return buildTree(result.submodules as SubmoduleEntry[]);
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTimeMs: 60_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  return {
    submodules: query.data ?? [],
    isLoading: query.isLoading,
    hasSubmodules: (query.data?.length ?? 0) > 0,
  };
}
