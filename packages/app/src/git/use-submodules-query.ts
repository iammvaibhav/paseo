import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface SubmoduleInfo {
  path: string;
  name: string;
  status: "clean" | "dirty" | "uninitialized";
  headRef: string | null;
  children: SubmoduleInfo[];
}

function submodulesQueryKey(serverId: string, cwd: string) {
  return ["checkoutSubmodules", serverId, cwd] as const;
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
      return result.submodules as SubmoduleInfo[];
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
