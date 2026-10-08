import type {
  TicketColumnStateType,
  TicketRun,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import type { BoardLane } from "../board-model";

export const TICKET_STATE_TYPES: readonly TicketColumnStateType[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];

/** How many of the initiative's tickets sit in each column state. */
export function countTicketsByState(
  lanes: readonly BoardLane[],
): Record<TicketColumnStateType, number> {
  const counts: Record<TicketColumnStateType, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    canceled: 0,
  };
  for (const lane of lanes) {
    counts[lane.stateType] += lane.tickets.length;
  }
  return counts;
}

export interface ActiveTicket {
  ticket: TicketSummary;
  run: TicketRun;
}

/**
 * Tickets an agent works on now, or that wait for you. Tickets that need you
 * come first; inside each bucket the most recent run leads.
 */
export function selectActiveWork(tickets: readonly TicketSummary[]): ActiveTicket[] {
  const active: ActiveTicket[] = [];
  for (const ticket of tickets) {
    const run = ticket.latestRun;
    if (!run || run.archived) {
      continue;
    }
    if (run.bucket === "running" || run.bucket === "needs_you") {
      active.push({ ticket, run });
    }
  }
  return active.sort((a, b) => {
    const aRank = a.run.bucket === "needs_you" ? 0 : 1;
    const bRank = b.run.bucket === "needs_you" ? 0 : 1;
    return aRank - bRank || b.run.updatedAt.localeCompare(a.run.updatedAt);
  });
}
