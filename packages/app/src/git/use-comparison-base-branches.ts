import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseComparisonBaseBranchesInput {
  serverId: string;
  cwd: string;
  enabled: boolean;
}

interface ComparisonBaseBranches {
  branches: string[];
  isLoading: boolean;
  errorMessage: string | null;
}

const NO_BRANCHES: string[] = [];

// Local and remote branches the Changes pane can diff against, as display names. Fetched
// lazily: the list is only needed once the picker opens.
export function useComparisonBaseBranches({
  serverId,
  cwd,
  enabled,
}: UseComparisonBaseBranchesInput): ComparisonBaseBranches {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const query = useQuery({
    queryKey: ["comparisonBaseBranches", serverId, cwd],
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.getBranchSuggestions({ cwd, limit: 200 });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches;
    },
    enabled: enabled && Boolean(client) && isConnected,
    retry: false,
    staleTime: 15_000,
  });
  const errorMessage = query.error instanceof Error ? query.error.message : null;
  return {
    branches: query.data ?? NO_BRANCHES,
    isLoading: query.isPending && query.fetchStatus === "fetching",
    errorMessage,
  };
}
