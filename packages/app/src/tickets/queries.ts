import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { DaemonClient, TicketsRequestParams } from "@getpaseo/client/internal/daemon-client";
import type {
  Initiative,
  TicketActivity,
  TicketBoard,
  TicketDetail,
  TicketImportReport,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { ticketsPushRoute } from "@/data/push-router";
import { useFetchQuery } from "@/data/query";
import { applyTicketMove, type TicketMove } from "./ordering";
import {
  initiativesQueryKey,
  ticketBoardsQueryKey,
  ticketDetailQueryKey,
  ticketListQueryKey,
  ticketListQueryRoot,
  type TicketRef,
} from "./query-keys";
import { useTicketsHost } from "./use-tickets-host";

/** The board host answered with `error` set, or with no entity. */
export class TicketsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketsRequestError";
  }
}

export type CreateTicketInput = TicketsRequestParams<"tickets.ticket.create.request">;
export type UpdateTicketInput = TicketsRequestParams<"tickets.ticket.update.request">;
export type DispatchTicketInput = TicketsRequestParams<"tickets.ticket.dispatch.request">;
export type SetLinkInput = TicketsRequestParams<"tickets.link.set.request">;
export type AddCommentInput = TicketsRequestParams<"tickets.comment.add.request">;
export type UpdateCommentInput = TicketsRequestParams<"tickets.comment.update.request">;
export type AddAttachmentInput = TicketsRequestParams<"tickets.attachment.add.request">;
export type SaveInitiativeInput = TicketsRequestParams<"tickets.initiative.save.request">;
export type EnsureBoardInput = TicketsRequestParams<"tickets.board.ensure.request">;
export type UpdateBoardInput = TicketsRequestParams<"tickets.board.update.request">;
export type SaveColumnInput = TicketsRequestParams<"tickets.column.save.request">;
export type DeleteColumnInput = TicketsRequestParams<"tickets.column.delete.request">;

export interface TicketAttachmentContent {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface TicketMutations {
  createTicket(input: CreateTicketInput): Promise<TicketDetail>;
  updateTicket(input: UpdateTicketInput): Promise<TicketDetail>;
  /** Optimistic: every cached list shows the move at once and rolls back on error. */
  moveTicket(input: TicketMove): Promise<TicketSummary>;
  deleteTicket(input: { ticketId: string }): Promise<void>;
  dispatchTicket(input: DispatchTicketInput): Promise<TicketSummary>;
  setLink(input: SetLinkInput): Promise<TicketDetail>;
  addComment(input: AddCommentInput): Promise<TicketActivity>;
  updateComment(input: UpdateCommentInput): Promise<TicketActivity>;
  deleteComment(input: { activityId: string }): Promise<void>;
  addAttachment(input: AddAttachmentInput): Promise<TicketDetail>;
  readAttachment(input: { attachmentId: string }): Promise<TicketAttachmentContent>;
  deleteAttachment(input: { attachmentId: string }): Promise<TicketDetail>;
  saveInitiative(input: SaveInitiativeInput): Promise<Initiative>;
  deleteInitiative(input: { initiativeId: string }): Promise<void>;
  ensureBoard(input: EnsureBoardInput): Promise<TicketBoard>;
  updateBoard(input: UpdateBoardInput): Promise<TicketBoard>;
  saveColumn(input: SaveColumnInput): Promise<TicketBoard>;
  deleteColumn(input: DeleteColumnInput): Promise<TicketBoard>;
  importFromItsaplan(): Promise<TicketImportReport>;
}

export interface TicketBoardsResult {
  boards: readonly TicketBoard[];
  isLoading: boolean;
  error: Error | null;
}

export interface TicketListResult {
  tickets: readonly TicketSummary[];
  isLoading: boolean;
  error: Error | null;
}

export interface TicketDetailResult {
  ticket: TicketDetail | null;
  isLoading: boolean;
  error: Error | null;
}

export interface InitiativesResult {
  initiatives: readonly Initiative[];
  isLoading: boolean;
  error: Error | null;
}

// The tickets.changed push keeps these fresh; the stale time only covers a
// missed push while the screen stays mounted.
const TICKETS_STALE_TIME_MS = 60_000;
const NO_BOARDS: readonly TicketBoard[] = [];
const NO_TICKETS: readonly TicketSummary[] = [];
const NO_INITIATIVES: readonly Initiative[] = [];
// The import copies every board and attachment, so it outlives the default RPC timeout.
const IMPORT_TIMEOUT_MS = 10 * 60_000;

function unwrap<TPayload extends { error: string | null }>(payload: TPayload): TPayload {
  if (payload.error !== null) {
    throw new TicketsRequestError(payload.error);
  }
  return payload;
}

function requireEntity<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new TicketsRequestError(message);
  }
  return value;
}

interface TicketListPayload {
  tickets: TicketSummary[];
  revision: number;
}

export function useTicketBoards(): TicketBoardsResult {
  const { t } = useTranslation();
  const { serverId, client } = useTicketsHost();
  const query = useFetchQuery({
    queryKey: ticketBoardsQueryKey(serverId ?? ""),
    enabled: client !== null,
    meta: ticketsPushRoute({ enabled: client !== null, serverId: serverId ?? "" }),
    dataShape: "list",
    staleTimeMs: TICKETS_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) {
        throw new TicketsRequestError(t("tickets.common.errors.hostUnavailable"));
      }
      const payload = unwrap(await client.ticketsRequest("tickets.board.list.request", {}));
      return payload.boards;
    },
  });
  return { boards: query.data ?? NO_BOARDS, isLoading: query.isLoading, error: query.error };
}

/** `boardId` null lists every board (the all-projects view). */
export function useTicketList(boardId: string | null): TicketListResult {
  const { t } = useTranslation();
  const { serverId, client } = useTicketsHost();
  const query = useFetchQuery({
    queryKey: ticketListQueryKey(serverId ?? "", boardId),
    enabled: client !== null,
    meta: ticketsPushRoute({ enabled: client !== null, serverId: serverId ?? "" }),
    // "value": a list shape would keep the previous board's cards under the
    // next board's columns while the new list loads.
    dataShape: "value",
    staleTimeMs: TICKETS_STALE_TIME_MS,
    queryFn: async (): Promise<TicketListPayload> => {
      if (!client) {
        throw new TicketsRequestError(t("tickets.common.errors.hostUnavailable"));
      }
      const payload = unwrap(
        await client.ticketsRequest("tickets.ticket.list.request", { boardId }),
      );
      return { tickets: payload.tickets, revision: payload.revision };
    },
  });
  return {
    tickets: query.data?.tickets ?? NO_TICKETS,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** `ticket` is null while loading and when no ticket matches the ref. */
export function useTicketDetail(ref: TicketRef | null): TicketDetailResult {
  const { t } = useTranslation();
  const { serverId, client } = useTicketsHost();
  const hasRef = Boolean(ref?.ticketId || ref?.key);
  const query = useFetchQuery({
    queryKey: ticketDetailQueryKey(serverId ?? "", ref),
    enabled: client !== null && hasRef,
    meta: ticketsPushRoute({ enabled: client !== null && hasRef, serverId: serverId ?? "" }),
    dataShape: "value",
    staleTimeMs: TICKETS_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) {
        throw new TicketsRequestError(t("tickets.common.errors.hostUnavailable"));
      }
      const payload = unwrap(
        await client.ticketsRequest("tickets.ticket.get.request", {
          ...(ref?.ticketId ? { ticketId: ref.ticketId } : {}),
          ...(ref?.key ? { key: ref.key } : {}),
        }),
      );
      return payload.ticket;
    },
  });
  return { ticket: query.data ?? null, isLoading: query.isLoading, error: query.error };
}

/** `boardId` null lists the initiatives of every board. */
export function useInitiatives(boardId: string | null): InitiativesResult {
  const { t } = useTranslation();
  const { serverId, client } = useTicketsHost();
  const query = useFetchQuery({
    queryKey: initiativesQueryKey(serverId ?? "", boardId),
    enabled: client !== null,
    meta: ticketsPushRoute({ enabled: client !== null, serverId: serverId ?? "" }),
    dataShape: "value",
    staleTimeMs: TICKETS_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) {
        throw new TicketsRequestError(t("tickets.common.errors.hostUnavailable"));
      }
      const payload = unwrap(
        await client.ticketsRequest("tickets.initiative.list.request", { boardId }),
      );
      return payload.initiatives;
    },
  });
  return {
    initiatives: query.data ?? NO_INITIATIVES,
    isLoading: query.isLoading,
    error: query.error,
  };
}

function replaceTicket(
  payload: TicketListPayload | undefined,
  ticket: TicketSummary,
): TicketListPayload | undefined {
  if (!payload || !payload.tickets.some((candidate) => candidate.id === ticket.id)) {
    return payload;
  }
  return {
    ...payload,
    tickets: payload.tickets.map((candidate) => (candidate.id === ticket.id ? ticket : candidate)),
  };
}

async function moveTicketOptimistically(input: {
  client: DaemonClient;
  queryClient: QueryClient;
  serverId: string;
  move: TicketMove;
  emptyResponseMessage: string;
}): Promise<TicketSummary> {
  const { client, queryClient, move } = input;
  const listRoot = ticketListQueryRoot(input.serverId);
  // An in-flight list fetch started before the move would overwrite it.
  await queryClient.cancelQueries({ queryKey: listRoot });
  const snapshots: [QueryKey, TicketListPayload | undefined][] =
    queryClient.getQueriesData<TicketListPayload>({ queryKey: listRoot });
  queryClient.setQueriesData<TicketListPayload>({ queryKey: listRoot }, (payload) =>
    payload ? { ...payload, tickets: [...applyTicketMove(payload.tickets, move)] } : payload,
  );
  try {
    const payload = unwrap(
      await client.ticketsRequest("tickets.ticket.move.request", {
        ticketId: move.ticketId,
        columnId: move.columnId,
        ...(move.afterTicketId !== undefined ? { afterTicketId: move.afterTicketId } : {}),
      }),
    );
    const ticket = requireEntity(payload.ticket, input.emptyResponseMessage);
    queryClient.setQueriesData<TicketListPayload>({ queryKey: listRoot }, (current) =>
      replaceTicket(current, ticket),
    );
    return ticket;
  } catch (error) {
    for (const [queryKey, payload] of snapshots) {
      queryClient.setQueryData(queryKey, payload);
    }
    throw error;
  }
}

export function useTicketMutations(): TicketMutations {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { serverId, client } = useTicketsHost();

  return useMemo((): TicketMutations => {
    const emptyResponse = t("tickets.common.errors.emptyResponse");
    function requireClient(): DaemonClient {
      if (!client) {
        throw new TicketsRequestError(t("tickets.common.errors.hostUnavailable"));
      }
      return client;
    }

    return {
      async createTicket(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.ticket.create.request", input),
        );
        return requireEntity(payload.ticket, emptyResponse);
      },
      async updateTicket(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.ticket.update.request", input),
        );
        return requireEntity(payload.ticket, emptyResponse);
      },
      async moveTicket(move) {
        return moveTicketOptimistically({
          client: requireClient(),
          queryClient,
          serverId: serverId ?? "",
          move,
          emptyResponseMessage: emptyResponse,
        });
      },
      async deleteTicket(input) {
        unwrap(await requireClient().ticketsRequest("tickets.ticket.delete.request", input));
      },
      async dispatchTicket(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.ticket.dispatch.request", input),
        );
        return requireEntity(payload.ticket, emptyResponse);
      },
      async setLink(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.link.set.request", input),
        );
        return requireEntity(payload.ticket, emptyResponse);
      },
      async addComment(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.comment.add.request", input),
        );
        return requireEntity(payload.activity, emptyResponse);
      },
      async updateComment(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.comment.update.request", input),
        );
        return requireEntity(payload.activity, emptyResponse);
      },
      async deleteComment(input) {
        unwrap(await requireClient().ticketsRequest("tickets.comment.delete.request", input));
      },
      async addAttachment(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.attachment.add.request", input),
        );
        return requireEntity(payload.ticket, emptyResponse);
      },
      async readAttachment(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.attachment.read.request", input),
        );
        return {
          fileName: requireEntity(payload.fileName, emptyResponse),
          mimeType: requireEntity(payload.mimeType, emptyResponse),
          dataBase64: requireEntity(payload.dataBase64, emptyResponse),
        };
      },
      async deleteAttachment(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.attachment.delete.request", input),
        );
        return requireEntity(payload.ticket, emptyResponse);
      },
      async saveInitiative(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.initiative.save.request", input),
        );
        return requireEntity(payload.initiative, emptyResponse);
      },
      async deleteInitiative(input) {
        unwrap(await requireClient().ticketsRequest("tickets.initiative.delete.request", input));
      },
      async ensureBoard(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.board.ensure.request", input),
        );
        return requireEntity(payload.board, emptyResponse);
      },
      async updateBoard(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.board.update.request", input),
        );
        return requireEntity(payload.board, emptyResponse);
      },
      async saveColumn(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.column.save.request", input),
        );
        return requireEntity(payload.board, emptyResponse);
      },
      async deleteColumn(input) {
        const payload = unwrap(
          await requireClient().ticketsRequest("tickets.column.delete.request", input),
        );
        return requireEntity(payload.board, emptyResponse);
      },
      async importFromItsaplan() {
        const payload = unwrap(
          await requireClient().ticketsRequest(
            "tickets.import.itsaplan.request",
            {},
            {
              timeout: IMPORT_TIMEOUT_MS,
            },
          ),
        );
        return requireEntity(payload.report, emptyResponse);
      },
    };
  }, [client, queryClient, serverId, t]);
}
