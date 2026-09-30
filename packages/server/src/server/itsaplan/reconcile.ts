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

export interface ItsaplanReconcileMissionControl {
  getLifecycleBucket(agentId: string): Promise<LifecycleBucket>;
}

export interface ItsaplanReconcileOptions {
  agentStorage: ItsaplanReconcileAgentStorage;
  missionControl: ItsaplanReconcileMissionControl;
  projectStore: ItsaplanProjectStore;
  getConfig: () => ItsaplanCentralConfig | null;
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

/**
 * ADR 0002 periodic reconciliation sweep: for each itsaplan issue with a
 * labeled Paseo agent, re-projects drift from the agent's execution truth —
 * never the reverse. Column moves are strictly forward (Todo -> In Progress
 * -> Ready to review); a ticket already at or past its truth-implied column,
 * or already Done/Cancelled (user-owned, terminal), is left untouched.
 *
 * An issue whose latest attempt is archived is history, not drift: the sweep
 * skips it. Without this skip, every archived attempt cost two requests per
 * sweep and the fleet flooded itsaplan into rate limits. A 429 ends the
 * sweep and doubles the delay to the next one (up to 10 minutes); a sweep
 * without a 429 resets the delay.
 */
export class ItsaplanReconcileService {
  private readonly agentStorage: ItsaplanReconcileAgentStorage;
  private readonly missionControl: ItsaplanReconcileMissionControl;
  private readonly projectStore: ItsaplanProjectStore;
  private readonly getConfig: () => ItsaplanCentralConfig | null;
  private readonly logger: Logger;
  private readonly baseIntervalMs: number;
  private intervalMs: number;
  private started = false;
  private sweepInFlight = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ItsaplanReconcileOptions) {
    this.agentStorage = options.agentStorage;
    this.missionControl = options.missionControl;
    this.projectStore = options.projectStore;
    this.getConfig = options.getConfig;
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
    // A sweep still in flight from before stop() schedules the next one.
    if (!this.sweepInFlight) {
      this.scheduleSweep();
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
      if (latest.archivedAt) {
        continue;
      }
      try {
        await this.reconcileIssue(issueId, latest, config);
      } catch (error) {
        if (error instanceof ItsaplanApiError && error.status === 429) {
          this.intervalMs = Math.min(this.intervalMs * 2, MAX_SWEEP_INTERVAL_MS);
          this.logger.warn(
            { issueId, nextSweepDelayMs: this.intervalMs },
            "itsaplan.reconcile.rate_limited",
          );
          return;
        }
        this.logger.error({ err: error, issueId }, "itsaplan.reconcile.issue_failed");
      }
    }
    this.intervalMs = this.baseIntervalMs;
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
    const truthRank = bucket === "ready" || bucket === "done" ? 2 : 1;

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

    if (currentRank < 3 && truthRank > currentRank) {
      const target =
        truthRank === 2
          ? await client.ensureColumn(projectKey, ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME, "started")
          : findInProgressColumn(columns);
      if (target && issue.columnId !== target.id) {
        await client.moveIssueColumn(numericIssueId, target.id);
        this.logger.info(
          { issueId, columnId: target.id },
          "itsaplan.reconcile.column_drift_corrected",
        );
      }
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
