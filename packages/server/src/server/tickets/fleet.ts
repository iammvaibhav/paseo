import type { Logger } from "pino";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type {
  MissionControlEvent,
  MissionControlLifecycleAction,
} from "@getpaseo/protocol/mission-control/types";
import {
  TicketSummarySchema,
  type Initiative,
  type TicketActor,
  type TicketAttachment,
  type TicketBoard,
  type TicketColumn,
  type TicketColumnStateType,
  type TicketDetail,
  type TicketRun,
  type TicketRunBucket,
  type TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import type { AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { getItsaplanIssueIdFromLabels } from "../itsaplan/bridge.js";
import {
  isRasterImageContentType,
  MAX_TICKET_IMAGE_BYTES,
  type TicketNativeImage,
} from "../itsaplan/ticket-images.js";
import type { PeerManager } from "../peers/peer-manager.js";
import { TicketsError, type TicketService, type UpsertRunResult } from "./service.js";
import type {
  TicketsDispatchInput,
  TicketsRunReportInput,
  TicketsRunReportResult,
} from "./session.js";
import {
  createLocalTicketToolsBackend,
  createPeerTicketToolsBackend,
  type TicketToolsBackend,
} from "./tools.js";

// Native tickets across the fleet. Every host projects the lifecycle of its
// own ticket-linked agents to the board host (TicketRunProjector). The board
// host applies each run to the board and runs the Commander automation
// (TicketAutomation).

/** Agent label that links an agent to the native ticket it works on. */
export const TICKET_ID_LABEL_KEY = "paseo.ticket-id";

/** The started column a finished run waits in until the user closes the ticket. */
export const READY_TO_REVIEW_COLUMN_NAME = "Ready to review";

const RUN_REPORT_DEBOUNCE_MS = 500;

const STATE_TYPE_RANK: Record<TicketColumnStateType, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 3,
};

// "@commander" as a word of its own: not part of an e-mail address, a path or
// a longer handle.
const COMMANDER_MENTION_PATTERN = /(?:^|[^\w@./-])@commander(?![\w-])/i;

export interface TicketLink {
  ticketId: string | null;
  itsaplanIssueId: number | null;
}

/** The ticket an agent works on, from its labels. Null when it has no link. */
export function readTicketLink(labels: Readonly<Record<string, string>>): TicketLink | null {
  const ticketId = labels[TICKET_ID_LABEL_KEY]?.trim() || null;
  const issueId = getItsaplanIssueIdFromLabels(labels);
  const itsaplanIssueId = issueId === null ? null : Number(issueId);
  if (ticketId === null && itsaplanIssueId === null) {
    return null;
  }
  return { ticketId, itsaplanIssueId };
}

export function isClosedColumn(column: TicketColumn): boolean {
  return column.stateType === "completed" || column.stateType === "canceled";
}

export function isReadyToReviewColumn(column: TicketColumn): boolean {
  return column.stateType === "started" && column.name === READY_TO_REVIEW_COLUMN_NAME;
}

function byPosition(a: TicketColumn, b: TicketColumn): number {
  return a.position - b.position;
}

/** The first started column that is not Ready to review. */
export function findInProgressColumn(columns: readonly TicketColumn[]): TicketColumn | null {
  const ordered = [...columns].sort(byPosition);
  return (
    ordered.find((column) => column.stateType === "started" && !isReadyToReviewColumn(column)) ??
    null
  );
}

export function findReadyToReviewColumn(columns: readonly TicketColumn[]): TicketColumn | null {
  return [...columns].sort(byPosition).find(isReadyToReviewColumn) ?? null;
}

/**
 * Board progress order: the state type first, then Ready to review after the
 * other started columns, then the board position. A user can put Ready to
 * review anywhere on the board; the run lifecycle must not follow that order
 * backwards.
 */
function compareProgress(a: TicketColumn, b: TicketColumn): number {
  const rankDelta = STATE_TYPE_RANK[a.stateType] - STATE_TYPE_RANK[b.stateType];
  if (rankDelta !== 0) {
    return rankDelta;
  }
  const reviewDelta = Number(isReadyToReviewColumn(a)) - Number(isReadyToReviewColumn(b));
  if (reviewDelta !== 0) {
    return reviewDelta;
  }
  return a.position - b.position;
}

/** Runs move tickets forward only, and never out of a closed column. */
export function isForwardMove(from: TicketColumn, to: TicketColumn): boolean {
  return !isClosedColumn(from) && compareProgress(to, from) > 0;
}

export type RunColumnPlan =
  | { kind: "stay" }
  | { kind: "move"; column: TicketColumn }
  | { kind: "create_ready_column"; afterColumnId: string | null };

export interface RunColumnPlanInput {
  bucket: TicketRunBucket;
  current: TicketColumn;
  columns: readonly TicketColumn[];
}

const STAY: RunColumnPlan = { kind: "stay" };

/** Where a run in `bucket` puts its ticket. */
export function planRunColumnMove(input: RunColumnPlanInput): RunColumnPlan {
  const { bucket, current, columns } = input;
  if (isClosedColumn(current)) {
    return STAY;
  }
  if (bucket === "running" || bucket === "needs_you") {
    const inProgress = findInProgressColumn(columns);
    if (inProgress === null || !isForwardMove(current, inProgress)) {
      return STAY;
    }
    return { kind: "move", column: inProgress };
  }
  if (bucket === "ready" || bucket === "done") {
    const ready = findReadyToReviewColumn(columns);
    if (ready === null) {
      return { kind: "create_ready_column", afterColumnId: readyColumnAnchorId(columns) };
    }
    if (!isForwardMove(current, ready)) {
      return STAY;
    }
    return { kind: "move", column: ready };
  }
  return STAY;
}

/** A missing Ready to review column goes after In Progress, else after the last open column. */
function readyColumnAnchorId(columns: readonly TicketColumn[]): string | null {
  const inProgress = findInProgressColumn(columns);
  if (inProgress !== null) {
    return inProgress.id;
  }
  const open = [...columns].sort(byPosition).filter((column) => !isClosedColumn(column));
  return open.at(-1)?.id ?? null;
}

/** A run that still works on its ticket, or waits for its review. */
export function isActiveRun(run: TicketRun): boolean {
  return !run.archived && run.bucket !== "done";
}

export type AutoDispatchCandidate = Pick<
  TicketDetail,
  "assignee" | "openBlockerCount" | "archivedAt" | "runs"
>;

/**
 * The Commander starts a ticket by itself only when the ticket waits in an
 * unstarted column, is assigned to the Commander, has no open blocker and no
 * active run.
 */
export function isReadyForAutoDispatch(
  ticket: AutoDispatchCandidate,
  column: TicketColumn,
): boolean {
  const isWaitingToStart = column.stateType === "unstarted";
  const isCommanderWork = ticket.assignee === "commander";
  const isUnblocked = ticket.openBlockerCount === 0;
  const isLive = ticket.archivedAt === null;
  const hasActiveRun = ticket.runs.some(isActiveRun);
  return isWaitingToStart && isCommanderWork && isUnblocked && isLive && !hasActiveRun;
}

export function mentionsCommander(body: string): boolean {
  return COMMANDER_MENTION_PATTERN.test(body);
}

export type TicketDispatchTrigger = "todo" | "released" | "requested";

const DISPATCH_HEADLINES: Record<TicketDispatchTrigger, string> = {
  todo: "Ticket moved to Todo with zero open blockers — ready to dispatch.",
  released: "Ticket released: its last open blocker closed — ready to dispatch.",
  requested: "Ticket dispatch requested — start it now.",
};

export interface TicketDispatchBrief {
  ticket: Pick<TicketDetail, "id" | "key" | "title" | "description">;
  board: Pick<TicketBoard, "key" | "name" | "projectKey">;
  initiative: Pick<Initiative, "title" | "description"> | null;
  nativeImageCount: number;
  files: readonly Pick<TicketAttachment, "fileName" | "mimeType">[];
  trigger: TicketDispatchTrigger;
  note: string | null;
}

export function buildTicketDispatchPrompt(brief: TicketDispatchBrief): string {
  const { ticket, board, initiative } = brief;
  const lines: string[] = [
    DISPATCH_HEADLINES[brief.trigger],
    `Board: ${board.name} (${board.key})`,
    `Project: ${board.projectKey ?? "none"}`,
    `Ticket: ${ticket.key} — ${ticket.title}`,
  ];
  if (initiative !== null) {
    lines.push(`Initiative: ${initiative.title}`);
    const initiativeDescription = initiative.description.trim();
    if (initiativeDescription.length > 0) {
      lines.push(`Initiative description: ${initiativeDescription}`);
    }
  }

  const description = ticket.description.trim();
  lines.push("", description.length > 0 ? description : "(no description)");

  if (brief.nativeImageCount > 0) {
    const noun = brief.nativeImageCount === 1 ? "image" : "images";
    lines.push(
      "",
      `${brief.nativeImageCount} ${noun} attached natively (same as composer paste).`,
      "Pass them through fleet_create_agent images when spinning the worker.",
    );
  }
  if (brief.files.length > 0) {
    lines.push("", "File attachments (kept on the board host):");
    for (const file of brief.files) {
      lines.push(`- ${file.fileName} (${file.mimeType})`);
    }
  }
  const note = brief.note?.trim() ?? "";
  if (note.length > 0) {
    lines.push("", `Dispatch note: ${note}`);
  }

  lines.push(
    "",
    "<instructions>",
    `Dispatch one worker for this ticket. Label the new agent "${TICKET_ID_LABEL_KEY}": "${ticket.id}" so the board records the run and moves the ticket as the agent's state changes. Start the agent title with the ticket key ("${ticket.key} - <brief>").`,
    "</instructions>",
  );
  return lines.join("\n");
}

export interface CommanderMentionBrief {
  ticket: Pick<TicketSummary, "key" | "title">;
  board: Pick<TicketBoard, "key" | "name">;
  comment: string;
}

export function buildCommanderMentionPrompt(brief: CommanderMentionBrief): string {
  const { ticket, board } = brief;
  return [
    "A ticket comment mentions @commander.",
    `Board: ${board.name} (${board.key})`,
    `Ticket: ${ticket.key} — ${ticket.title}`,
    "",
    "Comment:",
    brief.comment.trim(),
    "",
    "<instructions>",
    `Answer on the ticket with ticket_comment({ key: "${ticket.key}", body: "<answer>" }). Read the ticket first with ticket_get({ key: "${ticket.key}" }) when you need more context. When the comment asks for work, act with ticket_update, ticket_move or ticket_dispatch.`,
    "</instructions>",
  ].join("\n");
}

export interface TicketRunProjectorAgentManager {
  subscribe(
    callback: (event: AgentManagerEvent) => void,
    options?: { replayState?: boolean },
  ): () => void;
  getAgent(agentId: string): Pick<ManagedAgent, "labels" | "name"> | null;
}

export interface TicketRunProjectorAgentStorage {
  get(
    agentId: string,
  ): Promise<Pick<StoredAgentRecord, "labels" | "title" | "name" | "archivedAt"> | null>;
  list(): Promise<Pick<StoredAgentRecord, "id" | "labels" | "archivedAt">[]>;
}

export interface TicketRunProjectorMissionControl {
  subscribeSelfReports(listener: (event: MissionControlEvent) => void): () => void;
  subscribeReviewState(listener: (agentId: string) => void): () => void;
  getLifecycleBucket(agentId: string): Promise<LifecycleBucket>;
}

export interface TicketRunProjectorOptions {
  logger: Logger;
  serverId: string;
  agentManager: TicketRunProjectorAgentManager;
  agentStorage: TicketRunProjectorAgentStorage;
  missionControl: TicketRunProjectorMissionControl;
  /** Delivers one report to the board host. Throws when delivery fails. */
  send: (report: TicketsRunReportInput) => Promise<void>;
}

/**
 * Observes the local agents that are linked to a ticket — the same signals
 * the itsaplan bridge projects (agent state, self reports, review state) —
 * and sends their current run state to the board host. Reports are debounced
 * per agent and carry the state read at send time, so a burst coalesces into
 * the latest state. Never throws into the agent path.
 */
export class TicketRunProjector {
  private readonly logger: Logger;
  private readonly serverId: string;
  private readonly agentManager: TicketRunProjectorAgentManager;
  private readonly agentStorage: TicketRunProjectorAgentStorage;
  private readonly missionControl: TicketRunProjectorMissionControl;
  private readonly send: (report: TicketsRunReportInput) => Promise<void>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly flushes = new Map<string, Promise<void>>();
  // Each distinct state is attempted once; a resync sends it again.
  private readonly lastAttempted = new Map<string, string>();
  private readonly forced = new Set<string>();
  private unsubscribers: Array<() => void> = [];

  constructor(options: TicketRunProjectorOptions) {
    this.logger = options.logger.child({ module: "tickets", component: "run-projector" });
    this.serverId = options.serverId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.missionControl = options.missionControl;
    this.send = options.send;
  }

  start(): void {
    // replayState:false — the boot resync below owns catch-up for agents
    // that existed before the projector started.
    this.unsubscribers = [
      this.agentManager.subscribe((event) => this.handleAgentEvent(event), {
        replayState: false,
      }),
      this.missionControl.subscribeSelfReports((event) => this.scheduleIfLinked(event.agentId)),
      this.missionControl.subscribeReviewState((agentId) => this.scheduleIfLinked(agentId)),
    ];
    void this.resync();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Sends every linked, unarchived local agent again (boot, board host back online). */
  async resync(): Promise<void> {
    try {
      const records = await this.agentStorage.list();
      for (const record of records) {
        if (record.archivedAt || readTicketLink(record.labels) === null) {
          continue;
        }
        this.forced.add(record.id);
        this.schedule(record.id);
      }
    } catch (error) {
      this.logger.warn({ err: error }, "tickets.run_projector.resync_failed");
    }
  }

  private handleAgentEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_state" || readTicketLink(event.agent.labels) === null) {
      return;
    }
    this.schedule(event.agent.id);
  }

  private scheduleIfLinked(agentId: string): void {
    const live = this.agentManager.getAgent(agentId);
    // A stored-only agent is checked against its stored labels at flush time.
    if (live !== null && readTicketLink(live.labels) === null) {
      return;
    }
    this.schedule(agentId);
  }

  private schedule(agentId: string): void {
    clearTimeout(this.timers.get(agentId));
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      this.enqueueFlush(agentId);
    }, RUN_REPORT_DEBOUNCE_MS);
    timer.unref();
    this.timers.set(agentId, timer);
  }

  // One flush per agent at a time, so the board host sees its reports in order.
  private enqueueFlush(agentId: string): void {
    const previous = this.flushes.get(agentId) ?? Promise.resolve();
    const next = previous.then(() => this.flush(agentId));
    this.flushes.set(agentId, next);
    void next.finally(() => {
      if (this.flushes.get(agentId) === next) {
        this.flushes.delete(agentId);
      }
    });
  }

  private async flush(agentId: string): Promise<void> {
    const isForced = this.forced.delete(agentId);
    let report: TicketsRunReportInput | null = null;
    try {
      report = await this.buildReport(agentId);
      if (report === null) {
        return;
      }
      const signature = JSON.stringify([
        report.ticketId,
        report.itsaplanIssueId,
        report.bucket,
        report.agentTitle,
        report.agentName,
        report.archived,
      ]);
      if (!isForced && this.lastAttempted.get(agentId) === signature) {
        return;
      }
      this.lastAttempted.set(agentId, signature);
      await this.send(report);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          agentId,
          ticketId: report?.ticketId ?? null,
          itsaplanIssueId: report?.itsaplanIssueId ?? null,
        },
        "tickets.run_projector.report_failed",
      );
    }
  }

  private async buildReport(agentId: string): Promise<TicketsRunReportInput | null> {
    const record = await this.agentStorage.get(agentId);
    const live = this.agentManager.getAgent(agentId);
    const labels = live?.labels ?? record?.labels;
    if (labels === undefined) {
      return null;
    }
    const link = readTicketLink(labels);
    if (link === null) {
      return null;
    }
    const bucket = await this.missionControl.getLifecycleBucket(agentId);
    return {
      serverId: this.serverId,
      agentId,
      ticketId: link.ticketId,
      itsaplanIssueId: link.itsaplanIssueId,
      bucket,
      agentTitle: record?.title ?? null,
      agentName: live?.name ?? record?.name ?? null,
      archived: Boolean(record?.archivedAt),
      observedAt: new Date().toISOString(),
    };
  }
}

export type TicketAutomationService = Pick<
  TicketService,
  | "listBoards"
  | "listInitiatives"
  | "getTicket"
  | "getColumn"
  | "listColumns"
  | "saveColumn"
  | "moveTicket"
  | "upsertRun"
  | "findTicketIdByExternalId"
  | "readAttachment"
  | "onTicketMoved"
  | "onTicketCreated"
  | "onCommentAdded"
>;

export interface LifecycleSetInput {
  agentId: string;
  action: MissionControlLifecycleAction;
}

export type LifecycleSetResult = { ok: true } | { ok: false; error: string };

export interface TicketAutomationMissionControl {
  setLifecycle(input: LifecycleSetInput): Promise<LifecycleSetResult>;
}

export interface MachineryPrompt {
  prompt: string;
  images: TicketNativeImage[];
}

/** Delivers a machinery prompt to the Commander. False when no Commander exists. */
export type DeliverMachineryPrompt = (input: MachineryPrompt) => Promise<boolean>;

export interface TicketAutomationOptions {
  logger: Logger;
  service: TicketAutomationService;
  missionControl: TicketAutomationMissionControl;
  deliverMachineryPrompt: DeliverMachineryPrompt;
}

export type TicketDispatchErrorReason = "not_found" | "no_commander";

const DISPATCH_ERROR_MESSAGES: Record<TicketDispatchErrorReason, (ticketRef: string) => string> = {
  not_found: (ticketRef) => `Ticket ${ticketRef} not found`,
  no_commander: (ticketRef) => `No Commander is available to dispatch ${ticketRef}`,
};

export class TicketDispatchError extends Error {
  readonly ticketRef: string;
  readonly reason: TicketDispatchErrorReason;

  constructor(ticketRef: string, reason: TicketDispatchErrorReason) {
    super(DISPATCH_ERROR_MESSAGES[reason](ticketRef));
    this.name = "TicketDispatchError";
    this.ticketRef = ticketRef;
    this.reason = reason;
  }
}

interface DispatchOptions {
  trigger: TicketDispatchTrigger;
  note: string | null;
}

interface PromptAttachments {
  images: TicketNativeImage[];
  files: TicketAttachment[];
}

function runActor(report: TicketsRunReportInput): TicketActor {
  if (report.agentName === null) {
    return { kind: "agent", agentId: report.agentId, serverId: report.serverId };
  }
  return {
    kind: "agent",
    agentId: report.agentId,
    serverId: report.serverId,
    name: report.agentName,
  };
}

/**
 * Board-host rules on top of the ticket store: run reports move tickets, and
 * user actions on the board wake the Commander. Automation reacts only to
 * user actions — never to its own, the Commander's or an agent's — so no
 * action can loop back into itself.
 */
export class TicketAutomation {
  private readonly logger: Logger;
  private readonly service: TicketAutomationService;
  private readonly missionControl: TicketAutomationMissionControl;
  private readonly deliverMachineryPrompt: DeliverMachineryPrompt;
  // Run reports apply one at a time: two reports for one board must not both
  // create the Ready to review column.
  private reportQueue: Promise<unknown> = Promise.resolve();
  private unsubscribers: Array<() => void> = [];

  constructor(options: TicketAutomationOptions) {
    this.logger = options.logger.child({ module: "tickets", component: "automation" });
    this.service = options.service;
    this.missionControl = options.missionControl;
    this.deliverMachineryPrompt = options.deliverMachineryPrompt;
  }

  start(): void {
    this.unsubscribers = [
      this.service.onTicketMoved((event) => {
        if (event.actor.kind !== "user") {
          return;
        }
        this.runInBackground("ticket_moved", event.ticket, () =>
          this.afterUserMove(event.ticket.id, event.to),
        );
      }),
      this.service.onTicketCreated((event) => {
        if (event.actor.kind !== "user") {
          return;
        }
        this.runInBackground("ticket_created", event.ticket, () =>
          this.dispatchIfReady(event.ticket.id, "todo"),
        );
      }),
      this.service.onCommentAdded((event) => {
        const body = event.activity.body;
        if (event.activity.actor.kind !== "user" || body === null || !mentionsCommander(body)) {
          return;
        }
        this.runInBackground("commander_mention", event.ticket, () =>
          this.deliverMention(event.ticket, body),
        );
      }),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  /** tickets.run.report.request: record the run and move the ticket forward. */
  reportRun(report: TicketsRunReportInput): Promise<TicketsRunReportResult> {
    const result = this.reportQueue.then(() => this.applyRunReport(report));
    this.reportQueue = result.catch(() => undefined);
    return result;
  }

  /** tickets.ticket.dispatch.request: brief the Commander now, whatever the assignee. */
  async dispatch(input: TicketsDispatchInput): Promise<TicketSummary> {
    const ticket = this.service.getTicket({ ticketId: input.ticketId });
    if (ticket === null) {
      throw new TicketDispatchError(input.ticketId, "not_found");
    }
    const delivered = await this.deliverDispatch(ticket, {
      trigger: "requested",
      note: input.note ?? null,
    });
    if (!delivered) {
      throw new TicketDispatchError(ticket.key, "no_commander");
    }
    return TicketSummarySchema.parse(ticket);
  }

  private applyRunReport(report: TicketsRunReportInput): TicketsRunReportResult {
    const ticketId = this.resolveTicketId(report);
    if (ticketId === null) {
      return { applied: false };
    }
    let upsert: UpsertRunResult;
    try {
      upsert = this.service.upsertRun({
        ticketId,
        agentId: report.agentId,
        serverId: report.serverId,
        bucket: report.bucket,
        agentTitle: report.agentTitle,
        agentName: report.agentName,
        archived: report.archived,
        observedAt: report.observedAt,
      });
    } catch (error) {
      // The agent outlived its ticket: nothing to record.
      if (error instanceof TicketsError && error.code === "not_found") {
        return { applied: false };
      }
      throw error;
    }
    if (!upsert.changed) {
      return { applied: false };
    }
    // The column follows bucket transitions only: a ticket the user drags
    // elsewhere stays there until the run changes state again.
    const isBucketTransition = upsert.previousBucket !== report.bucket;
    if (!report.archived && isBucketTransition) {
      this.moveForRun(upsert.ticket, report);
    }
    return { applied: true };
  }

  private resolveTicketId(report: TicketsRunReportInput): string | null {
    if (report.ticketId !== null) {
      return report.ticketId;
    }
    if (report.itsaplanIssueId !== null) {
      return this.service.findTicketIdByExternalId("itsaplan", report.itsaplanIssueId);
    }
    return null;
  }

  private moveForRun(ticket: TicketSummary, report: TicketsRunReportInput): void {
    const current = this.service.getColumn(ticket.columnId);
    if (current === null) {
      return;
    }
    const columns = this.service.listColumns(ticket.boardId);
    const plan = planRunColumnMove({ bucket: report.bucket, current, columns });
    const target = this.resolvePlannedColumn(plan, ticket.boardId);
    if (target === null) {
      return;
    }
    this.service.moveTicket(ticket.id, target.id, undefined, runActor(report));
  }

  private resolvePlannedColumn(plan: RunColumnPlan, boardId: string): TicketColumn | null {
    if (plan.kind === "stay") {
      return null;
    }
    if (plan.kind === "move") {
      return plan.column;
    }
    const board = this.service.saveColumn({
      boardId,
      name: READY_TO_REVIEW_COLUMN_NAME,
      stateType: "started",
      afterColumnId: plan.afterColumnId,
    });
    return findReadyToReviewColumn(board.columns);
  }

  private runInBackground(action: string, ticket: TicketSummary, work: () => Promise<void>): void {
    void work().catch((error: unknown) => {
      this.logger.warn(
        { err: error, action, ticketId: ticket.id, key: ticket.key },
        "tickets.automation.failed",
      );
    });
  }

  private async afterUserMove(ticketId: string, to: TicketColumn): Promise<void> {
    if (to.stateType === "unstarted") {
      await this.dispatchIfReady(ticketId, "todo");
      return;
    }
    if (to.stateType === "completed") {
      await this.markRunsDone(ticketId);
    }
    if (isClosedColumn(to)) {
      await this.releaseDependents(ticketId);
    }
  }

  private async dispatchIfReady(ticketId: string, trigger: TicketDispatchTrigger): Promise<void> {
    const ticket = this.service.getTicket({ ticketId });
    if (ticket === null) {
      return;
    }
    const column = this.service.getColumn(ticket.columnId);
    if (column === null || !isReadyForAutoDispatch(ticket, column)) {
      return;
    }
    const delivered = await this.deliverDispatch(ticket, { trigger, note: null });
    if (!delivered) {
      this.logger.warn(
        { ticketId, key: ticket.key, trigger },
        "tickets.automation.no_commander_to_dispatch",
      );
    }
  }

  private async markRunsDone(ticketId: string): Promise<void> {
    const ticket = this.service.getTicket({ ticketId });
    if (ticket === null) {
      return;
    }
    for (const run of ticket.runs.filter(isActiveRun)) {
      const result = await this.missionControl.setLifecycle({
        agentId: run.agentId,
        action: "done",
      });
      if (!result.ok) {
        this.logger.warn(
          {
            ticketId,
            key: ticket.key,
            agentId: run.agentId,
            serverId: run.serverId,
            error: result.error,
          },
          "tickets.automation.mark_run_done_failed",
        );
      }
    }
  }

  private async releaseDependents(ticketId: string): Promise<void> {
    const ticket = this.service.getTicket({ ticketId });
    if (ticket === null) {
      return;
    }
    for (const dependent of ticket.blocks) {
      await this.dispatchIfReady(dependent.id, "released");
    }
  }

  private async deliverMention(ticket: TicketSummary, comment: string): Promise<void> {
    const board = this.requireBoard(ticket);
    const delivered = await this.deliverMachineryPrompt({
      prompt: buildCommanderMentionPrompt({ ticket, board, comment }),
      images: [],
    });
    if (!delivered) {
      this.logger.warn(
        { ticketId: ticket.id, key: ticket.key },
        "tickets.automation.no_commander_for_mention",
      );
    }
  }

  private async deliverDispatch(ticket: TicketDetail, options: DispatchOptions): Promise<boolean> {
    const board = this.requireBoard(ticket);
    const initiative = this.findInitiative(ticket);
    const attachments = await this.loadPromptAttachments(ticket);
    const prompt = buildTicketDispatchPrompt({
      ticket,
      board,
      initiative,
      nativeImageCount: attachments.images.length,
      files: attachments.files,
      trigger: options.trigger,
      note: options.note,
    });
    return this.deliverMachineryPrompt({ prompt, images: attachments.images });
  }

  private requireBoard(ticket: TicketSummary): TicketBoard {
    const board = this.service.listBoards().find((candidate) => candidate.id === ticket.boardId);
    if (board === undefined) {
      throw new TicketDispatchError(ticket.key, "not_found");
    }
    return board;
  }

  private findInitiative(ticket: TicketSummary): Initiative | null {
    if (ticket.initiativeId === null) {
      return null;
    }
    const initiatives = this.service.listInitiatives(ticket.boardId);
    return initiatives.find((candidate) => candidate.id === ticket.initiativeId) ?? null;
  }

  // Raster images go to the Commander natively (the composer-paste shape);
  // every other file is only named in the brief.
  private async loadPromptAttachments(ticket: TicketDetail): Promise<PromptAttachments> {
    const images: TicketNativeImage[] = [];
    const files: TicketAttachment[] = [];
    for (const attachment of ticket.attachments) {
      const image = await this.readNativeImage(attachment);
      if (image === null) {
        files.push(attachment);
      } else {
        images.push(image);
      }
    }
    return { images, files };
  }

  private async readNativeImage(attachment: TicketAttachment): Promise<TicketNativeImage | null> {
    const isNativeImage =
      isRasterImageContentType(attachment.mimeType) && attachment.size <= MAX_TICKET_IMAGE_BYTES;
    if (!isNativeImage) {
      return null;
    }
    try {
      const content = await this.service.readAttachment(attachment.id);
      if (content === null) {
        return null;
      }
      return { data: content.data.toString("base64"), mimeType: content.mimeType };
    } catch (error) {
      // An unreadable image stays a named file, so the dispatch still goes out.
      this.logger.warn(
        { err: error, ticketId: attachment.ticketId, attachmentId: attachment.id },
        "tickets.automation.image_read_failed",
      );
      return null;
    }
  }
}

export type TicketFleetPeerManager = Pick<
  PeerManager,
  "getPeerStatuses" | "getPeerStatus" | "getPeerClient" | "resolvePeerName"
>;

export interface TicketFleetOptions {
  logger: Logger;
  serverId: string;
  agentManager: TicketRunProjectorAgentManager;
  agentStorage: TicketRunProjectorAgentStorage;
  missionControl: TicketRunProjectorMissionControl & TicketAutomationMissionControl;
  /** Null when node:sqlite is missing: this host then never is the board host. */
  service: TicketService | null;
  isBoardHost: () => boolean;
  /** The designated Commander host from central config; null when none is designated. */
  boardHostName: () => string | null;
  peerManager: TicketFleetPeerManager;
  deliverMachineryPrompt: DeliverMachineryPrompt;
}

export interface TicketFleet {
  /** Board-host handler for tickets.run.report.request. */
  reportRun(report: TicketsRunReportInput): Promise<TicketsRunReportResult>;
  /** Board-host handler for tickets.ticket.dispatch.request. */
  dispatch(input: TicketsDispatchInput): Promise<TicketSummary>;
  /** The board as the Commander tools see it: local on the board host, else through the board-host peer. */
  resolveToolsBackend(): TicketToolsBackend;
  stop(): void;
}

export class TicketBoardHostUnavailableError extends Error {
  readonly boardHostName: string | null;

  constructor(boardHostName: string | null) {
    let message = "Tickets are off: no Commander host is designated";
    if (boardHostName !== null) {
      message = `Tickets live on the Commander host (${boardHostName}), which is not reachable`;
    }
    super(message);
    this.name = "TicketBoardHostUnavailableError";
    this.boardHostName = boardHostName;
  }
}

/**
 * Starts the fleet side of native tickets on this host: the run projector
 * (every host), the board automation (when this host has a ticket store) and
 * the backend of the Commander ticket tools.
 */
export function startTicketFleet(options: TicketFleetOptions): TicketFleet {
  const { logger, peerManager, service } = options;
  let automation: TicketAutomation | null = null;
  let localTools: TicketToolsBackend | null = null;
  if (service !== null) {
    const boardAutomation = new TicketAutomation({
      logger,
      service,
      missionControl: options.missionControl,
      deliverMachineryPrompt: options.deliverMachineryPrompt,
    });
    automation = boardAutomation;
    localTools = createLocalTicketToolsBackend({
      service,
      dispatch: (input) => boardAutomation.dispatch(input),
    });
  }
  const peerTools = createPeerTicketToolsBackend(resolveBoardHostClient);

  function resolveBoardHostPeerName(): string | null {
    const name = options.boardHostName();
    if (name === null) {
      return null;
    }
    return peerManager.resolvePeerName(name);
  }

  function resolveBoardHostClient(): DaemonClient {
    const peerName = resolveBoardHostPeerName();
    if (peerName !== null && peerManager.getPeerStatus(peerName)?.state === "online") {
      const client = peerManager.getPeerClient(peerName);
      if (client !== null) {
        return client;
      }
    }
    throw new TicketBoardHostUnavailableError(options.boardHostName());
  }

  function requireBoardAutomation(): TicketAutomation {
    if (automation === null || !options.isBoardHost()) {
      throw new TicketBoardHostUnavailableError(options.boardHostName());
    }
    return automation;
  }

  async function sendRunReport(report: TicketsRunReportInput): Promise<void> {
    if (automation !== null && options.isBoardHost()) {
      await automation.reportRun(report);
      return;
    }
    let client: DaemonClient;
    try {
      client = resolveBoardHostClient();
    } catch (error) {
      // Expected while the board host is offline: its online transition
      // triggers a resync of every linked agent.
      if (error instanceof TicketBoardHostUnavailableError) {
        return;
      }
      throw error;
    }
    const payload = await client.ticketsRequest("tickets.run.report.request", report);
    if (payload.error !== null) {
      throw new Error(payload.error);
    }
  }

  const projector = new TicketRunProjector({
    logger,
    serverId: options.serverId,
    agentManager: options.agentManager,
    agentStorage: options.agentStorage,
    missionControl: options.missionControl,
    send: sendRunReport,
  });

  // Resync when the board-host peer (re)connects. The peer set is fixed at
  // daemon start; the board-host designation is read at event time.
  const connectedPeers = new Set<string>();
  const unsubscribePeers = peerManager.getPeerStatuses().map((status) => {
    const client = peerManager.getPeerClient(status.name);
    if (client === null) {
      return () => undefined;
    }
    return client.subscribeConnectionStatus((state) => {
      if (state.status !== "connected") {
        connectedPeers.delete(status.name);
        return;
      }
      if (connectedPeers.has(status.name)) {
        return;
      }
      connectedPeers.add(status.name);
      if (resolveBoardHostPeerName() === status.name) {
        void projector.resync();
      }
    });
  });

  automation?.start();
  projector.start();

  return {
    reportRun: (report) => requireBoardAutomation().reportRun(report),
    dispatch: (input) => requireBoardAutomation().dispatch(input),
    resolveToolsBackend() {
      if (localTools !== null && options.isBoardHost()) {
        return localTools;
      }
      return peerTools;
    },
    stop() {
      projector.stop();
      automation?.stop();
      for (const unsubscribe of unsubscribePeers) {
        unsubscribe();
      }
    },
  };
}
