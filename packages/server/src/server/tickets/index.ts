import path from "node:path";
import type { Logger } from "pino";
import { TicketService } from "./service.js";
import { TicketStore } from "./store.js";

export interface TicketsRuntime {
  store: TicketStore;
  service: TicketService;
}

export interface OpenTicketsInput {
  paseoHome: string;
  logger: Logger;
}

/** Opens `$PASEO_HOME/tickets`. Null when node:sqlite is missing: the feature is off. */
export async function openTickets(input: OpenTicketsInput): Promise<TicketsRuntime | null> {
  const store = await TicketStore.open({
    directory: path.join(input.paseoHome, "tickets"),
    logger: input.logger,
  });
  return store ? { store, service: new TicketService({ store, logger: input.logger }) } : null;
}

export {
  MAX_ATTACHMENT_BYTES,
  TicketService,
  TicketsError,
  type TicketsChange,
  type TicketMovedEvent,
  type TicketCommentAddedEvent,
  type TicketCreatedEvent,
  type UpsertRunInput,
  type UpsertRunResult,
} from "./service.js";
export { TicketStore, newId } from "./store.js";
export {
  TicketsSession,
  isServingTickets,
  type TicketsDelegatedHandlers,
  type TicketsDispatchInput,
  type TicketsHost,
  type TicketsRunReportInput,
  type TicketsRunReportResult,
} from "./session.js";
