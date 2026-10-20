import type { Logger } from "pino";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  findInProgressColumn,
  ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
  ItsaplanApiError,
  ItsaplanClient,
  type ItsaplanColumn,
} from "./client.js";
import type { ItsaplanCentralConfig, ItsaplanProjectStore } from "./projects.js";
import { getItsaplanIssueIdFromLabels } from "./bridge.js";

type ReconcileAgentRecord = Pick<StoredAgentRecord, "id" | "labels" | "updatedAt" | "archivedAt">;

export interface ItsaplanReconcileAgentStorage {
  list(): Promise<ReconcileAgentRecord[]>;
}

// Upper bound of the sweep interval after repeated rate limits.
const MAX_SWEEP_INTERVAL_MS = 10 * 60_000;

// Owned-board pass (Todo dispatch, webhook re-enable) runs on sweep 0, 5, 10…
const OWNED_BOARDS_EVERY_SWEEPS = 5;

export interface ItsaplanReconcileMissionControl {
  getLifecycleBucket(agentId: string): Promise<LifecycleBucket>;
}

export interface ItsaplanReconcileOptions {
  agentStorage: ItsaplanReconcileAgentStorage;
  missionControl: ItsaplanReconcileMissionControl;
  projectStore: ItsaplanProjectStore;
  getConfig: () => ItsaplanCentralConfig | null;
  /** Archives the live agents (and their workspaces) of a ticket found in a
   * completed or canceled column (ItsaplanBridge.handleTicketCompletedOrCanceled). */
  closeTicket: (issueId: string) => Promise<void>;
  /** Dispatches Todo tickets whose webhook never arrived and re-enables
   * auto-disabled webhooks (ItsaplanBridge.reconcileOwnedBoards). */
  reconcileOwnedBoards: () => Promise<void>;
  /** Archives this host's boards whose Paseo project is gone
   * (archiveOrphanedItsaplanBoards); returns how many. */
  archiveOrphanedBoards: () => Promise<number>;
  logger: Logger;
  intervalMs?: number;
}

/** Column progress rank: how far along the bridge-owned Todo->...->Done path a
 * column sits. Terminal (completed/canceled) columns are user-owned and are
 * never assigned a forward target — callers check for them separately. */
function columnRank(column: ItsaplanColumn | undefined): number {
  if (!column) {
    return -1;
  }
  if (column.stateType === "started") {
    return column.name === ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME ? 2 : 1;
  }
  if (column.stateType === "completed" || column.stateType === "canceled") {
    return 3;
  }
  return 0;
}

/**
 * The board an issue belongs to, for a host that holds no mapping for it.
 *
 * The mapping file is written only by the designated sync host, so a peer
 * projecting the agents it runs has none — and the early return on a missing
 * mapping is why a ticket dispatched to a peer sat in Todo while that peer swept
 * it every 60 seconds. itsaplan's `identifier` is "<KEY>-<sequenceNumber>" and
 * the sequence number is always the final segment, so the key survives even when
 * it contains a hyphen of its own (collision-suffixed PASEO-A1B2 recovers from
 * PASEO-A1B2-7).
 *
 * Callers still prefer a real mapping: it also carries commanderUserId for the
 * assignee flip-back, which no identifier can supply.
 */
function projectKeyFromIdentifier(identifier: string | undefined): string | null {
  if (!identifier) {
    return null;
  }
  const lastDash = identifier.lastIndexOf("-");
  return lastDash > 0 ? identifier.slice(0, lastDash) : null;
}

/** The column an open ticket belongs in, given its latest agent's bucket. */
async function targetColumnFor(
  bucket: LifecycleBucket,
  currentRank: number,
  columns: readonly ItsaplanColumn[],
  ensureReadyColumn: () => Promise<ItsaplanColumn>,
): Promise<ItsaplanColumn | undefined> {
  if (bucket === "ready") {
    return ensureReadyColumn();
  }
  if (bucket === "running" || bucket === "needs_you") {
    return findInProgressColumn(columns);
  }
  // An agent that started work but never finished (a run cut off before this
  // host recorded any state, or one that predates the projection) still means
  // the ticket is in progress, not waiting in Todo.
  if (bucket === "idle" && currentRank < 1) {
    return findInProgressColumn(columns);
  }
  return undefined;
}

/**
 * ADR 0002 periodic reconciliation sweep: for each itsaplan issue with a
 * labeled Paseo agent, re-projects drift from the agent's execution truth.
 * Column moves follow the agent both ways between In Progress and Ready to
 * review (a re-prompted ready agent goes back to In Progress). Done/Cancelled
 * columns are user-owned: the sweep never moves a ticket out of them, and a
 * ticket found there with a live agent gets the closed-ticket archive, so a
 * missed or failed webhook heals within one sweep.
 *
 * An issue whose latest attempt is archived is history, not drift: the sweep
 * skips it. Without this skip, every archived attempt cost two requests per
 * sweep and the fleet flooded itsaplan into rate limits. An issue deleted in
 * itsaplan (404) is skipped for the life of the process. A 429 ends the sweep
 * and doubles the delay to the next one (up to 10 minutes); a sweep without a
 * 429 resets the delay.
 */
export class ItsaplanReconcileService {
  private readonly agentStorage: ItsaplanReconcileAgentStorage;
  private readonly missionControl: ItsaplanReconcileMissionControl;
  private readonly projectStore: ItsaplanProjectStore;
  private readonly getConfig: () => ItsaplanCentralConfig | null;
  private readonly closeTicket: (issueId: string) => Promise<void>;
  private readonly reconcileOwnedBoards: () => Promise<void>;
  private readonly archiveOrphanedBoards: () => Promise<number>;
  /** Issues itsaplan answered 404 for: deleted tickets, never fetched again. */
  private readonly deletedIssueIds = new Set<string>();
  private readonly logger: Logger;
  private readonly baseIntervalMs: number;
  private intervalMs: number;
  private started = false;
  private sweepInFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private sweepCount = 0;
  /** Promise tracking the startup sweep (if currently in flight or completed on boot). */
  initialSweepPromise: Promise<void> | null = null;

  constructor(options: ItsaplanReconcileOptions) {
    this.agentStorage = options.agentStorage;
    this.missionControl = options.missionControl;
    this.projectStore = options.projectStore;
    this.getConfig = options.getConfig;
    this.closeTicket = options.closeTicket;
    this.reconcileOwnedBoards = options.reconcileOwnedBoards;
    this.archiveOrphanedBoards = options.archiveOrphanedBoards;
    this.logger = options.logger.child({ module: "itsaplan", component: "reconcile" });
    this.baseIntervalMs = options.intervalMs ?? 60_000;
    this.intervalMs = this.baseIntervalMs;
  }

  /** Delay from the end of one sweep to the start of the next. */
  get nextSweepDelayMs(): number {
    return this.intervalMs;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    // Run an initial sweep immediately on startup to correct drift that
    // accumulated while offline, then schedule periodic sweeps.
    if (!this.sweepInFlight) {
      this.sweepInFlight = true;
      this.initialSweepPromise = this.runSweep()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, "itsaplan.reconcile.sweep_failed");
        })
        .finally(() => {
          this.sweepInFlight = false;
          if (this.started) {
            this.scheduleSweep();
          }
        });
    }
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleSweep(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweepInFlight = true;
      void this.runSweep()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, "itsaplan.reconcile.sweep_failed");
        })
        .finally(() => {
          this.sweepInFlight = false;
          if (this.started) {
            this.scheduleSweep();
          }
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async runSweep(): Promise<void> {
    const config = this.getConfig();
    if (!config) {
      return;
    }
    if (!(await this.reconcileLabeledIssues(config))) {
      return;
    }
    // One list request per sweep; runs before the owned-board pass so it
    // never re-enables the webhook of a board whose project is gone.
    try {
      const archived = await this.archiveOrphanedBoards();
      if (archived > 0) {
        this.logger.info({ archived }, "itsaplan.reconcile.orphaned_boards_archived");
      }
    } catch (error) {
      if (error instanceof ItsaplanApiError && error.status === 429) {
        this.backOff({ phase: "orphaned_boards" });
        return;
      }
      this.logger.error({ err: error }, "itsaplan.reconcile.orphaned_boards_failed");
    }
    // Listing every owned board costs two requests per board, so Todo tickets
    // and disabled webhooks are checked at boot and then every few sweeps.
    if (this.sweepCount++ % OWNED_BOARDS_EVERY_SWEEPS === 0) {
      try {
        await this.reconcileOwnedBoards();
      } catch (error) {
        if (error instanceof ItsaplanApiError && error.status === 429) {
          this.backOff({ phase: "owned_boards" });
          return;
        }
        this.logger.error({ err: error }, "itsaplan.reconcile.owned_boards_failed");
      }
    }
    this.intervalMs = this.baseIntervalMs;
  }

  private backOff(context: Record<string, unknown>): void {
    this.intervalMs = Math.min(this.intervalMs * 2, MAX_SWEEP_INTERVAL_MS);
    this.logger.warn(
      { ...context, nextSweepDelayMs: this.intervalMs },
      "itsaplan.reconcile.rate_limited",
    );
  }

  /** False when itsaplan rate-limited the sweep (it ends early and backs off). */
  private async reconcileLabeledIssues(config: ItsaplanCentralConfig): Promise<boolean> {
    const groups = new Map<string, ReconcileAgentRecord[]>();
    for (const record of await this.agentStorage.list()) {
      const issueId = getItsaplanIssueIdFromLabels(record.labels);
      if (!issueId) {
        continue;
      }
      const group = groups.get(issueId);
      if (group) {
        group.push(record);
      } else {
        groups.set(issueId, [record]);
      }
    }
    for (const [issueId, group] of groups) {
      // One ticket can have N agent attempts (ADR 0002); the most recently
      // updated attempt is this issue's current execution truth.
      const latest = group.reduce((newest, candidate) =>
        candidate.updatedAt > newest.updatedAt ? candidate : newest,
      );
      if (latest.archivedAt || this.deletedIssueIds.has(issueId)) {
        continue;
      }
      try {
        await this.reconcileIssue(issueId, latest, config);
      } catch (error) {
        if (error instanceof ItsaplanApiError && error.status === 429) {
          this.backOff({ issueId });
          return false;
        }
        if (error instanceof ItsaplanApiError && error.status === 404) {
          this.deletedIssueIds.add(issueId);
          this.logger.warn(
            { issueId, agentId: latest.id },
            "itsaplan.reconcile.issue_deleted_skipping",
          );
          continue;
        }
        // itsaplan unreachable lands here too: the next sweep retries.
        this.logger.error({ err: error, issueId }, "itsaplan.reconcile.issue_failed");
      }
    }
    return true;
  }

  private async reconcileIssue(
    issueId: string,
    latest: ReconcileAgentRecord,
    config: ItsaplanCentralConfig,
  ): Promise<void> {
    const numericIssueId = Number(issueId);
    if (!Number.isFinite(numericIssueId)) {
      return;
    }
    const bucket = await this.missionControl.getLifecycleBucket(latest.id);

    const client = new ItsaplanClient(config);
    const issue = await client.getIssue(numericIssueId);
    const mapping = this.projectStore.getByItsaplanProjectId(issue.projectId);
    const projectKey = mapping?.itsaplanProjectKey ?? projectKeyFromIdentifier(issue.identifier);
    if (!projectKey) {
      return;
    }
    const columns = await client.listProjectColumns(projectKey);
    const currentColumn = columns.find((column) => column.id === issue.columnId);
    const currentRank = columnRank(currentColumn);

    if (currentRank === 3) {
      await this.closeTicket(issueId);
      return;
    }
    const target = await targetColumnFor(bucket, currentRank, columns, () =>
      client.ensureColumn(projectKey, ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME, "started"),
    );
    if (target && issue.columnId !== target.id) {
      await client.moveIssueColumn(numericIssueId, target.id);
      this.logger.info(
        { issueId, columnId: target.id, previousColumnId: issue.columnId },
        "itsaplan.reconcile.column_drift_corrected",
      );
    }

    if (
      bucket === "needs_you" &&
      config.humanUserId &&
      issue.assigneeUserId !== config.humanUserId
    ) {
      await client.updateAssignee(numericIssueId, config.humanUserId);
      this.logger.info({ issueId }, "itsaplan.reconcile.assignee_drift_corrected");
      return;
    }
    // Silent backstop for the bucket-exit assignee flip-back (the bridge
    // posts the convergence comment; reconcile never comments): a ticket
    // whose agent left needs_you but is still assigned to the human goes
    // back to the Commander bot user, or unassigns when unknown.
    if (
      bucket !== "needs_you" &&
      config.humanUserId &&
      issue.assigneeUserId === config.humanUserId
    ) {
      await client.updateAssignee(numericIssueId, mapping?.commanderUserId ?? null);
      this.logger.info({ issueId }, "itsaplan.reconcile.assignee_return_corrected");
    }
  }
}
