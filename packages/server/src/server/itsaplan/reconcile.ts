import type { Logger } from "pino";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  findInProgressColumn,
  ITSAPLAN_READY_FOR_REVIEW_COLUMN_NAME,
  ItsaplanClient,
  type ItsaplanColumn,
} from "./client.js";
import type { ItsaplanCentralConfig, ItsaplanProjectStore } from "./projects.js";
import { ITSAPLAN_ISSUE_LABEL_KEY } from "./bridge.js";

export interface ItsaplanReconcileAgentStorage {
  list(): Promise<Pick<StoredAgentRecord, "id" | "labels" | "updatedAt">[]>;
}

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
 */
export class ItsaplanReconcileService {
  private readonly agentStorage: ItsaplanReconcileAgentStorage;
  private readonly missionControl: ItsaplanReconcileMissionControl;
  private readonly projectStore: ItsaplanProjectStore;
  private readonly getConfig: () => ItsaplanCentralConfig | null;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ItsaplanReconcileOptions) {
    this.agentStorage = options.agentStorage;
    this.missionControl = options.missionControl;
    this.projectStore = options.projectStore;
    this.getConfig = options.getConfig;
    this.logger = options.logger.child({ module: "itsaplan", component: "reconcile" });
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runSweep();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runSweep(): Promise<void> {
    const config = this.getConfig();
    if (!config) {
      return;
    }
    const groups = new Map<string, Pick<StoredAgentRecord, "id" | "labels" | "updatedAt">[]>();
    for (const record of await this.agentStorage.list()) {
      const issueId = record.labels?.[ITSAPLAN_ISSUE_LABEL_KEY];
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
      try {
        await this.reconcileIssue(issueId, group, config);
      } catch (error) {
        this.logger.error({ err: error, issueId }, "itsaplan.reconcile.issue_failed");
      }
    }
  }

  private async reconcileIssue(
    issueId: string,
    group: readonly Pick<StoredAgentRecord, "id" | "labels" | "updatedAt">[],
    config: ItsaplanCentralConfig,
  ): Promise<void> {
    const numericIssueId = Number(issueId);
    if (!Number.isFinite(numericIssueId)) {
      return;
    }
    // One ticket can have N agent attempts (ADR 0002); the most recently
    // updated attempt is this issue's current execution truth.
    const latest = group.reduce((newest, candidate) =>
      candidate.updatedAt > newest.updatedAt ? candidate : newest,
    );
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
