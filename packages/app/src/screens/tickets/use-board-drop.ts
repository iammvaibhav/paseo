import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "@getpaseo/protocol/tickets/types";
import { useToast } from "@/contexts/toast-context";
import { useTicketMutations } from "@/tickets/queries";
import type { BoardDropTarget } from "./board-drag-state";
import { resolveDrop, type BoardLane } from "./board-model";

export type BoardDropHandler = (ticketId: string, target: BoardDropTarget) => void;

/**
 * Applies a card drop: resolves the real column and neighbour, runs the
 * optimistic move, and reports a refused or failed move in a toast.
 */
export function useBoardDrop(input: {
  lanes: readonly BoardLane[];
  ticketById: ReadonlyMap<string, TicketSummary>;
  /** Board names for the all-projects view, where a lane can lack a board's column. */
  boardNameById: ReadonlyMap<string, string> | null;
}): BoardDropHandler {
  const { lanes, ticketById, boardNameById } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const { moveTicket } = useTicketMutations();

  return useCallback(
    (ticketId: string, target: BoardDropTarget) => {
      const ticket = ticketById.get(ticketId);
      const lane = lanes.find((candidate) => candidate.key === target.laneKey);
      if (!ticket || !lane) {
        return;
      }
      const resolution = resolveDrop({ lane, ticket, target });
      if (resolution.kind === "no_column") {
        const boardName = boardNameById?.get(resolution.boardId) ?? resolution.boardId;
        toast.error(t("tickets.board.noMatchingColumn", { board: boardName, column: lane.name }));
        return;
      }
      if (resolution.kind === "unchanged") {
        return;
      }
      moveTicket(resolution.move).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(t("tickets.board.moveFailed", { key: ticket.key, message }));
      });
    },
    [boardNameById, lanes, moveTicket, t, ticketById, toast],
  );
}
