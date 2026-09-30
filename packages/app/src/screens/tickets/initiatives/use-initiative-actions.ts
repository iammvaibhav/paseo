import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Initiative } from "@getpaseo/protocol/tickets/types";
import { useTicketMutations, type SaveInitiativeInput } from "@/tickets/queries";
import { initiativesQueryRoot } from "@/tickets/query-keys";

export interface InitiativeActions {
  save: (input: SaveInitiativeInput) => Promise<Initiative>;
  remove: (initiativeId: string) => Promise<void>;
}

/**
 * Save and delete that resolve only after every cached initiative list holds
 * the result. The tickets.changed push refreshes them too, but a screen that
 * opens right after a create must not render the list from before it.
 */
export function useInitiativeActions(serverId: string): InitiativeActions {
  const mutations = useTicketMutations();
  const queryClient = useQueryClient();
  return useMemo(() => {
    async function refetchInitiatives(): Promise<void> {
      await queryClient.invalidateQueries({
        queryKey: initiativesQueryRoot(serverId),
        refetchType: "all",
      });
    }
    return {
      save: async (input) => {
        const initiative = await mutations.saveInitiative(input);
        await refetchInitiatives();
        return initiative;
      },
      remove: async (initiativeId) => {
        await mutations.deleteInitiative({ initiativeId });
        await refetchInitiatives();
      },
    };
  }, [mutations, queryClient, serverId]);
}
