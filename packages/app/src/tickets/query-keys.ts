// Kept free of React and runtime imports: the push router (loaded by the host
// runtime) needs the root key without an import cycle back into the runtime.

const ALL_BOARDS_KEY = "all";

export interface TicketRef {
  ticketId?: string;
  key?: string;
}

/** Every tickets query of one host lives under this root. */
export function ticketsQueryRoot(serverId: string) {
  return ["tickets", serverId] as const;
}

export function ticketBoardsQueryKey(serverId: string) {
  return [...ticketsQueryRoot(serverId), "boards"] as const;
}

export function ticketListQueryRoot(serverId: string) {
  return [...ticketsQueryRoot(serverId), "list"] as const;
}

export function ticketListQueryKey(serverId: string, boardId: string | null) {
  return [...ticketListQueryRoot(serverId), boardId ?? ALL_BOARDS_KEY] as const;
}

export function ticketDetailQueryKey(serverId: string, ref: TicketRef | null) {
  return [
    ...ticketsQueryRoot(serverId),
    "detail",
    ref?.ticketId ?? null,
    ref?.key ?? null,
  ] as const;
}

export function initiativesQueryRoot(serverId: string) {
  return [...ticketsQueryRoot(serverId), "initiatives"] as const;
}

export function initiativesQueryKey(serverId: string, boardId: string | null) {
  return [...initiativesQueryRoot(serverId), boardId ?? ALL_BOARDS_KEY] as const;
}
