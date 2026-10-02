import type pino from "pino";
import type {
  TicketActor,
  TicketImportReport,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { TicketsError, type TicketService } from "./service.js";

type TicketsRequest = Extract<SessionInboundMessage, { type: `tickets.${string}.request` }>;
type TicketsRequestFields<T extends TicketsRequest["type"]> = Omit<
  Extract<TicketsRequest, { type: T }>,
  "type" | "requestId"
>;
type BoardRequest = Extract<
  TicketsRequest,
  { type: `tickets.board.${string}` | `tickets.column.${string}` }
>;
type TicketRequest = Extract<
  TicketsRequest,
  { type: `tickets.ticket.${string}` | `tickets.link.${string}` }
>;
type ActivityRequest = Extract<
  TicketsRequest,
  { type: `tickets.comment.${string}` | `tickets.attachment.${string}` }
>;
// Initiatives, the itsaplan import and fleet run reports.
type PlanningRequest = Exclude<TicketsRequest, BoardRequest | TicketRequest | ActivityRequest>;

export type TicketsDispatchInput = TicketsRequestFields<"tickets.ticket.dispatch.request">;
export type TicketsRunReportInput = TicketsRequestFields<"tickets.run.report.request">;

export interface TicketsRunReportResult {
  applied: boolean;
}

/**
 * Requests other slices serve (Commander dispatch, itsaplan import, fleet run
 * reports). Bootstrap fills the slots; sessions read them at call time.
 */
export interface TicketsDelegatedHandlers {
  dispatch?: (input: TicketsDispatchInput) => Promise<TicketSummary>;
  importItsaplan?: () => Promise<TicketImportReport>;
  runReport?: (input: TicketsRunReportInput) => Promise<TicketsRunReportResult>;
}

export interface TicketsHost {
  // Null when node:sqlite is missing.
  service: TicketService | null;
  // This daemon is the designated Commander host.
  isBoardHost(): boolean;
  // Designated Commander host as configured; null = none designated.
  boardHostName(): string | null;
  handlers: TicketsDelegatedHandlers;
}

/** The one rule for `server_info.features.tickets` and for serving tickets.* requests. */
export function isServingTickets(host: TicketsHost | null): boolean {
  return host !== null && host.service !== null && host.isBoardHost();
}

interface ServingHost {
  service: TicketService;
  handlers: TicketsDelegatedHandlers;
}

type Attempt<T> = { value: T; error: null } | { value: null; error: string };

const USER_ACTOR: TicketActor = { kind: "user" };

function isTicketsRequest(message: SessionInboundMessage): message is TicketsRequest {
  return message.type.startsWith("tickets.") && message.type.endsWith(".request");
}

function isBoardRequest(request: TicketsRequest): request is BoardRequest {
  return request.type.startsWith("tickets.board.") || request.type.startsWith("tickets.column.");
}

function isTicketRequest(request: TicketsRequest): request is TicketRequest {
  return request.type.startsWith("tickets.ticket.") || request.type.startsWith("tickets.link.");
}

function isActivityRequest(request: TicketsRequest): request is ActivityRequest {
  return (
    request.type.startsWith("tickets.comment.") || request.type.startsWith("tickets.attachment.")
  );
}

function requireHandler<T>(handler: T | undefined): T {
  if (handler === undefined) {
    throw new TicketsError("invalid", "not available");
  }
  return handler;
}

function unhandled(request: never): never {
  throw new Error(`Unhandled tickets request ${JSON.stringify(request)}`);
}

export interface TicketsSessionOptions {
  emit(message: SessionOutboundMessage): void;
  host: TicketsHost | null;
  logger: pino.Logger;
}

/**
 * Client request surface of native tickets. Only the board host serves it;
 * every other host answers each request with an error naming the board host.
 */
export class TicketsSession {
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly host: TicketsHost | null;
  private readonly logger: pino.Logger;

  constructor(options: TicketsSessionOptions) {
    this.emit = options.emit;
    this.host = options.host;
    this.logger = options.logger;
  }

  /** Claims every tickets.*.request; undefined for any other message. */
  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!isTicketsRequest(message)) {
      return undefined;
    }
    if (isBoardRequest(message)) {
      return this.handleBoardRequest(message);
    }
    if (isTicketRequest(message)) {
      return this.handleTicketRequest(message);
    }
    if (isActivityRequest(message)) {
      return this.handleActivityRequest(message);
    }
    return this.handlePlanningRequest(message);
  }

  private serving(): ServingHost | string {
    if (this.host === null || !this.host.isBoardHost()) {
      const name = this.host?.boardHostName() ?? "none designated";
      return `Tickets live on the Commander host (${name})`;
    }
    if (this.host.service === null) {
      return "Tickets are unavailable on this host: node:sqlite is missing";
    }
    return { service: this.host.service, handlers: this.host.handlers };
  }

  private async attempt<T>(
    request: TicketsRequest,
    work: (serving: ServingHost) => T | Promise<T>,
  ): Promise<Attempt<T>> {
    const serving = this.serving();
    if (typeof serving === "string") {
      return { value: null, error: serving };
    }
    try {
      return { value: await work(serving), error: null };
    } catch (error) {
      // Every request owes its caller a response; a TicketsError is an expected refusal.
      if (!(error instanceof TicketsError)) {
        this.logger.error({ err: error, requestType: request.type }, "Tickets request failed");
      }
      return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleBoardRequest(request: BoardRequest): Promise<void> {
    const requestId = request.requestId;
    switch (request.type) {
      case "tickets.board.list.request": {
        const result = await this.attempt(request, ({ service }) => service.listBoards());
        this.emit({
          type: "tickets.board.list.response",
          payload: { requestId, error: result.error, boards: result.value ?? [] },
        });
        return;
      }
      case "tickets.board.ensure.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.ensureBoard({
            projectKey: request.projectKey,
            name: request.name,
            key: request.key,
          }),
        );
        this.emit({
          type: "tickets.board.ensure.response",
          payload: { requestId, error: result.error, board: result.value },
        });
        return;
      }
      case "tickets.board.update.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.updateBoard(request.boardId, { name: request.name, archived: request.archived }),
        );
        this.emit({
          type: "tickets.board.update.response",
          payload: { requestId, error: result.error, board: result.value },
        });
        return;
      }
      case "tickets.column.save.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.saveColumn({
            boardId: request.boardId,
            columnId: request.columnId,
            name: request.name,
            stateType: request.stateType,
            afterColumnId: request.afterColumnId,
          }),
        );
        this.emit({
          type: "tickets.column.save.response",
          payload: { requestId, error: result.error, board: result.value },
        });
        return;
      }
      case "tickets.column.delete.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.deleteColumn(request.columnId, request.moveTicketsToColumnId),
        );
        this.emit({
          type: "tickets.column.delete.response",
          payload: { requestId, error: result.error, board: result.value },
        });
        return;
      }
      default:
        return unhandled(request);
    }
  }

  private async handleTicketRequest(request: TicketRequest): Promise<void> {
    const requestId = request.requestId;
    switch (request.type) {
      case "tickets.ticket.list.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.listTickets({
            boardId: request.boardId,
            initiativeId: request.initiativeId,
            includeArchived: request.includeArchived,
          }),
        );
        const tickets = result.value?.tickets ?? [];
        const revision = result.value?.revision ?? 0;
        this.emit({
          type: "tickets.ticket.list.response",
          payload: { requestId, error: result.error, tickets, revision },
        });
        return;
      }
      case "tickets.ticket.get.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.getTicket({ ticketId: request.ticketId, key: request.key }),
        );
        this.emit({
          type: "tickets.ticket.get.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      case "tickets.ticket.create.request": {
        const { type: _type, requestId: _requestId, ...input } = request;
        const result = await this.attempt(request, ({ service }) =>
          service.createTicket(input, USER_ACTOR),
        );
        this.emit({
          type: "tickets.ticket.create.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      case "tickets.ticket.update.request": {
        const { type: _type, requestId: _requestId, ticketId, ...patch } = request;
        const result = await this.attempt(request, ({ service }) =>
          service.updateTicket(ticketId, patch, USER_ACTOR),
        );
        this.emit({
          type: "tickets.ticket.update.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      case "tickets.ticket.move.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.moveTicket(request.ticketId, request.columnId, request.afterTicketId, USER_ACTOR),
        );
        this.emit({
          type: "tickets.ticket.move.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      case "tickets.ticket.delete.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.deleteTicket(request.ticketId),
        );
        this.emit({
          type: "tickets.ticket.delete.response",
          payload: { requestId, error: result.error },
        });
        return;
      }
      case "tickets.ticket.dispatch.request": {
        const result = await this.attempt(request, ({ handlers }) =>
          requireHandler(handlers.dispatch)({ ticketId: request.ticketId, note: request.note }),
        );
        this.emit({
          type: "tickets.ticket.dispatch.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      case "tickets.link.set.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.setLink(request.ticketId, request.blockedByTicketId, request.linked, USER_ACTOR),
        );
        this.emit({
          type: "tickets.link.set.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      default:
        return unhandled(request);
    }
  }

  private async handleActivityRequest(request: ActivityRequest): Promise<void> {
    const requestId = request.requestId;
    switch (request.type) {
      case "tickets.comment.add.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.addComment(request.ticketId, request.body, USER_ACTOR, request.replyToId),
        );
        this.emit({
          type: "tickets.comment.add.response",
          payload: { requestId, error: result.error, activity: result.value },
        });
        return;
      }
      case "tickets.comment.update.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.updateComment(request.activityId, request.body),
        );
        this.emit({
          type: "tickets.comment.update.response",
          payload: { requestId, error: result.error, activity: result.value },
        });
        return;
      }
      case "tickets.comment.delete.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.deleteComment(request.activityId),
        );
        this.emit({
          type: "tickets.comment.delete.response",
          payload: { requestId, error: result.error },
        });
        return;
      }
      case "tickets.attachment.add.request": {
        const upload = {
          fileName: request.fileName,
          mimeType: request.mimeType,
          data: Buffer.from(request.dataBase64, "base64"),
        };
        const result = await this.attempt(request, ({ service }) =>
          service.addAttachment(request.ticketId, upload, USER_ACTOR),
        );
        this.emit({
          type: "tickets.attachment.add.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      case "tickets.attachment.read.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.readAttachment(request.attachmentId),
        );
        const content = result.value;
        this.emit({
          type: "tickets.attachment.read.response",
          payload: {
            requestId,
            error: result.error,
            fileName: content ? content.fileName : null,
            mimeType: content ? content.mimeType : null,
            dataBase64: content ? content.data.toString("base64") : null,
          },
        });
        return;
      }
      case "tickets.attachment.delete.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.deleteAttachment(request.attachmentId, USER_ACTOR),
        );
        this.emit({
          type: "tickets.attachment.delete.response",
          payload: { requestId, error: result.error, ticket: result.value },
        });
        return;
      }
      default:
        return unhandled(request);
    }
  }

  private async handlePlanningRequest(request: PlanningRequest): Promise<void> {
    const requestId = request.requestId;
    switch (request.type) {
      case "tickets.initiative.list.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.listInitiatives(request.boardId),
        );
        this.emit({
          type: "tickets.initiative.list.response",
          payload: { requestId, error: result.error, initiatives: result.value ?? [] },
        });
        return;
      }
      case "tickets.initiative.save.request": {
        const { type: _type, requestId: _requestId, ...input } = request;
        const result = await this.attempt(request, ({ service }) => service.saveInitiative(input));
        this.emit({
          type: "tickets.initiative.save.response",
          payload: { requestId, error: result.error, initiative: result.value },
        });
        return;
      }
      case "tickets.initiative.delete.request": {
        const result = await this.attempt(request, ({ service }) =>
          service.deleteInitiative(request.initiativeId),
        );
        this.emit({
          type: "tickets.initiative.delete.response",
          payload: { requestId, error: result.error },
        });
        return;
      }
      case "tickets.import.itsaplan.request": {
        const result = await this.attempt(request, ({ handlers }) =>
          requireHandler(handlers.importItsaplan)(),
        );
        this.emit({
          type: "tickets.import.itsaplan.response",
          payload: { requestId, error: result.error, report: result.value },
        });
        return;
      }
      case "tickets.run.report.request": {
        const { type: _type, requestId: _requestId, ...input } = request;
        const result = await this.attempt(request, ({ handlers }) =>
          requireHandler(handlers.runReport)(input),
        );
        this.emit({
          type: "tickets.run.report.response",
          payload: { requestId, error: result.error, applied: result.value?.applied ?? false },
        });
        return;
      }
      default:
        return unhandled(request);
    }
  }
}
