import { rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import {
  InitiativeStatusSchema,
  TicketPrioritySchema,
  type TicketActor,
  type TicketAssignee,
  type TicketImportReport,
} from "@getpaseo/protocol/tickets/types";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { getItsaplanIssueIdFromLabels } from "../itsaplan/bridge.js";
import {
  ItsaplanApiError,
  ItsaplanClient,
  type ItsaplanAttachment,
  type ItsaplanFeedItem,
  type ItsaplanInitiativeRecord,
  type ItsaplanIssueLink,
  type ItsaplanIssueRecord,
  type ItsaplanProjectListItem,
  type ItsaplanProjectSetup,
} from "../itsaplan/client.js";
import type { ItsaplanCentralConfig, ItsaplanProjectStore } from "../itsaplan/projects.js";
import type { SqliteDatabase } from "../search/sqlite.js";
import { MAX_ATTACHMENT_BYTES, type TicketService } from "./service.js";
import { newId, num, text, textOrNull, type TicketStore, type TicketsIdPrefix } from "./store.js";

// Read-only copy of an itsaplan server into the native tickets store. Every
// imported row keeps its itsaplan id in (external_system, external_id), so a
// second run updates rows in place and creates nothing twice.

const MAX_CONCURRENT_REQUESTS = 2;
const MAX_REPORTED_ERRORS = 100;
// The username ensureCommanderAiAgent gives the Commander bot when central
// config names none.
const DEFAULT_COMMANDER_USERNAME = "commander";

export interface ItsaplanImportRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

const DEFAULT_RETRY_POLICY: ItsaplanImportRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 6,
};

export type ItsaplanImportAgentRecord = Pick<
  StoredAgentRecord,
  "id" | "labels" | "title" | "name" | "archivedAt" | "createdAt" | "updatedAt"
>;

export interface ItsaplanTicketImporterOptions {
  ticketStore: TicketStore;
  ticketService: Pick<TicketService, "publishChange">;
  getConfig: () => ItsaplanCentralConfig | null;
  projectStore: Pick<ItsaplanProjectStore, "getByItsaplanProjectId">;
  agentStorage: { list(): Promise<ItsaplanImportAgentRecord[]> };
  missionControl: { getLifecycleBucket(agentId: string): Promise<LifecycleBucket> };
  // This daemon's server id: the host of every agent in agentStorage.
  serverId: string;
  logger: Logger;
  retry?: Partial<ItsaplanImportRetryPolicy>;
}

/** The itsaplan users that map onto a native assignee or actor. */
export interface ItsaplanImportUsers {
  humanUserId: string | null;
  commanderUserIds: ReadonlySet<string>;
}

/**
 * Ticket key and sequence of an itsaplan issue. The key is the itsaplan
 * identifier ("PASEO-45"), so links and agent labels that name it keep
 * working; the sequence is the issue's own number, which the identifier ends
 * with even when the project key has a hyphen ("PASEO-A1B2-7").
 */
export function itsaplanTicketKey(
  issue: Pick<ItsaplanIssueRecord, "identifier" | "sequenceNumber">,
  projectKey: string,
): { key: string; sequence: number } {
  const identifier = issue.identifier?.trim();
  return {
    key: identifier || `${projectKey}-${issue.sequenceNumber}`,
    sequence: issue.sequenceNumber,
  };
}

export function mapItsaplanAssignee(
  userId: string | null | undefined,
  users: ItsaplanImportUsers,
): TicketAssignee | null {
  if (!userId) {
    return null;
  }
  if (userId === users.humanUserId) {
    return "user";
  }
  return users.commanderUserIds.has(userId) ? "commander" : null;
}

export function mapItsaplanCommentActor(
  item: Pick<ItsaplanFeedItem, "actorUserId" | "actorName">,
  users: ItsaplanImportUsers,
): TicketActor {
  if (item.actorUserId && users.commanderUserIds.has(item.actorUserId)) {
    return { kind: "commander" };
  }
  return { kind: "imported", name: item.actorName?.trim() || "Unknown" };
}

/**
 * Native blocker links from itsaplan relations. The source of an itsaplan
 * "blocks" row blocks its target, so the target is the ticket that is
 * blocked by the source. Other relation kinds have no native equivalent.
 */
export function itsaplanBlockerLinks(
  links: readonly ItsaplanIssueLink[],
): Array<{ issueId: number; blockedByIssueId: number }> {
  const seen = new Set<string>();
  const result: Array<{ issueId: number; blockedByIssueId: number }> = [];
  for (const link of links) {
    if (link.kind !== "blocks" || link.sourceIssueId === link.targetIssueId) {
      continue;
    }
    const pair = `${link.targetIssueId}:${link.sourceIssueId}`;
    if (seen.has(pair)) {
      continue;
    }
    seen.add(pair);
    result.push({ issueId: link.targetIssueId, blockedByIssueId: link.sourceIssueId });
  }
  return result;
}

/**
 * Copies the itsaplan server named in central config into the tickets store.
 * Reads only; never writes to itsaplan. A call while an import runs joins it:
 * two concurrent runs would download the same new attachments twice.
 */
export class ItsaplanTicketImporter {
  private readonly options: ItsaplanTicketImporterOptions;
  private inFlight: Promise<TicketImportReport> | null = null;

  constructor(options: ItsaplanTicketImporterOptions) {
    this.options = options;
  }

  run(): Promise<TicketImportReport> {
    if (!this.inFlight) {
      this.inFlight = this.runOnce().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runOnce(): Promise<TicketImportReport> {
    const config = this.options.getConfig();
    if (!config) {
      throw new Error("itsaplan is not configured (central config `itsaplan` is empty)");
    }
    const report = await new ImportRun(this.options, config).execute();
    this.options.logger.info(
      { ...report, errors: report.errors.length },
      "tickets.import_itsaplan.finished",
    );
    return report;
  }
}

type SqlValue = string | number | null;
type ExternalTable = "initiatives" | "tickets" | "activity" | "attachments";
type UpsertOutcome = "created" | "updated" | "unchanged";

interface ImportTally {
  counts: Omit<TicketImportReport, "errors">;
  errors: string[];
  boardIds: Set<string>;
  ticketIds: Set<string>;
  initiativeIds: Set<string>;
}

function emptyTally(): ImportTally {
  return {
    counts: {
      boards: 0,
      tickets: 0,
      comments: 0,
      attachments: 0,
      initiatives: 0,
      links: 0,
      runs: 0,
      updated: 0,
    },
    errors: [],
    boardIds: new Set(),
    ticketIds: new Set(),
    initiativeIds: new Set(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameValue(stored: unknown, next: SqlValue): boolean {
  return stored === next || (typeof stored === "bigint" && Number(stored) === next);
}

function findIdByExternalId(
  db: SqliteDatabase,
  table: ExternalTable,
  externalId: number | string,
): string | null {
  const row = db
    .prepare(`SELECT id FROM ${table} WHERE external_system = 'itsaplan' AND external_id = ?`)
    .get(externalId);
  return row ? text(row, "id") : null;
}

/**
 * Inserts or updates the row that carries one itsaplan id. `fields` are
 * written on insert and compared (then written when different) on update;
 * `insertOnly` fields are written on insert only.
 */
function upsertByExternalId(
  db: SqliteDatabase,
  input: {
    table: ExternalTable;
    prefix: TicketsIdPrefix;
    externalId: number | string;
    fields: Record<string, SqlValue>;
    insertOnly?: Record<string, SqlValue>;
    newRowId?: string;
  },
): { id: string; outcome: UpsertOutcome } {
  const columns = Object.keys(input.fields);
  const existing = db
    .prepare(
      `SELECT id, ${columns.join(", ")} FROM ${input.table} WHERE external_system = 'itsaplan' AND external_id = ?`,
    )
    .get(input.externalId);
  if (existing) {
    const id = text(existing, "id");
    const changed = columns.filter((column) => !sameValue(existing[column], input.fields[column]));
    if (changed.length === 0) {
      return { id, outcome: "unchanged" };
    }
    db.prepare(
      `UPDATE ${input.table} SET ${changed.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
    ).run(...changed.map((column) => input.fields[column]), id);
    return { id, outcome: "updated" };
  }
  const id = input.newRowId ?? newId(input.prefix);
  const values = { ...input.fields, ...input.insertOnly };
  const insertColumns = Object.keys(values);
  db.prepare(
    `INSERT INTO ${input.table} (id, external_system, external_id, ${insertColumns.join(", ")}) VALUES (?, 'itsaplan', ?, ${insertColumns.map(() => "?").join(", ")})`,
  ).run(id, input.externalId, ...insertColumns.map((column) => values[column]));
  return { id, outcome: "created" };
}

interface ProjectSnapshot {
  project: ItsaplanProjectListItem;
  setup: ItsaplanProjectSetup;
  // Active and archived issues of the project.
  issues: ItsaplanIssueRecord[];
  initiatives: ItsaplanInitiativeRecord[];
  links: ItsaplanIssueLink[];
  comments: Map<number, ItsaplanFeedItem[]>;
  attachments: Map<number, ItsaplanAttachment[]>;
}

interface DownloadedAttachment {
  id: string;
  mimeType: string;
  size: number;
}

class ImportRun {
  private readonly options: ItsaplanTicketImporterOptions;
  private readonly config: ItsaplanCentralConfig;
  private readonly client: ItsaplanClient;
  private readonly retry: ItsaplanImportRetryPolicy;
  private readonly total = emptyTally();
  private readonly now = new Date().toISOString();
  private activeRequests = 0;
  private readonly waitingRequests: Array<() => void> = [];
  private knownAttachmentIds: Set<string> | null = null;

  constructor(options: ItsaplanTicketImporterOptions, config: ItsaplanCentralConfig) {
    this.options = options;
    this.config = config;
    this.client = new ItsaplanClient(config);
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  }

  async execute(): Promise<TicketImportReport> {
    const projects = await this.fetch("list projects", () => this.client.listProjects());
    for (const project of projects ?? []) {
      await this.importProject(project);
    }
    await this.importRuns();
    this.publishChange();
    return this.buildReport();
  }

  // --- HTTP: at most MAX_CONCURRENT_REQUESTS in flight, backoff on 429/5xx.

  private async acquireRequestSlot(): Promise<void> {
    if (this.activeRequests < MAX_CONCURRENT_REQUESTS) {
      this.activeRequests += 1;
      return;
    }
    // releaseRequestSlot gives its slot directly to the next waiter.
    await new Promise<void>((resolve) => this.waitingRequests.push(resolve));
  }

  private releaseRequestSlot(): void {
    const next = this.waitingRequests.shift();
    if (next) {
      next();
    } else {
      this.activeRequests -= 1;
    }
  }

  /** Null when the request failed for good; the failure is in the report. */
  private async fetch<T>(label: string, request: () => Promise<T>): Promise<T | null> {
    await this.acquireRequestSlot();
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await request();
        } catch (error) {
          const transient =
            error instanceof ItsaplanApiError && (error.status === 429 || error.status >= 500);
          if (!transient || attempt >= this.retry.maxAttempts) {
            this.total.errors.push(`${label}: ${errorMessage(error)}`);
            return null;
          }
          await delay(Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs));
        }
      }
    } finally {
      this.releaseRequestSlot();
    }
  }

  // --- One itsaplan project → one board.

  private async importProject(project: ItsaplanProjectListItem): Promise<void> {
    const snapshot = await this.fetchProject(project);
    if (!snapshot) {
      return;
    }
    const downloads = await this.downloadAttachments(snapshot);
    const mapping = this.options.projectStore.getByItsaplanProjectId(project.id);
    const commanderUsername = this.config.commanderUsername?.trim() || DEFAULT_COMMANDER_USERNAME;
    const commanderUserIds = new Set(
      snapshot.setup.assignees
        .filter((user) => user.kind === "agent" && user.username === commanderUsername)
        .map((user) => user.userId),
    );
    if (mapping?.commanderUserId) {
      commanderUserIds.add(mapping.commanderUserId);
    }
    const tally = emptyTally();
    try {
      this.options.ticketStore.withTransaction((db) =>
        new ProjectWriter(db, tally, {
          snapshot,
          paseoProjectKey: mapping?.paseoProjectKey ?? null,
          users: { humanUserId: this.config.humanUserId ?? null, commanderUserIds },
          downloads,
          knownAttachmentIds: this.knownAttachmentIds ?? new Set(),
          now: this.now,
        }).write(),
      );
    } catch (error) {
      // Rolled back: the files of the new attachments have no row.
      await Promise.all(
        Array.from(downloads.values(), (download) =>
          rm(this.options.ticketStore.attachmentPath(download.id), { force: true }),
        ),
      );
      this.total.errors.push(`project ${project.key}: ${errorMessage(error)}`);
      return;
    }
    this.merge(tally);
  }

  private async fetchProject(project: ItsaplanProjectListItem): Promise<ProjectSnapshot | null> {
    const key = project.key;
    const [setup, board, archived, initiatives] = await Promise.all([
      this.fetch(`project ${key}: columns`, () => this.client.getProjectSetup(key)),
      this.fetch(`project ${key}: issues`, () => this.client.listBoardIssues(key)),
      this.fetch(`project ${key}: archived issues`, () => this.client.listArchivedIssues(key)),
      this.fetchInitiatives(key),
    ]);
    if (!setup || !board || !archived) {
      return null;
    }
    const issues = [...board.issues, ...archived];
    if (issues.length === 0 && initiatives.length === 0) {
      return null;
    }
    const links = [...board.links];
    const comments = new Map<number, ItsaplanFeedItem[]>();
    const attachments = new Map<number, ItsaplanAttachment[]>();
    await Promise.all([
      // The board payload leaves out every relation with an archived end.
      ...archived.map(async (issue) => {
        const issueLinks = await this.fetch(`${issue.identifier ?? issue.id}: links`, () =>
          this.client.listIssueLinks(issue.id),
        );
        links.push(...(issueLinks ?? []));
      }),
      ...issues.map(async (issue) => {
        comments.set(issue.id, await this.fetchComments(issue));
        const issueAttachments = await this.fetch(
          `${issue.identifier ?? issue.id}: attachments`,
          () => this.client.listIssueAttachments(issue.id),
        );
        attachments.set(issue.id, issueAttachments ?? []);
      }),
    ]);
    return { project, setup, issues, initiatives, links, comments, attachments };
  }

  /** A failed page keeps the initiatives read so far; the error is reported. */
  private async fetchInitiatives(projectKey: string): Promise<ItsaplanInitiativeRecord[]> {
    const items: ItsaplanInitiativeRecord[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.fetch(`project ${projectKey}: initiatives`, () =>
        this.client.listInitiativesPage(projectKey, page),
      );
      if (!result) {
        return items;
      }
      items.push(...result.items);
      if (result.items.length === 0 || items.length >= result.total) {
        return items;
      }
    }
  }

  private async fetchComments(issue: ItsaplanIssueRecord): Promise<ItsaplanFeedItem[]> {
    const comments: ItsaplanFeedItem[] = [];
    let cursor: string | null = null;
    do {
      const currentCursor: string | null = cursor;
      const page: { items: ItsaplanFeedItem[]; nextCursor: string | null } | null =
        await this.fetch(`${issue.identifier ?? issue.id}: comments`, () =>
          this.client.listIssueFeedPage(issue.id, currentCursor),
        );
      if (!page) {
        break;
      }
      comments.push(...page.items.filter((item) => item.kind === "comment"));
      cursor = page.nextCursor;
    } while (cursor);
    return comments;
  }

  /** Downloads the attachments not imported yet; keyed by itsaplan attachment id. */
  private async downloadAttachments(
    snapshot: ProjectSnapshot,
  ): Promise<Map<string, DownloadedAttachment>> {
    const known = (this.knownAttachmentIds ??= this.options.ticketStore.withTransaction(
      (db) =>
        new Set(
          db
            .prepare("SELECT external_id FROM attachments WHERE external_system = 'itsaplan'")
            .all()
            .map((row) => String(row.external_id)),
        ),
    ));
    const downloads = new Map<string, DownloadedAttachment>();
    const pending = snapshot.issues.flatMap((issue) =>
      (snapshot.attachments.get(issue.id) ?? [])
        .filter((attachment) => !known.has(attachment.id))
        .map((attachment) => ({ issue, attachment })),
    );
    await Promise.all(
      pending.map(async ({ issue, attachment }) => {
        const label = `${issue.identifier ?? issue.id}: attachment ${attachment.filename}`;
        if ((attachment.sizeBytes ?? 0) > MAX_ATTACHMENT_BYTES) {
          this.total.errors.push(`${label}: larger than 20 MB, not imported`);
          return;
        }
        const file = await this.fetch(label, () => this.client.downloadAttachment(attachment.url));
        if (!file) {
          return;
        }
        if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
          this.total.errors.push(`${label}: larger than 20 MB, not imported`);
          return;
        }
        const id = newId("att");
        await writeFile(this.options.ticketStore.attachmentPath(id), file.bytes);
        downloads.set(attachment.id, {
          id,
          mimeType: attachment.contentType ?? file.contentType ?? "application/octet-stream",
          size: file.bytes.length,
        });
      }),
    );
    return downloads;
  }

  // --- Runs: local agents linked to an itsaplan issue by label.

  private async importRuns(): Promise<void> {
    const linked: Array<{
      record: ItsaplanImportAgentRecord;
      issueId: number;
      bucket: LifecycleBucket;
    }> = [];
    for (const record of await this.options.agentStorage.list()) {
      const issueId = getItsaplanIssueIdFromLabels(record.labels);
      if (!issueId) {
        continue;
      }
      try {
        const bucket = await this.options.missionControl.getLifecycleBucket(record.id);
        linked.push({ record, issueId: Number(issueId), bucket });
      } catch (error) {
        this.total.errors.push(`agent ${record.id}: ${errorMessage(error)}`);
      }
    }
    if (linked.length === 0) {
      return;
    }
    const tally = emptyTally();
    try {
      this.options.ticketStore.withTransaction((db) => {
        for (const { record, issueId, bucket } of linked) {
          const ticketId = findIdByExternalId(db, "tickets", issueId);
          if (!ticketId) {
            continue;
          }
          const run = {
            server_id: this.options.serverId,
            bucket,
            agent_title: record.title ?? null,
            agent_name: record.name ?? null,
            archived: record.archivedAt ? 1 : 0,
          };
          const existing = db
            .prepare("SELECT * FROM runs WHERE ticket_id = ? AND agent_id = ?")
            .get(ticketId, record.id);
          if (!existing) {
            db.prepare(
              "INSERT INTO runs (ticket_id, agent_id, server_id, bucket, agent_title, agent_name, archived, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              ticketId,
              record.id,
              run.server_id,
              run.bucket,
              run.agent_title,
              run.agent_name,
              run.archived,
              record.createdAt,
              record.updatedAt,
            );
            tally.counts.runs += 1;
          } else if (
            Object.entries(run).some(([column, value]) => !sameValue(existing[column], value))
          ) {
            db.prepare(
              "UPDATE runs SET server_id = ?, bucket = ?, agent_title = ?, agent_name = ?, archived = ?, updated_at = ? WHERE ticket_id = ? AND agent_id = ?",
            ).run(
              run.server_id,
              run.bucket,
              run.agent_title,
              run.agent_name,
              run.archived,
              record.updatedAt,
              ticketId,
              record.id,
            );
            tally.counts.updated += 1;
          } else {
            continue;
          }
          tally.ticketIds.add(ticketId);
        }
      });
    } catch (error) {
      this.total.errors.push(`runs: ${errorMessage(error)}`);
      return;
    }
    this.merge(tally);
  }

  // --- Result.

  private merge(tally: ImportTally): void {
    for (const [name, value] of Object.entries(tally.counts) as Array<
      [keyof ImportTally["counts"], number]
    >) {
      this.total.counts[name] += value;
    }
    this.total.errors.push(...tally.errors);
    for (const id of tally.boardIds) {
      this.total.boardIds.add(id);
    }
    for (const id of tally.ticketIds) {
      this.total.ticketIds.add(id);
    }
    for (const id of tally.initiativeIds) {
      this.total.initiativeIds.add(id);
    }
  }

  /** One revision for the whole import, and only when it changed a row. */
  private publishChange(): void {
    if (Object.values(this.total.counts).every((count) => count === 0)) {
      return;
    }
    const store = this.options.ticketStore;
    const revision = store.withTransaction(() => store.bumpRevision());
    this.options.ticketService.publishChange({
      revision,
      boardIds: Array.from(this.total.boardIds),
      ticketIds: Array.from(this.total.ticketIds),
      initiativeIds: Array.from(this.total.initiativeIds),
    });
  }

  private buildReport(): TicketImportReport {
    const errors = this.total.errors.slice(0, MAX_REPORTED_ERRORS);
    const hidden = this.total.errors.length - errors.length;
    if (hidden > 0) {
      errors.push(`… and ${hidden} more errors`);
    }
    return { ...this.total.counts, errors };
  }
}

interface ProjectWriteInput {
  snapshot: ProjectSnapshot;
  paseoProjectKey: string | null;
  users: ItsaplanImportUsers;
  downloads: ReadonlyMap<string, DownloadedAttachment>;
  knownAttachmentIds: ReadonlySet<string>;
  now: string;
}

interface TicketFieldsContext {
  boardId: string;
  // itsaplan column id → column id.
  columnIds: ReadonlyMap<number, string>;
  // Used when the issue's itsaplan column was not imported.
  fallbackColumnId: string;
  // itsaplan issue type id → type name.
  typeNames: ReadonlyMap<number, string>;
}

interface ColumnRow {
  id: string;
  name: string;
  stateType: string;
  position: number;
}

/** Writes one project snapshot; runs inside one store transaction. */
class ProjectWriter {
  private readonly db: SqliteDatabase;
  private readonly tally: ImportTally;
  private readonly input: ProjectWriteInput;
  private readonly ticketIdByIssueId = new Map<number, string>();

  constructor(db: SqliteDatabase, tally: ImportTally, input: ProjectWriteInput) {
    this.db = db;
    this.tally = tally;
    this.input = input;
  }

  write(): void {
    const { boardId, firstImport } = this.writeBoard();
    const columnIds = this.writeColumns(boardId, firstImport);
    this.writeInitiatives(boardId);
    this.writeTickets(boardId, columnIds);
    this.writeLinks();
    this.writeComments();
    this.writeAttachments();
    // Native tickets on this board continue after the highest imported number.
    this.db
      .prepare(
        "UPDATE boards SET next_sequence = MAX(next_sequence, (SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM tickets WHERE board_id = ?)) WHERE id = ?",
      )
      .run(boardId, boardId);
  }

  private count(outcome: UpsertOutcome, created: keyof ImportTally["counts"]): boolean {
    if (outcome === "created") {
      this.tally.counts[created] += 1;
    } else if (outcome === "updated") {
      this.tally.counts.updated += 1;
    }
    return outcome !== "unchanged";
  }

  /** The Paseo project key the board may carry: a project has one board. */
  private claimableProjectKey(boardId: string | null): string | null {
    const { paseoProjectKey, snapshot } = this.input;
    if (paseoProjectKey === null) {
      return null;
    }
    const holder = this.db
      .prepare("SELECT key FROM boards WHERE project_key = ? AND id IS NOT ?")
      .get(paseoProjectKey, boardId);
    if (!holder) {
      return paseoProjectKey;
    }
    this.tally.errors.push(
      `project ${snapshot.project.key}: Paseo project ${paseoProjectKey} already has board ${text(holder, "key")}; the imported board is not linked to it`,
    );
    return null;
  }

  private writeBoard(): { boardId: string; firstImport: boolean } {
    const { project } = this.input.snapshot;
    const now = this.input.now;
    const existing = this.db
      .prepare(
        "SELECT id, key, name, project_key FROM boards WHERE external_system = 'itsaplan' AND external_id = ?",
      )
      .get(project.id);
    if (existing) {
      const boardId = text(existing, "id");
      const projectKey = this.claimableProjectKey(boardId) ?? textOrNull(existing, "project_key");
      if (
        text(existing, "key") !== project.key ||
        text(existing, "name") !== project.name ||
        textOrNull(existing, "project_key") !== projectKey
      ) {
        this.db
          .prepare(
            "UPDATE boards SET key = ?, name = ?, project_key = ?, external_identifier = ?, updated_at = ? WHERE id = ?",
          )
          .run(project.key, project.name, projectKey, project.key, now, boardId);
        this.tally.counts.updated += 1;
        this.tally.boardIds.add(boardId);
      }
      return { boardId, firstImport: false };
    }

    // A native board that was never used (no tickets, no initiatives) with
    // this key or this project becomes the imported board.
    const paseoProjectKey = this.input.paseoProjectKey;
    const adoptable = this.db
      .prepare(
        `SELECT b.id, b.project_key FROM boards b
         WHERE b.external_system IS NULL
           AND (b.key = ? OR (? IS NOT NULL AND b.project_key = ?))
           AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.board_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM initiatives i WHERE i.board_id = b.id)
         ORDER BY b.key = ? DESC LIMIT 1`,
      )
      .get(project.key, paseoProjectKey, paseoProjectKey, project.key);
    const adoptedId = adoptable ? text(adoptable, "id") : null;
    const keyHolder = this.db
      .prepare("SELECT id FROM boards WHERE key = ? AND id IS NOT ?")
      .get(project.key, adoptedId);
    if (keyHolder) {
      throw new Error(`board key ${project.key} is taken by another board that is in use`);
    }
    this.tally.counts.boards += 1;
    if (adoptable && adoptedId) {
      const projectKey =
        this.claimableProjectKey(adoptedId) ?? textOrNull(adoptable, "project_key");
      this.db
        .prepare(
          "UPDATE boards SET key = ?, name = ?, project_key = ?, external_system = 'itsaplan', external_id = ?, external_identifier = ?, updated_at = ? WHERE id = ?",
        )
        .run(project.key, project.name, projectKey, project.id, project.key, now, adoptedId);
      this.tally.boardIds.add(adoptedId);
      return { boardId: adoptedId, firstImport: true };
    }
    const projectKey = this.claimableProjectKey(null);
    const boardId = newId("brd");
    this.db
      .prepare(
        "INSERT INTO boards (id, key, name, project_key, next_sequence, created_at, updated_at, archived_at, external_system, external_id, external_identifier) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, 'itsaplan', ?, ?)",
      )
      .run(
        boardId,
        project.key,
        project.name,
        projectKey,
        project.createdAt ?? now,
        now,
        project.id,
        project.key,
      );
    this.tally.boardIds.add(boardId);
    return { boardId, firstImport: true };
  }

  /**
   * Matches itsaplan columns to board columns by name and creates the missing
   * ones between their itsaplan neighbours, so the itsaplan order holds.
   * Returns itsaplan column id → column id.
   */
  private writeColumns(boardId: string, firstImport: boolean): Map<number, string> {
    const rows: ColumnRow[] = this.db
      .prepare(
        "SELECT id, name, state_type, position FROM columns WHERE board_id = ? ORDER BY position, id",
      )
      .all(boardId)
      .map((row) => ({
        id: text(row, "id"),
        name: text(row, "name"),
        stateType: text(row, "state_type"),
        position: num(row, "position"),
      }));
    const sourceColumns = [...this.input.snapshot.setup.columns].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    );
    const columnIds = new Map<number, string>();
    const used = new Set<string>();
    let previous: ColumnRow | null = null;
    for (const column of sourceColumns) {
      let match = rows.find((row) => row.name === column.name && !used.has(row.id));
      if (match) {
        if (match.stateType !== column.stateType) {
          this.db
            .prepare("UPDATE columns SET state_type = ? WHERE id = ?")
            .run(column.stateType, match.id);
          match.stateType = column.stateType;
          if (!firstImport) {
            this.tally.counts.updated += 1;
          }
          this.tally.boardIds.add(boardId);
        }
      } else {
        const after = previous;
        const next = after ? rows.find((row) => row.position > after.position) : rows[0];
        let position = 1;
        if (after && next) {
          position = (after.position + next.position) / 2;
        } else if (after) {
          position = after.position + 1;
        } else if (next) {
          position = next.position - 1;
        }
        match = { id: newId("col"), name: column.name, stateType: column.stateType, position };
        this.db
          .prepare(
            "INSERT INTO columns (id, board_id, name, state_type, position) VALUES (?, ?, ?, ?, ?)",
          )
          .run(match.id, boardId, match.name, match.stateType, match.position);
        rows.push(match);
        rows.sort((a, b) => a.position - b.position);
        if (!firstImport) {
          this.tally.counts.updated += 1;
        }
        this.tally.boardIds.add(boardId);
      }
      used.add(match.id);
      columnIds.set(column.id, match.id);
      previous = match;
    }
    return columnIds;
  }

  private writeInitiatives(boardId: string): void {
    for (const [index, initiative] of this.input.snapshot.initiatives.entries()) {
      const status = InitiativeStatusSchema.safeParse(initiative.status);
      const priority = TicketPrioritySchema.safeParse(initiative.priority);
      const { id, outcome } = upsertByExternalId(this.db, {
        table: "initiatives",
        prefix: "ini",
        externalId: initiative.id,
        fields: {
          board_id: boardId,
          title: initiative.title,
          description: initiative.description ?? "",
          status: status.success ? status.data : "proposed",
          priority: priority.success ? priority.data : null,
          start_date: initiative.startDate ?? null,
          target_date: initiative.targetDate ?? null,
          position: initiative.position ?? index + 1,
          created_at: initiative.createdAt,
          updated_at: initiative.updatedAt,
        },
      });
      if (this.count(outcome, "initiatives")) {
        this.tally.initiativeIds.add(id);
        this.tally.boardIds.add(boardId);
      }
    }
  }

  private writeTickets(boardId: string, columnIds: ReadonlyMap<number, string>): void {
    const { snapshot, now } = this.input;
    const fallbackColumn = this.db
      .prepare("SELECT id FROM columns WHERE board_id = ? ORDER BY position, id LIMIT 1")
      .get(boardId);
    if (!fallbackColumn) {
      throw new Error("the board has no columns");
    }
    const context: TicketFieldsContext = {
      boardId,
      columnIds,
      fallbackColumnId: text(fallbackColumn, "id"),
      typeNames: new Map(snapshot.setup.issueTypes.map((type) => [type.id, type.name])),
    };
    // Parents first: sub-tasks are one level deep in itsaplan.
    const issues = [...snapshot.issues].sort(
      (a, b) => Number(a.parentId != null) - Number(b.parentId != null),
    );
    for (const [index, issue] of issues.entries()) {
      const { key, sequence } = itsaplanTicketKey(issue, snapshot.project.key);
      const keyHolder = this.db
        .prepare(
          "SELECT id FROM tickets WHERE key = ? AND NOT (external_system IS 'itsaplan' AND external_id IS ?)",
        )
        .get(key, issue.id);
      if (keyHolder) {
        this.tally.errors.push(`${key}: the key is taken by another ticket, not imported`);
        continue;
      }
      const { id, outcome } = upsertByExternalId(this.db, {
        table: "tickets",
        prefix: "tkt",
        externalId: issue.id,
        fields: this.ticketFields(
          issue,
          { key, sequence, position: issue.position ?? index },
          context,
        ),
      });
      this.ticketIdByIssueId.set(issue.id, id);
      if (outcome === "created") {
        const actor: TicketActor = { kind: "system" };
        this.db
          .prepare(
            "INSERT INTO activity (id, ticket_id, kind, actor_json, event_type, from_value, created_at) VALUES (?, ?, 'event', ?, 'imported', 'itsaplan', ?)",
          )
          .run(newId("act"), id, JSON.stringify(actor), now);
      }
      if (this.count(outcome, "tickets")) {
        this.tally.ticketIds.add(id);
        this.tally.boardIds.add(boardId);
      }
    }
  }

  /** The tickets row of one itsaplan issue; parents must be written before their sub-tasks. */
  private ticketFields(
    issue: ItsaplanIssueRecord,
    placement: { key: string; sequence: number; position: number },
    context: TicketFieldsContext,
  ): Record<string, SqlValue> {
    const parentId =
      issue.parentId == null
        ? null
        : (this.ticketIdByIssueId.get(issue.parentId) ??
          findIdByExternalId(this.db, "tickets", issue.parentId));
    const initiativeExternalId = issue.initiative?.id ?? issue.initiativeId ?? null;
    const priority = TicketPrioritySchema.safeParse(issue.priority);
    return {
      board_id: context.boardId,
      sequence_number: placement.sequence,
      key: placement.key,
      title: issue.title,
      description: issue.description ?? "",
      column_id: context.columnIds.get(issue.columnId) ?? context.fallbackColumnId,
      position: placement.position,
      priority: priority.success ? priority.data : null,
      type: issue.typeId == null ? null : (context.typeNames.get(issue.typeId) ?? null),
      assignee: mapItsaplanAssignee(issue.assigneeUserId, this.input.users),
      parent_id: parentId,
      initiative_id:
        initiativeExternalId === null
          ? null
          : findIdByExternalId(this.db, "initiatives", initiativeExternalId),
      start_date: issue.startDate ?? null,
      due_date: issue.dueDate ?? null,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      archived_at: issue.archivedAt ?? null,
      external_identifier: issue.identifier ?? placement.key,
    };
  }

  private writeLinks(): void {
    const createdAt = this.input.now;
    for (const { issueId, blockedByIssueId } of itsaplanBlockerLinks(this.input.snapshot.links)) {
      const ticketId = this.ticketIdByIssueId.get(issueId);
      const blockedByTicketId = this.ticketIdByIssueId.get(blockedByIssueId);
      if (!ticketId || !blockedByTicketId) {
        continue;
      }
      // The blocker must not already wait, through its own blockers, on the ticket.
      const cycle = this.db
        .prepare(
          `WITH RECURSIVE chain(id) AS (
             SELECT blocked_by_ticket_id FROM ticket_links WHERE ticket_id = ?
             UNION
             SELECT l.blocked_by_ticket_id FROM ticket_links l JOIN chain c ON l.ticket_id = c.id
           )
           SELECT 1 FROM chain WHERE id = ? LIMIT 1`,
        )
        .get(blockedByTicketId, ticketId);
      if (cycle) {
        this.tally.errors.push(
          `link ${blockedByIssueId} blocks ${issueId}: it closes a blocker cycle, not imported`,
        );
        continue;
      }
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO ticket_links (ticket_id, blocked_by_ticket_id, created_at) VALUES (?, ?, ?)",
        )
        .run(ticketId, blockedByTicketId, createdAt);
      if (result.changes > 0) {
        this.tally.counts.links += 1;
        this.tally.ticketIds.add(ticketId);
        this.tally.ticketIds.add(blockedByTicketId);
      }
    }
  }

  private writeComments(): void {
    const { snapshot, users } = this.input;
    const commentIds = new Map<number, string>();
    for (const issue of snapshot.issues) {
      const ticketId = this.ticketIdByIssueId.get(issue.id);
      if (!ticketId) {
        continue;
      }
      // Oldest first, so the comment a reply answers is always written before it.
      const comments = [...(snapshot.comments.get(issue.id) ?? [])].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
      );
      for (const comment of comments) {
        const replyToId =
          comment.replyToId == null
            ? null
            : (commentIds.get(comment.replyToId) ??
              findIdByExternalId(this.db, "activity", comment.replyToId));
        const { id, outcome } = upsertByExternalId(this.db, {
          table: "activity",
          prefix: "act",
          externalId: comment.id,
          fields: {
            ticket_id: ticketId,
            actor_json: JSON.stringify(mapItsaplanCommentActor(comment, users)),
            body: comment.body ?? "",
            reply_to_id: replyToId,
            created_at: comment.createdAt,
          },
          insertOnly: { kind: "comment" },
        });
        commentIds.set(comment.id, id);
        if (this.count(outcome, "comments")) {
          this.tally.ticketIds.add(ticketId);
        }
      }
    }
  }

  private writeAttachments(): void {
    const { snapshot, downloads, knownAttachmentIds } = this.input;
    for (const issue of snapshot.issues) {
      const ticketId = this.ticketIdByIssueId.get(issue.id);
      if (!ticketId) {
        continue;
      }
      for (const attachment of snapshot.attachments.get(issue.id) ?? []) {
        const download = downloads.get(attachment.id);
        // Neither imported before nor downloaded now: the error is reported.
        if (!download && !knownAttachmentIds.has(attachment.id)) {
          continue;
        }
        const { outcome } = upsertByExternalId(this.db, {
          table: "attachments",
          prefix: "att",
          externalId: attachment.id,
          newRowId: download?.id,
          fields: { ticket_id: ticketId, file_name: attachment.filename },
          insertOnly: download
            ? {
                mime_type: download.mimeType,
                size: download.size,
                storage_path: download.id,
                created_at: attachment.createdAt ?? issue.createdAt,
              }
            : {},
        });
        if (this.count(outcome, "attachments")) {
          this.tally.ticketIds.add(ticketId);
        }
      }
    }
  }
}
