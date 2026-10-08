/** `board` is a board id or "all"; `ticket` is a ticket key such as "PASEO-45". */
export interface TicketsRouteOptions {
  board?: string;
  ticket?: string;
}

export const ALL_BOARDS_PARAM = "all";

export function buildTicketsRoute(options?: TicketsRouteOptions) {
  const params = new URLSearchParams();
  if (options?.board) {
    params.set("board", options.board);
  }
  if (options?.ticket) {
    params.set("ticket", options.ticket);
  }
  const query = params.toString();
  return query ? (`/tickets?${query}` as const) : ("/tickets" as const);
}

export function buildTicketInitiativesRoute() {
  return "/tickets/initiatives" as const;
}

export function buildTicketInitiativeRoute(initiativeId: string) {
  return `/tickets/initiatives/${encodeURIComponent(initiativeId)}` as const;
}
