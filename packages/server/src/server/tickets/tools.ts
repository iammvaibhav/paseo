import { z } from "zod";
import type { DaemonClient, TicketsRequestParams } from "@getpaseo/client/internal/daemon-client";
import {
  TicketAssigneeSchema,
  type TicketActivity,
  type TicketActor,
  type TicketBoard,
  type TicketColumn,
  type TicketDetail,
  type TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { ensureValidJson } from "../json-utils.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { TicketService } from "./service.js";
import type { TicketsDispatchInput } from "./session.js";

// The Commander's ticket tools. They read and write the board without the
// approval gate: each write is visible on the board and can be undone there.

export type TicketCreateParams = TicketsRequestParams<"tickets.ticket.create.request">;
export type TicketUpdateParams = TicketsRequestParams<"tickets.ticket.update.request">;
export type TicketMoveParams = TicketsRequestParams<"tickets.ticket.move.request">;
export type TicketCommentParams = TicketsRequestParams<"tickets.comment.add.request">;

/** The board as the Commander tools see it. Every write acts as the Commander. */
export interface TicketToolsBackend {
  listBoards(): Promise<TicketBoard[]>;
  /** Null = every board. */
  listTickets(boardId: string | null): Promise<TicketSummary[]>;
  getTicketByKey(key: string): Promise<TicketDetail | null>;
  createTicket(params: TicketCreateParams): Promise<TicketDetail>;
  updateTicket(params: TicketUpdateParams): Promise<TicketDetail>;
  moveTicket(params: TicketMoveParams): Promise<TicketSummary>;
  addComment(params: TicketCommentParams): Promise<TicketActivity>;
  dispatch(input: TicketsDispatchInput): Promise<TicketSummary>;
}

const COMMANDER_ACTOR: TicketActor = { kind: "commander" };

export interface LocalTicketToolsBackendOptions {
  service: TicketService;
  dispatch: (input: TicketsDispatchInput) => Promise<TicketSummary>;
}

/** The board host: straight to the ticket service. */
export function createLocalTicketToolsBackend(
  options: LocalTicketToolsBackendOptions,
): TicketToolsBackend {
  const { service } = options;
  return {
    async listBoards() {
      return service.listBoards();
    },
    async listTickets(boardId) {
      return service.listTickets({ boardId }).tickets;
    },
    async getTicketByKey(key) {
      return service.getTicket({ key });
    },
    async createTicket(params) {
      return service.createTicket(params, COMMANDER_ACTOR);
    },
    async updateTicket({ ticketId, ...patch }) {
      return service.updateTicket(ticketId, patch, COMMANDER_ACTOR);
    },
    async moveTicket({ ticketId, columnId, afterTicketId }) {
      return service.moveTicket(ticketId, columnId, afterTicketId, COMMANDER_ACTOR);
    },
    async addComment({ ticketId, body, replyToId }) {
      return service.addComment(ticketId, body, COMMANDER_ACTOR, replyToId);
    },
    dispatch: options.dispatch,
  };
}

export class TicketsPeerRequestError extends Error {
  readonly requestType: string;

  constructor(requestType: string, message: string) {
    super(message);
    this.name = "TicketsPeerRequestError";
    this.requestType = requestType;
  }
}

interface TicketsPayload {
  error: string | null;
}

function unwrap<T extends TicketsPayload>(requestType: string, payload: T): T {
  if (payload.error !== null) {
    throw new TicketsPeerRequestError(requestType, payload.error);
  }
  return payload;
}

function requireResult<T>(requestType: string, value: T | null): T {
  if (value === null) {
    throw new TicketsPeerRequestError(requestType, `${requestType} returned no result`);
  }
  return value;
}

/**
 * Any other host: through the board-host peer connection. The board host
 * attributes these writes to the peer session, not to the Commander.
 */
export function createPeerTicketToolsBackend(getClient: () => DaemonClient): TicketToolsBackend {
  return {
    async listBoards() {
      const type = "tickets.board.list.request";
      return unwrap(type, await getClient().ticketsRequest(type, {})).boards;
    },
    async listTickets(boardId) {
      const type = "tickets.ticket.list.request";
      return unwrap(type, await getClient().ticketsRequest(type, { boardId })).tickets;
    },
    async getTicketByKey(key) {
      const type = "tickets.ticket.get.request";
      return unwrap(type, await getClient().ticketsRequest(type, { key })).ticket;
    },
    async createTicket(params) {
      const type = "tickets.ticket.create.request";
      const payload = unwrap(type, await getClient().ticketsRequest(type, params));
      return requireResult(type, payload.ticket);
    },
    async updateTicket(params) {
      const type = "tickets.ticket.update.request";
      const payload = unwrap(type, await getClient().ticketsRequest(type, params));
      return requireResult(type, payload.ticket);
    },
    async moveTicket(params) {
      const type = "tickets.ticket.move.request";
      const payload = unwrap(type, await getClient().ticketsRequest(type, params));
      return requireResult(type, payload.ticket);
    },
    async addComment(params) {
      const type = "tickets.comment.add.request";
      const payload = unwrap(type, await getClient().ticketsRequest(type, params));
      return requireResult(type, payload.activity);
    },
    async dispatch(input) {
      const type = "tickets.ticket.dispatch.request";
      const payload = unwrap(type, await getClient().ticketsRequest(type, input));
      return requireResult(type, payload.ticket);
    },
  };
}

export class TicketToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketToolInputError";
  }
}

type TicketToolHandler = (
  input: unknown,
  context: PaseoToolExecutionContext,
) => Promise<PaseoToolResult>;

export interface RegisterTicketToolsOptions {
  registerTool: (name: string, config: PaseoToolConfig, handler: TicketToolHandler) => void;
  /** Resolved per call: the board host can change while the Commander runs. */
  resolveBackend: () => TicketToolsBackend;
}

const LIST_LIMIT = 100;
const RECENT_ACTIVITY_LIMIT = 30;

const TicketKeySchema = z
  .string()
  .trim()
  .min(1)
  .transform((key) => key.toUpperCase())
  .describe('Ticket key from ticket_list / ticket_get data, e.g. "PASEO-12".');

const ColumnNameSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Column name as ticket_list shows it, e.g. "Todo". Case-insensitive.');

const TicketListInputSchema = z.object({
  boardId: z
    .string()
    .optional()
    .describe("Board id from a prior ticket_list result. Omit for every board."),
  query: z.string().trim().optional().describe("Case-insensitive filter on ticket key and title."),
});

const TicketGetInputSchema = z.object({ key: TicketKeySchema });

const TicketCreateInputSchema = z.object({
  boardKey: z.string().trim().min(1).optional().describe('Board key, e.g. "PASEO".'),
  boardId: z.string().optional().describe("Board id from a prior ticket_list result."),
  title: z.string().trim().min(1),
  description: z.string().optional().describe("Markdown."),
  column: ColumnNameSchema.optional(),
  assignee: TicketAssigneeSchema.optional(),
  parentKey: TicketKeySchema.optional(),
  blockedBy: z
    .array(TicketKeySchema)
    .optional()
    .describe("Keys of the tickets that block this one."),
});

const TicketUpdateInputSchema = z.object({
  key: TicketKeySchema,
  title: z.string().trim().min(1).optional(),
  description: z.string().optional().describe("Markdown; replaces the whole description."),
  assignee: TicketAssigneeSchema.nullable().optional(),
  initiativeId: z.string().nullable().optional(),
});

const TicketMoveInputSchema = z.object({ key: TicketKeySchema, column: ColumnNameSchema });

const TicketCommentInputSchema = z.object({
  key: TicketKeySchema,
  body: z.string().trim().min(1).describe("Markdown."),
});

const TicketDispatchInputSchema = z.object({
  key: TicketKeySchema,
  note: z.string().trim().min(1).optional().describe("Extra instruction for the brief."),
});

interface BoardRef {
  boardId?: string;
  boardKey?: string;
}

function toolResult(data: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(data) };
}

interface BoardIndex {
  boards: TicketBoard[];
  boardsById: Map<string, TicketBoard>;
  columnsById: Map<string, TicketColumn>;
}

function indexBoards(boards: TicketBoard[]): BoardIndex {
  const boardsById = new Map<string, TicketBoard>();
  const columnsById = new Map<string, TicketColumn>();
  for (const board of boards) {
    boardsById.set(board.id, board);
    for (const column of board.columns) {
      columnsById.set(column.id, column);
    }
  }
  return { boards, boardsById, columnsById };
}

function describeTicket(ticket: TicketSummary, index: BoardIndex) {
  let subtasks: string | null = null;
  if (ticket.subtaskCount > 0) {
    subtasks = `${ticket.subtaskDoneCount}/${ticket.subtaskCount} done`;
  }
  return {
    key: ticket.key,
    title: ticket.title,
    board: index.boardsById.get(ticket.boardId)?.key ?? null,
    column: index.columnsById.get(ticket.columnId)?.name ?? null,
    assignee: ticket.assignee,
    priority: ticket.priority,
    openBlockerCount: ticket.openBlockerCount,
    subtasks,
    latestRun: ticket.latestRun,
    updatedAt: ticket.updatedAt,
  };
}

function describeBoard(board: TicketBoard) {
  return {
    id: board.id,
    key: board.key,
    name: board.name,
    projectKey: board.projectKey,
    columns: board.columns.map((column) => `${column.name} (${column.stateType})`),
  };
}

function findColumnByName(board: TicketBoard, name: string): TicketColumn {
  const wanted = name.toLowerCase();
  const column = board.columns.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (column === undefined) {
    const valid = board.columns.map((candidate) => candidate.name).join(", ");
    throw new TicketToolInputError(
      `Board ${board.key} has no column "${name}". Valid columns: ${valid}`,
    );
  }
  return column;
}

function resolveBoard(boards: TicketBoard[], ref: BoardRef): TicketBoard {
  const boardKey = ref.boardKey?.toUpperCase();
  const board = boards.find(
    (candidate) => candidate.id === ref.boardId || candidate.key === boardKey,
  );
  if (board === undefined) {
    const valid = boards.map((candidate) => `${candidate.key} (${candidate.id})`).join(", ");
    throw new TicketToolInputError(`No such board. Valid boards: ${valid || "none"}`);
  }
  return board;
}

async function requireTicket(backend: TicketToolsBackend, key: string): Promise<TicketDetail> {
  const ticket = await backend.getTicketByKey(key);
  if (ticket === null) {
    throw new TicketToolInputError(`Ticket ${key} not found`);
  }
  return ticket;
}

export function registerTicketTools(options: RegisterTicketToolsOptions): void {
  const { registerTool, resolveBackend } = options;

  registerTool(
    "ticket_list",
    {
      title: "List tickets",
      description:
        "List native tickets with board, column, assignee, open blockers and latest run, plus every board with its " +
        `columns. Filter by boardId (from a prior result) and/or query (matches key and title). At most ${LIST_LIMIT} tickets; ` +
        "total counts every match. Read-only; never approval-gated.",
      inputSchema: TicketListInputSchema.shape,
    },
    async (raw) => {
      const input = TicketListInputSchema.parse(raw);
      const backend = resolveBackend();
      const index = indexBoards(await backend.listBoards());
      if (input.boardId !== undefined) {
        resolveBoard(index.boards, { boardId: input.boardId });
      }
      const tickets = await backend.listTickets(input.boardId ?? null);
      const needle = input.query?.toLowerCase() ?? "";
      const matches = tickets.filter(
        (ticket) =>
          ticket.key.toLowerCase().includes(needle) || ticket.title.toLowerCase().includes(needle),
      );
      return toolResult({
        ok: true,
        boards: index.boards.map(describeBoard),
        total: matches.length,
        tickets: matches.slice(0, LIST_LIMIT).map((ticket) => describeTicket(ticket, index)),
      });
    },
  );

  registerTool(
    "ticket_get",
    {
      title: "Read a ticket",
      description:
        "Read one ticket by key: description, column, assignee, blockers, sub-tasks, attachments, linked runs " +
        `(agentId + serverId for deep links) and the ${RECENT_ACTIVITY_LIMIT} latest comments and events. Read-only; never approval-gated.`,
      inputSchema: TicketGetInputSchema.shape,
    },
    async (raw) => {
      const input = TicketGetInputSchema.parse(raw);
      const backend = resolveBackend();
      const [ticket, boards] = await Promise.all([
        requireTicket(backend, input.key),
        backend.listBoards(),
      ]);
      const index = indexBoards(boards);
      const describeAll = (list: TicketSummary[]) =>
        list.map((item) => describeTicket(item, index));
      return toolResult({
        ok: true,
        ticket: {
          ...describeTicket(ticket, index),
          description: ticket.description,
          initiativeId: ticket.initiativeId,
          dueDate: ticket.dueDate,
          blockedBy: describeAll(ticket.blockedBy),
          blocks: describeAll(ticket.blocks),
          subtasks: describeAll(ticket.subtasks),
          attachments: ticket.attachments.map((attachment) => ({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            size: attachment.size,
          })),
          runs: ticket.runs,
          activity: ticket.activity.slice(-RECENT_ACTIVITY_LIMIT).map((entry) => ({
            kind: entry.kind,
            actor: entry.actor,
            body: entry.body,
            eventType: entry.eventType,
            from: entry.from,
            to: entry.to,
            createdAt: entry.createdAt,
          })),
        },
      });
    },
  );

  registerTool(
    "ticket_create",
    {
      title: "Create a ticket",
      description:
        "Create a ticket on a board (boardKey or boardId from ticket_list). column is a column name (default: the board's " +
        'backlog). assignee "commander" marks it as your work; parentKey makes it a sub-task; blockedBy lists blocker keys. ' +
        "Tickets you create never dispatch by themselves: call ticket_dispatch to start one. Never approval-gated.",
      inputSchema: TicketCreateInputSchema.shape,
    },
    async (raw) => {
      const { boardKey, boardId, column, parentKey, blockedBy, ...fields } =
        TicketCreateInputSchema.parse(raw);
      const backend = resolveBackend();
      const board = resolveBoard(await backend.listBoards(), { boardKey, boardId });
      const params: TicketCreateParams = { ...fields, boardId: board.id };
      if (column !== undefined) {
        params.columnId = findColumnByName(board, column).id;
      }
      if (parentKey !== undefined) {
        params.parentId = (await requireTicket(backend, parentKey)).id;
      }
      if (blockedBy !== undefined) {
        const blockers = await Promise.all(blockedBy.map((key) => requireTicket(backend, key)));
        params.blockedByTicketIds = blockers.map((blocker) => blocker.id);
      }
      const ticket = await backend.createTicket(params);
      return toolResult({ ok: true, ticket: describeTicket(ticket, indexBoards([board])) });
    },
  );

  registerTool(
    "ticket_update",
    {
      title: "Update a ticket",
      description:
        'Change a ticket\'s title, description, assignee ("user", "commander", or null to clear) or initiativeId ' +
        "(null to clear). Omitted fields stay as they are. Never approval-gated.",
      inputSchema: TicketUpdateInputSchema.shape,
    },
    async (raw) => {
      const { key, ...patch } = TicketUpdateInputSchema.parse(raw);
      const backend = resolveBackend();
      const current = await requireTicket(backend, key);
      const ticket = await backend.updateTicket({ ...patch, ticketId: current.id });
      const index = indexBoards(await backend.listBoards());
      return toolResult({ ok: true, ticket: describeTicket(ticket, index) });
    },
  );

  registerTool(
    "ticket_move",
    {
      title: "Move a ticket",
      description:
        "Move a ticket to another column of its board by column name (to the bottom of that column). " +
        "Your moves never trigger board automation. Never approval-gated.",
      inputSchema: TicketMoveInputSchema.shape,
    },
    async (raw) => {
      const input = TicketMoveInputSchema.parse(raw);
      const backend = resolveBackend();
      const [ticket, boards] = await Promise.all([
        requireTicket(backend, input.key),
        backend.listBoards(),
      ]);
      const board = resolveBoard(boards, { boardId: ticket.boardId });
      const target = findColumnByName(board, input.column);
      const moved = await backend.moveTicket({ ticketId: ticket.id, columnId: target.id });
      return toolResult({ ok: true, ticket: describeTicket(moved, indexBoards([board])) });
    },
  );

  registerTool(
    "ticket_comment",
    {
      title: "Comment on a ticket",
      description:
        "Post a markdown comment on a ticket as the Commander — the way to answer a ticket comment that mentions " +
        "@commander. Never approval-gated.",
      inputSchema: TicketCommentInputSchema.shape,
    },
    async (raw) => {
      const input = TicketCommentInputSchema.parse(raw);
      const backend = resolveBackend();
      const ticket = await requireTicket(backend, input.key);
      const activity = await backend.addComment({ ticketId: ticket.id, body: input.body });
      return toolResult({ ok: true, key: ticket.key, commentId: activity.id });
    },
  );

  registerTool(
    "ticket_dispatch",
    {
      title: "Dispatch a ticket",
      description:
        "Start work on a ticket now, whatever its assignee: the daemon sends you the ticket's dispatch brief " +
        "(description, initiative, attachments, worker label) as a machinery turn; spawn the worker from that brief. " +
        "note is added to the brief. Never approval-gated.",
      inputSchema: TicketDispatchInputSchema.shape,
    },
    async (raw) => {
      const { key, ...rest } = TicketDispatchInputSchema.parse(raw);
      const backend = resolveBackend();
      const ticket = await requireTicket(backend, key);
      await backend.dispatch({ ...rest, ticketId: ticket.id });
      return toolResult({ ok: true, key: ticket.key, dispatched: true });
    },
  );
}
