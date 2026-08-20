import type { Logger } from "pino";

import {
  deriveWorkColumn,
  resolveWorkMoveIntent,
  computeSortOrder,
  needsSortOrderRebalance,
} from "@getpaseo/protocol/work/state";
import type { LifecycleBucket } from "@getpaseo/protocol/agent-state-bucket";
import type {
  WorkActivity,
  WorkAssignment,
  WorkComment,
  WorkDraft,
  WorkItem,
  WorkItemDetail,
  WorkItemHostEntry,
  WorkLabel,
  WorkPage,
  WorkProject,
  WorkProjectHostEntry,
  WorkSticky,
  WorkView,
} from "@getpaseo/protocol/work/types";
import type { WorkStore, WorkStoreMutation } from "./store.js";
import type {
  WorkActivityRecord,
  WorkCommentRecord,
  WorkDraftRecord,
  WorkItemRecord,
  WorkLabelRecord,
  WorkPageRecord,
  WorkProjectRecord,
  WorkStickyRecord,
  WorkViewRecord,
} from "./model.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { MissionControlService } from "../mission-control/service.js";
import type { PeerManager } from "../peers/peer-manager.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { buildPeerUnreachableError } from "../peers/peer-manager.js";
import { FleetIdIndex } from "../mission-control/fleet-id-index.js";
import type { WorkDispatcher } from "./dispatcher.js";
import type { WorkFleet } from "./fleet.js";

export interface WorkServiceDeps {
  store: WorkStore;
  logger: Logger;
  agentManager: AgentManager;
  missionControlService: MissionControlService | null;
  peerManager: PeerManager | null;
  projectRegistry: ProjectRegistry;
  dispatcher: WorkDispatcher | null;
  fleet: WorkFleet | null;
  hostName: string;
}

function toWorkProjectPayload(record: WorkProjectRecord): WorkProject {
  return {
    projectKey: record.projectKey,
    projectId: record.projectId,
    identifier: record.identifier,
    displayName: record.displayName,
    description: record.description ?? null,
    nextSequenceId: record.nextSequenceId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt ?? null,
  };
}

function normalizeWorkAssignment(
  value: WorkAssignment | null | undefined,
): WorkItemRecord["assignment"] {
  if (!value) return null;
  return {
    provider: value.provider,
    model: value.model ?? null,
    modeId: value.modeId ?? null,
    thinkingOptionId: value.thinkingOptionId ?? null,
    host: value.host ?? null,
    workspaceId: value.workspaceId ?? null,
    isolation: value.isolation,
  };
}

function toWorkItemPayload(
  record: WorkItemRecord,
  bucket: LifecycleBucket | null,
  humanKey: string,
  subItemCount?: number,
): WorkItem {
  const column = deriveWorkColumn(record, bucket);
  return {
    id: record.id,
    projectKey: record.projectKey,
    projectId: record.projectId,
    sequenceId: record.sequenceId,
    humanKey,
    title: record.title,
    description: record.description,
    priority: record.priority,
    labelIds: record.labelIds,
    parentId: record.parentId ?? null,
    sortOrder: record.sortOrder,
    lane: record.lane,
    assignment: record.assignment ?? null,
    agentId: record.agentId ?? null,
    agentHost: record.agentHost ?? null,
    closed: record.closed ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    column,
    bucket,
    ...(subItemCount !== undefined ? { subItemCount } : {}),
  };
}

function toWorkCommentPayload(record: WorkCommentRecord): WorkComment {
  return {
    id: record.id,
    itemId: record.itemId,
    body: record.body,
    authorKind: (record.authorKind as WorkComment["authorKind"]) ?? "user",
    authorId: record.authorId ?? null,
    authorName: null,
    createdAt: record.createdAt,
  };
}

function toWorkActivityPayload(record: WorkActivityRecord): WorkActivity {
  return {
    id: record.id ?? `${record.itemId}:${record.createdAt}`,
    itemId: record.itemId,
    verb: record.verb,
    field: record.field ?? null,
    oldValue: record.oldValue ?? null,
    newValue: record.newValue ?? null,
    actorKind: (record.actorKind as WorkActivity["actorKind"]) ?? "system",
    actorId: record.actorId ?? null,
    createdAt: record.createdAt,
  };
}

function toWorkLabelPayload(record: WorkLabelRecord): WorkLabel {
  return {
    id: record.id,
    projectKey: record.projectKey,
    name: record.name,
    color: record.color,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toWorkPagePayload(record: WorkPageRecord): WorkPage {
  return {
    id: record.id,
    projectKey: record.projectKey,
    title: record.title,
    body: record.content,
    parentId: record.parentId ?? null,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toWorkDraftPayload(record: WorkDraftRecord): WorkDraft {
  return {
    id: record.id,
    projectKey: record.projectKey,
    title: record.title,
    description: record.description ?? undefined,
    priority: record.priority ?? undefined,
    labelIds: record.labelIds ?? undefined,
    parentId: record.parentId ?? null,
    assignment: record.assignment ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toWorkStickyPayload(record: WorkStickyRecord): WorkSticky {
  return {
    id: record.id,
    projectKey: record.projectKey,
    body: record.content,
    color: record.color ?? null,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toWorkViewPayload(record: WorkViewRecord): WorkView {
  return {
    id: record.id,
    projectKey: record.projectKey,
    name: record.name,
    filters: record.filters ?? null,
    groupBy: record.groupBy ?? null,
    orderBy: record.orderBy ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Activity rows are read by humans, so an object must not render as "[object Object]". */
function formatActivityValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export class WorkService {
  private readonly store: WorkStore;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly missionControlService: MissionControlService | null;
  private readonly peerManager: PeerManager | null;
  private readonly projectRegistry: ProjectRegistry;
  private readonly dispatcher: WorkDispatcher | null;
  private readonly fleet: WorkFleet | null;
  private readonly hostName: string;
  private readonly fleetIdIndex: FleetIdIndex;

  constructor(deps: WorkServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger.child
      ? (deps.logger.child({ module: "work", component: "service" }) as Logger)
      : deps.logger;
    this.agentManager = deps.agentManager;
    this.missionControlService = deps.missionControlService;
    this.peerManager = deps.peerManager;
    this.projectRegistry = deps.projectRegistry;
    this.dispatcher = deps.dispatcher;
    this.fleet = deps.fleet;
    this.hostName = deps.hostName;
    this.fleetIdIndex = new FleetIdIndex({
      agentManager: this.agentManager,
      projectRegistry: this.projectRegistry,
      peerManager: this.peerManager,
      logger: this.logger,
    });
  }

  /** Live-push fan-out: forward store mutations to every subscribed session. */
  subscribeToMutations(
    listener: (mutation: WorkStoreMutation) => void | Promise<void>,
  ): () => void {
    return this.store.subscribeToMutations(listener);
  }

  private async getBucket(agentId: string | null): Promise<LifecycleBucket | null> {
    if (!agentId) return null;
    if (this.missionControlService) {
      try {
        const bucket = await this.missionControlService.getLifecycleBucket(agentId);
        return bucket as LifecycleBucket;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async toWire(item: WorkItemRecord): Promise<WorkItem> {
    const bucket = await this.getBucket(item.agentId ?? null);
    const project = await this.store.getProjectByKey(item.projectKey);
    // Local item should always have its project in the local store. If it does
    // not, treat it as a programmer error rather than fabricating a key from
    // the raw projectKey (which would give e.g. "HOST:SRV_UAT-2" instead of
    // "MACBOOK-2" for cross-host items, and would hide the missing-project bug
    // for genuinely local items).
    if (!project) {
      throw new Error(`work_item_missing_project:${item.projectKey}`);
    }
    const humanKey = `${project.identifier}-${item.sequenceId}`;
    const children = await this.store.listChildren(item.id);
    const subItemCount = children.length > 0 ? children.length : undefined;
    return toWorkItemPayload(item, bucket, humanKey, subItemCount);
  }

  // toWire throws when a local item has lost its project record. That is a real
  // defect, but one broken item must not blank the whole board, so drop it from
  // the list and log instead of failing the response.
  private async toWireMany(items: WorkItemRecord[]): Promise<WorkItem[]> {
    const wired = await Promise.all(
      items.map(async (item) => {
        try {
          return await this.toWire(item);
        } catch (error) {
          this.logger.warn({ err: error, itemId: item.id }, "Skipped work item without a project");
          return null;
        }
      }),
    );
    return wired.filter((item): item is WorkItem => item !== null);
  }

  // -------------------------------------------------------------------------
  // Fleet reads
  // -------------------------------------------------------------------------

  async listProjects(opts?: { localOnly?: boolean }): Promise<{ hosts: WorkProjectHostEntry[] }> {
    if (!opts?.localOnly && this.fleet) {
      const fleetHosts = await this.fleet.listProjectsFleet();
      const hosts: WorkProjectHostEntry[] = fleetHosts.map((entry) => {
        if (entry.kind === "local") {
          return {
            host: entry.host,
            reachable: entry.reachable,
            projects: entry.projects.map(toWorkProjectPayload),
          };
        }
        // Peer entry already contains wire payloads from the owning host — pass through unchanged.
        return {
          host: entry.host,
          reachable: entry.reachable,
          projects: entry.projects,
        };
      });
      return { hosts };
    }
    const projects = await this.store.listProjects();
    return {
      hosts: [
        { host: this.hostName, reachable: true, projects: projects.map(toWorkProjectPayload) },
      ],
    };
  }

  async listItems(
    projectKey: string,
    opts?: { localOnly?: boolean },
  ): Promise<{ projectKey: string; hosts: WorkItemHostEntry[] }> {
    if (!opts?.localOnly && this.fleet) {
      const raw = await this.fleet.listItemsFleet(projectKey);
      const hosts: WorkItemHostEntry[] = await Promise.all(
        raw.map(async (entry) => {
          if (!entry.reachable) {
            return { host: entry.host, reachable: false as const, items: [] };
          }
          if (entry.kind === "peer") {
            // Already wired by the owning host (correct humanKey/bucket/subItemCount) — must not re-derive against local store.
            return { host: entry.host, reachable: true as const, items: entry.items };
          }
          return {
            host: entry.host,
            reachable: true as const,
            items: await this.toWireMany(entry.items),
          };
        }),
      );
      return { projectKey, hosts };
    }
    const items = await this.store.listItems({ projectKey });
    return {
      projectKey,
      hosts: [{ host: this.hostName, reachable: true, items: await this.toWireMany(items) }],
    };
  }

  // -------------------------------------------------------------------------
  // Single reads (with optional forward)
  // -------------------------------------------------------------------------

  async getItem(id: string): Promise<{ detail: WorkItemDetail | null }> {
    const item = await this.store.getItem(id);
    if (!item) {
      const host = await this.resolveHostForId(id);
      if (host !== null && host !== "local") {
        return this.forwardToPeer<{ detail: WorkItemDetail | null }>(
          host,
          "work.item.get.request",
          { id },
        );
      }
      return { detail: null };
    }
    const wire = await this.toWire(item);
    const comments = (await this.store.listComments(id)).map(toWorkCommentPayload);
    const activity = (await this.store.listActivity(id)).map(toWorkActivityPayload);
    const children = await this.store.listChildren(id);
    const subItems = await this.toWireMany(children);
    return { detail: { item: wire, comments, activity, subItems } };
  }

  // -------------------------------------------------------------------------
  // Mutations (with FleetIdIndex forward)
  // -------------------------------------------------------------------------

  private async forwardToPeer<T>(
    host: string,
    _type: string,
    _payload: Record<string, unknown>,
  ): Promise<T> {
    const client = this.peerManager?.getPeerClient(host);
    if (!client)
      throw buildPeerUnreachableError(
        host,
        this.peerManager?.getPeerStatus(host)?.lastSeenAt ?? null,
      );
    const status = this.peerManager?.getPeerStatus(host);
    if (!status || status.state !== "online")
      throw buildPeerUnreachableError(host, status?.lastSeenAt ?? null);
    const maybeSend = Reflect.get(client as object, "sendCorrelatedSessionRequest");
    if (typeof maybeSend === "function") {
      const payload = _payload as Record<string, unknown>;
      const messageType = _type as string;
      const responseType = messageType.replace(/\.request$/, ".response") as string;
      const res = await (maybeSend as (this: unknown, p: unknown) => Promise<unknown>).call(
        client,
        {
          message: { type: messageType, ...payload },
          responseType,
        },
      );
      if (res !== null && typeof res === "object") {
        const maybe = res as Record<string, unknown>;
        if ("item" in maybe || "detail" in maybe || "success" in maybe || "comment" in maybe)
          return res as T;
        if ("payload" in maybe) return (maybe["payload"] as T) ?? (res as T);
      }
      return res as T;
    }
    throw new Error(`Forward not supported for ${host}`);
  }

  private async resolveHostForProjectKey(projectKey: string): Promise<string | null> {
    const project = await this.store.getProjectByKey(projectKey);
    if (project) return "local";
    const match = projectKey.match(/^host:([^:]+):/);
    if (match) {
      const serverId = match[1];
      const peerName = this.peerManager?.resolvePeerName(serverId);
      if (peerName) return peerName;
    }
    if (this.fleet) {
      const entries = await this.fleet.listProjectsFleet();
      for (const entry of entries) {
        if (entry.reachable && entry.projects.some((p) => p.projectKey === projectKey)) {
          return entry.host;
        }
      }
    }
    return null;
  }

  private async isLocalEntity(id: string): Promise<boolean> {
    if (id.startsWith("wit_")) {
      return (await this.store.getItem(id)) !== null;
    }
    if (id.startsWith("wpg_")) {
      return (await this.store.getPage(id)) !== null;
    }
    if (id.startsWith("wdr_")) {
      return (await this.store.getDraft(id)) !== null;
    }
    if (id.startsWith("wst_")) {
      const all = await this.store.listProjects();
      for (const p of all) {
        const stickies = await this.store.listStickies(p.projectKey);
        if (stickies.some((s) => s.id === id)) return true;
      }
      return false;
    }
    if (id.startsWith("wvw_")) {
      const all = await this.store.listProjects();
      for (const p of all) {
        const views = await this.store.listViews(p.projectKey);
        if (views.some((v) => v.id === id)) return true;
      }
      return false;
    }
    return (await this.store.getItem(id)) !== null;
  }

  private async probePeerForWorkItem(peerName: string, id: string): Promise<boolean> {
    try {
      const res = await this.forwardToPeer<{ detail?: { item: unknown } | null }>(
        peerName,
        "work.item.get.request",
        { id },
      );
      return Boolean(res?.detail?.item);
    } catch {
      return false;
    }
  }

  private async findPeerForId(id: string): Promise<string | null> {
    if (!this.peerManager) return null;
    for (const status of this.peerManager.getPeerStatuses()) {
      if (status.state !== "online") continue;
      if (!id.startsWith("wit_")) return status.name;
      const found = await this.probePeerForWorkItem(status.name, id);
      if (found) return status.name;
    }
    return null;
  }

  private async resolveHostForId(id: string): Promise<string | null> {
    if (await this.isLocalEntity(id)) return "local";
    const peerHost = await this.findPeerForId(id);
    if (peerHost) return peerHost;
    try {
      const r = await this.fleetIdIndex.resolveFleetId(id);
      return r.kind === "unknown" ? null : r.host;
    } catch {
      return null;
    }
  }

  async createItem(input: {
    projectKey: string;
    title: string;
    description?: string;
    priority?: WorkItemRecord["priority"];
    labelIds?: string[];
    parentId?: string | null;
    lane?: WorkItemRecord["lane"];
    assignment?: WorkAssignment | null;
    sortOrder?: number;
  }): Promise<{ item: WorkItem | null; error: string | null }> {
    const host = await this.resolveHostForProjectKey(input.projectKey);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ item: WorkItem | null; error: string | null }>(
        host,
        "work.item.create.request",
        input as Record<string, unknown>,
      );
    }
    const project = await this.store.getProjectByKey(input.projectKey);
    if (!project) {
      return { item: null, error: "work_project_requires_paseo_project" };
    }
    try {
      const created = await this.store.createItem({
        projectKey: input.projectKey,
        projectId: project.projectId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        labelIds: input.labelIds,
        parentId: input.parentId ?? null,
        lane: input.lane,
        assignment: normalizeWorkAssignment(input.assignment),
        sortOrder: input.sortOrder,
      });
      await this.store.appendActivity({
        itemId: created.id,
        projectKey: created.projectKey,
        verb: "created",
        field: null,
        oldValue: null,
        newValue: created.title,
        actorKind: "user",
        actorId: null,
      });
      return { item: await this.toWire(created), error: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("work_project_requires_paseo_project")) {
        return { item: null, error: "work_project_requires_paseo_project" };
      }
      throw error;
    }
  }

  async updateItem(
    id: string,
    patch: {
      title?: string;
      description?: string;
      priority?: WorkItemRecord["priority"];
      labelIds?: string[];
      parentId?: string | null;
      assignment?: WorkAssignment | null;
      lane?: WorkItemRecord["lane"];
    },
  ): Promise<{ item: WorkItem | null; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      const p: Record<string, unknown> = { id, ...patch };
      return this.forwardToPeer<{ item: WorkItem | null; error: string | null }>(
        host,
        "work.item.update.request",
        p,
      );
    }
    const before = await this.store.getItem(id);
    if (!before) return { item: null, error: "not_found" };
    const updated = await this.store.updateItem(id, (rec) => ({
      ...rec,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.labelIds !== undefined ? { labelIds: patch.labelIds } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.assignment !== undefined
        ? { assignment: normalizeWorkAssignment(patch.assignment) }
        : {}),
      ...(patch.lane !== undefined ? { lane: patch.lane } : {}),
    }));
    if (!updated) return { item: null, error: "not_found" };
    for (const field of Object.keys(patch) as Array<keyof typeof patch>) {
      const oldVal = (before as Record<string, unknown>)[field as string];
      const newVal = (updated as Record<string, unknown>)[field as string];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        await this.store.appendActivity({
          itemId: id,
          projectKey: updated.projectKey,
          verb: "updated",
          field: String(field),
          oldValue: formatActivityValue(oldVal),
          newValue: formatActivityValue(newVal),
          actorKind: "user",
          actorId: null,
        });
      }
    }
    return { item: await this.toWire(updated), error: null };
  }

  async deleteItem(id: string): Promise<{ success: boolean; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ success: boolean; error: string | null }>(
        host,
        "work.item.delete.request",
        { id },
      );
    }
    const existing = await this.store.getItem(id);
    if (!existing) return { success: false, error: "not_found" };
    await this.store.deleteItem(id);
    await this.store.appendActivity({
      itemId: id,
      projectKey: existing.projectKey,
      verb: "deleted",
      field: null,
      oldValue: existing.title,
      newValue: null,
      actorKind: "user",
      actorId: null,
    });
    return { success: true, error: null };
  }

  async moveItem(input: {
    id: string;
    targetColumn: string;
    sortOrder?: number;
  }): Promise<{ item: WorkItem | null; rebalanced?: WorkItem[]; error: string | null }> {
    const host = await this.resolveHostForId(input.id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{
        item: WorkItem | null;
        rebalanced?: WorkItem[];
        error: string | null;
      }>(host, "work.item.move.request", {
        id: input.id,
        targetColumn: input.targetColumn,
        sortOrder: input.sortOrder,
      });
    }
    const item = await this.store.getItem(input.id);
    if (!item) return { item: null, error: "not_found" };
    const bucket = await this.getBucket(item.agentId ?? null);
    const intent = resolveWorkMoveIntent({
      item: { lane: item.lane, closed: item.closed, agentId: item.agentId ?? null },
      targetColumn: input.targetColumn as Parameters<
        typeof resolveWorkMoveIntent
      >[0]["targetColumn"],
      agentBucket: bucket,
    });

    if (intent.kind === "reject") {
      return { item: null, error: intent.reason };
    }

    // Reordering uses computeSortOrder: a drop without an explicit order derives
    // a fractional gap from the target column's neighbours; a drop with one is
    // persisted as-is. The server rebalances only when the resulting gap falls
    // below 1 (float-exhaustion guard, spec 2.2).
    const sortOrder = await this.resolveSortOrder(item, input.targetColumn, input.sortOrder);

    if (intent.kind === "set_lane") {
      return this.applySetLane(input.id, item, intent.lane, sortOrder);
    }
    if (intent.kind === "detach_agent") {
      return this.applyDetachAgent(input.id, item, sortOrder);
    }
    if (intent.kind === "dispatch_now") {
      return this.applyDispatchNow(input.id, item, sortOrder);
    }
    if (intent.kind === "set_review_state") {
      return this.applySetReviewState(input.id, item, intent.reviewState, sortOrder);
    }

    return { item: null, error: "unknown intent" };
  }

  private async applySetLane(
    id: string,
    item: WorkItemRecord,
    lane: WorkItemRecord["lane"],
    sortOrder: number,
  ): Promise<{ item: WorkItem | null; rebalanced?: WorkItem[]; error: string | null }> {
    const beforeLane = item.lane;
    const updated = await this.store.updateItem(id, (rec) => ({ ...rec, lane, sortOrder }));
    if (!updated) return { item: null, error: "not_found" };
    await this.store.appendActivity({
      itemId: id,
      projectKey: updated.projectKey,
      verb: "moved",
      field: "lane",
      oldValue: beforeLane,
      newValue: lane,
      actorKind: "user",
      actorId: null,
    });
    const rebalanced = await this.maybeRebalance(updated, sortOrder);
    return { item: await this.toWire(updated), ...(rebalanced ? { rebalanced } : {}), error: null };
  }

  private async applyDetachAgent(
    id: string,
    item: WorkItemRecord,
    sortOrder: number,
  ): Promise<{ item: WorkItem | null; rebalanced?: WorkItem[]; error: string | null }> {
    const updated = await this.store.updateItem(id, (rec) => ({
      ...rec,
      lane: "backlog" as const,
      agentId: null,
      agentHost: null,
      sortOrder,
    }));
    if (!updated) return { item: null, error: "not_found" };
    await this.store.appendActivity({
      itemId: id,
      projectKey: updated.projectKey,
      verb: "detached",
      field: "agentId",
      oldValue: item.agentId ?? null,
      newValue: null,
      actorKind: "user",
      actorId: null,
    });
    const rebalanced = await this.maybeRebalance(updated, sortOrder);
    return { item: await this.toWire(updated), ...(rebalanced ? { rebalanced } : {}), error: null };
  }

  private async applyDispatchNow(
    id: string,
    item: WorkItemRecord,
    sortOrder: number,
  ): Promise<{ item: WorkItem | null; rebalanced?: WorkItem[]; error: string | null }> {
    if (this.dispatcher) {
      await this.dispatcher.dispatchNow(id);
    }
    const after = (await this.store.getItem(id)) ?? item;
    await this.store.updateItem(id, (rec) => ({ ...rec, sortOrder }));
    await this.store.appendActivity({
      itemId: id,
      projectKey: after.projectKey,
      verb: "dispatched",
      field: null,
      oldValue: null,
      newValue: null,
      actorKind: "user",
      actorId: null,
    });
    const refreshed = (await this.store.getItem(id)) ?? after;
    const rebalanced = await this.maybeRebalance(refreshed, sortOrder);
    return {
      item: await this.toWire(refreshed),
      ...(rebalanced ? { rebalanced } : {}),
      error: null,
    };
  }

  private async applySetReviewState(
    id: string,
    item: WorkItemRecord,
    reviewState: "ready" | "done",
    sortOrder: number,
  ): Promise<{ item: WorkItem | null; rebalanced?: WorkItem[]; error: string | null }> {
    // Only in_review needs a live agent to mark ready. Done is always allowed
    // (spec 2.1): an item with no agent just closes, with no review state to write.
    if (reviewState === "ready" && !item.agentId) {
      return { item: null, error: "in_review requires a linked agent" };
    }
    if (item.agentId && this.missionControlService) {
      await this.missionControlService.setReviewState(item.agentId, reviewState);
    }
    let updated: WorkItemRecord | null = item;
    if (reviewState === "done") {
      const now = new Date().toISOString();
      updated = await this.store.updateItem(id, (rec) => ({
        ...rec,
        closed: { state: "done", at: now },
        sortOrder,
      }));
    } else {
      updated = await this.store.updateItem(id, (rec) => ({ ...rec, sortOrder }));
    }
    if (!updated) return { item: null, error: "not_found" };
    await this.store.appendActivity({
      itemId: id,
      projectKey: updated.projectKey,
      verb: "review_state",
      field: "reviewState",
      oldValue: null,
      newValue: reviewState,
      actorKind: "user",
      actorId: null,
    });
    const rebalanced = await this.maybeRebalance(updated, sortOrder);
    return { item: await this.toWire(updated), ...(rebalanced ? { rebalanced } : {}), error: null };
  }

  /** Fractional gap between neighbours (Plane's 65535-gap algorithm, spec 2.2). */
  private async resolveSortOrder(
    item: WorkItemRecord,
    targetColumn: string,
    requested: number | undefined,
  ): Promise<number> {
    if (requested !== undefined) return requested;
    const all = await this.store.listItems({ projectKey: item.projectKey });
    const columnItems: Array<{ record: WorkItemRecord; order: number }> = [];
    for (const entry of all) {
      if (entry.id === item.id) continue;
      const b = await this.getBucket(entry.agentId ?? null);
      const col = deriveWorkColumn(entry, b);
      if (col !== targetColumn) continue;
      columnItems.push({ record: entry, order: entry.sortOrder });
    }
    columnItems.sort((a, b) => a.order - b.order);
    const prev = columnItems.findLast((e) => e.order < 65535)?.order ?? null;
    const next = columnItems.find((e) => e.order >= 65535)?.order ?? null;
    return computeSortOrder({ prevSortOrder: prev, nextSortOrder: next });
  }

  private async maybeRebalance(
    item: WorkItemRecord,
    resolvedSortOrder: number,
  ): Promise<WorkItem[] | undefined> {
    const bucket = await this.getBucket(item.agentId ?? null);
    const column = deriveWorkColumn(item, bucket);
    const all = await this.store.listItems({ projectKey: item.projectKey });
    const columnItems = await Promise.all(
      all.map(async (entry) => ({ entry, bucket: await this.getBucket(entry.agentId ?? null) })),
    );
    const filtered = columnItems
      .filter(({ entry, bucket: b }) => deriveWorkColumn(entry, b) === column)
      .map(({ entry }) => entry)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    // The moved item's resolved order participates in the gap check: a drop
    // that exhausts float precision (gap < 1, Plane's bug we decline to
    // inherit) triggers an even-65535 rebalance of the whole column.
    const sortedOrders = [resolvedSortOrder, ...filtered.map((r) => r.sortOrder)].sort(
      (a, b) => a - b,
    );
    let minGap = Infinity;
    for (let i = 1; i < sortedOrders.length; i++) {
      const gap = sortedOrders[i] - sortedOrders[i - 1];
      if (gap < minGap) minGap = gap;
    }
    if (sortedOrders.length > 1 && needsSortOrderRebalance(minGap)) {
      const orderedIds = filtered.map((r) => r.id);
      const rebalancedOrders = await this.store.reorderItems(
        item.projectKey,
        String(column),
        orderedIds,
      );
      const rebalancedWires: WorkItem[] = [];
      for (const id of orderedIds) {
        const rec = await this.store.getItem(id);
        if (rec) {
          // Update with rebalanced order is already persisted; reflect it
          const wire = await this.toWire({
            ...rec,
            sortOrder: rebalancedOrders[id] ?? rec.sortOrder,
          });
          rebalancedWires.push(wire);
        }
      }
      return rebalancedWires;
    }
    return undefined;
  }

  async dispatchItem(id: string): Promise<{ item: WorkItem | null; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ item: WorkItem | null; error: string | null }>(
        host,
        "work.item.dispatch.request",
        { id },
      );
    }
    const item = await this.store.getItem(id);
    if (!item) return { item: null, error: "not_found" };
    if (this.dispatcher) {
      await this.dispatcher.dispatchNow(id);
    }
    await this.store.appendActivity({
      itemId: id,
      projectKey: item.projectKey,
      verb: "dispatched",
      field: null,
      oldValue: null,
      newValue: null,
      actorKind: "user",
      actorId: null,
    });
    const after = (await this.store.getItem(id)) ?? item;
    return { item: await this.toWire(after), error: null };
  }

  // -------------------------------------------------------------------------
  // Comments / Activity
  // -------------------------------------------------------------------------

  async listComments(itemId: string): Promise<{ itemId: string; comments: WorkComment[] }> {
    const host = await this.resolveHostForId(itemId);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ itemId: string; comments: WorkComment[] }>(
        host,
        "work.comment.list.request",
        { itemId },
      );
    }
    const comments = (await this.store.listComments(itemId)).map(toWorkCommentPayload);
    return { itemId, comments };
  }

  async createComment(
    itemId: string,
    body: string,
  ): Promise<{ comment: WorkComment | null; error: string | null }> {
    const host = await this.resolveHostForId(itemId);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ comment: WorkComment | null; error: string | null }>(
        host,
        "work.comment.create.request",
        { itemId, body },
      );
    }
    const item = await this.store.getItem(itemId);
    if (!item) return { comment: null, error: "not_found" };
    const comment = await this.store.appendComment({
      itemId,
      projectKey: item.projectKey,
      body,
      authorKind: "user",
      authorId: null,
    });
    await this.store.appendActivity({
      itemId,
      projectKey: item.projectKey,
      verb: "commented",
      field: "comment",
      oldValue: null,
      newValue: body.slice(0, 120),
      actorKind: "user",
      actorId: null,
    });
    return { comment: toWorkCommentPayload(comment), error: null };
  }

  async listActivity(itemId: string): Promise<{ itemId: string; activity: WorkActivity[] }> {
    const host = await this.resolveHostForId(itemId);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ itemId: string; activity: WorkActivity[] }>(
        host,
        "work.activity.list.request",
        { itemId },
      );
    }
    const activity = (await this.store.listActivity(itemId)).map(toWorkActivityPayload);
    return { itemId, activity };
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async listLabels(projectKey: string): Promise<{ projectKey: string; labels: WorkLabel[] }> {
    const labels = (await this.store.listLabels(projectKey)).map(toWorkLabelPayload);
    return { projectKey, labels };
  }

  async upsertLabel(
    projectKey: string,
    label: { id?: string; name: string; color: string; sortOrder?: number },
  ): Promise<{ label: WorkLabel | null; error: string | null }> {
    const id = label.id ?? undefined;
    if (id) {
      const host = await this.resolveHostForId(id);
      if (host !== null && host !== "local") {
        return this.forwardToPeer<{ label: WorkLabel | null; error: string | null }>(
          host,
          "work.label.upsert.request",
          { projectKey, label },
        );
      }
    }
    const existing = id
      ? await this.store.listLabels(projectKey).then((ls) => ls.find((l) => l.id === id))
      : null;
    let record: WorkLabelRecord;
    if (existing) {
      record = {
        ...existing,
        name: label.name,
        color: label.color,
        sortOrder: label.sortOrder ?? existing.sortOrder,
        updatedAt: new Date().toISOString(),
      };
    } else {
      record = await this.store.createLabel({
        projectKey,
        name: label.name,
        color: label.color,
        sortOrder: label.sortOrder,
      });
      return { label: toWorkLabelPayload(record), error: null };
    }
    const saved = await this.store.upsertLabel(record);
    await this.store.appendActivity({
      itemId: saved.id,
      projectKey,
      verb: existing ? "label_updated" : "label_created",
      field: "label",
      oldValue: existing?.name ?? null,
      newValue: saved.name,
      actorKind: "user",
      actorId: null,
    });
    return { label: toWorkLabelPayload(saved), error: null };
  }

  async deleteLabel(id: string): Promise<{ success: boolean; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ success: boolean; error: string | null }>(
        host,
        "work.label.delete.request",
        { id },
      );
    }
    // Find label to know projectKey for activity
    const allProjects = await this.store.listProjects();
    let projectKey: string | null = null;
    for (const p of allProjects) {
      const labels = await this.store.listLabels(p.projectKey);
      if (labels.some((l) => l.id === id)) {
        projectKey = p.projectKey;
        break;
      }
    }
    await this.store.deleteLabel(id);
    if (projectKey) {
      await this.store.appendActivity({
        itemId: id,
        projectKey,
        verb: "label_deleted",
        field: "label",
        oldValue: id,
        newValue: null,
        actorKind: "user",
        actorId: null,
      });
    }
    return { success: true, error: null };
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  async listPages(projectKey: string): Promise<{ projectKey: string; pages: WorkPage[] }> {
    const pages = (await this.store.listPages(projectKey)).map(toWorkPagePayload);
    return { projectKey, pages };
  }

  async getPage(id: string): Promise<{ page: WorkPage | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ page: WorkPage | null }>(host, "work.page.get.request", { id });
    }
    const page = await this.store.getPage(id);
    return { page: page ? toWorkPagePayload(page) : null };
  }

  async upsertPage(
    projectKey: string,
    page: {
      id?: string;
      title: string;
      body: string;
      parentId?: string | null;
      sortOrder?: number;
    },
  ): Promise<{ page: WorkPage | null; error: string | null }> {
    const id = page.id ?? undefined;
    if (id) {
      const host = await this.resolveHostForId(id);
      if (host !== null && host !== "local") {
        return this.forwardToPeer<{ page: WorkPage | null; error: string | null }>(
          host,
          "work.page.upsert.request",
          { projectKey, page },
        );
      }
    }
    let record: WorkPageRecord;
    if (id) {
      const existing = await this.store.getPage(id);
      if (existing) {
        record = {
          ...existing,
          title: page.title,
          content: page.body,
          parentId: page.parentId ?? existing.parentId ?? null,
          sortOrder: page.sortOrder ?? existing.sortOrder,
          updatedAt: new Date().toISOString(),
        };
        const saved = await this.store.upsertPage(record);
        await this.store.appendActivity({
          itemId: saved.id,
          projectKey,
          verb: "page_updated",
          field: "page",
          oldValue: existing.title,
          newValue: saved.title,
          actorKind: "user",
          actorId: null,
        });
        return { page: toWorkPagePayload(saved), error: null };
      }
    }
    record = await this.store.createPage({
      projectKey,
      title: page.title,
      content: page.body,
      parentId: page.parentId ?? null,
      sortOrder: page.sortOrder,
    });
    await this.store.appendActivity({
      itemId: record.id,
      projectKey,
      verb: "page_created",
      field: "page",
      oldValue: null,
      newValue: record.title,
      actorKind: "user",
      actorId: null,
    });
    return { page: toWorkPagePayload(record), error: null };
  }

  async deletePage(id: string): Promise<{ success: boolean; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ success: boolean; error: string | null }>(
        host,
        "work.page.delete.request",
        { id },
      );
    }
    const existing = await this.store.getPage(id);
    await this.store.deletePage(id);
    if (existing) {
      await this.store.appendActivity({
        itemId: id,
        projectKey: existing.projectKey,
        verb: "page_deleted",
        field: "page",
        oldValue: existing.title,
        newValue: null,
        actorKind: "user",
        actorId: null,
      });
    }
    return { success: true, error: null };
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  async listDrafts(projectKey: string): Promise<{ projectKey: string; drafts: WorkDraft[] }> {
    const drafts = (await this.store.listDrafts(projectKey)).map(toWorkDraftPayload);
    return { projectKey, drafts };
  }

  async createDraft(input: {
    projectKey: string;
    title: string;
    description?: string;
    priority?: WorkDraftRecord["priority"];
    labelIds?: string[];
    parentId?: string | null;
    assignment?: WorkAssignment | null;
  }): Promise<{ draft: WorkDraft | null; error: string | null }> {
    try {
      const draft = await this.store.createDraft({
        projectKey: input.projectKey,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? null,
        labelIds: input.labelIds ?? [],
        parentId: input.parentId ?? null,
        assignment: normalizeWorkAssignment(input.assignment),
      });
      return { draft: toWorkDraftPayload(draft), error: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { draft: null, error: msg };
    }
  }

  async promoteDraft(id: string): Promise<{ item: WorkItem | null; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ item: WorkItem | null; error: string | null }>(
        host,
        "work.draft.promote.request",
        { id },
      );
    }
    try {
      const item = await this.store.promoteDraft(id);
      await this.store.appendActivity({
        itemId: item.id,
        projectKey: item.projectKey,
        verb: "draft_promoted",
        field: "draft",
        oldValue: id,
        newValue: item.id,
        actorKind: "user",
        actorId: null,
      });
      return { item: await this.toWire(item), error: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("work_project_requires_paseo_project"))
        return { item: null, error: "work_project_requires_paseo_project" };
      return { item: null, error: msg };
    }
  }

  // -------------------------------------------------------------------------
  // Stickies
  // -------------------------------------------------------------------------

  async listStickies(projectKey: string): Promise<{ projectKey: string; stickies: WorkSticky[] }> {
    const stickies = (await this.store.listStickies(projectKey)).map(toWorkStickyPayload);
    return { projectKey, stickies };
  }

  async upsertSticky(
    projectKey: string,
    sticky: { id?: string; body: string; color?: string | null; sortOrder?: number },
  ): Promise<{ sticky: WorkSticky | null; error: string | null }> {
    const id = sticky.id ?? undefined;
    if (id) {
      const host = await this.resolveHostForId(id);
      if (host !== null && host !== "local") {
        return this.forwardToPeer<{ sticky: WorkSticky | null; error: string | null }>(
          host,
          "work.sticky.upsert.request",
          { projectKey, sticky },
        );
      }
    }
    let record: WorkStickyRecord;
    if (id) {
      const existing = await this.store
        .listStickies(projectKey)
        .then((ls) => ls.find((s) => s.id === id));
      if (existing) {
        record = {
          ...existing,
          content: sticky.body,
          color: sticky.color ?? existing.color ?? null,
          sortOrder: sticky.sortOrder ?? existing.sortOrder,
          updatedAt: new Date().toISOString(),
        };
        const saved = await this.store.upsertSticky(record);
        await this.store.appendActivity({
          itemId: saved.id,
          projectKey,
          verb: "sticky_updated",
          field: "sticky",
          oldValue: existing.content.slice(0, 40),
          newValue: saved.content.slice(0, 40),
          actorKind: "user",
          actorId: null,
        });
        return { sticky: toWorkStickyPayload(saved), error: null };
      }
    }
    record = await this.store.createSticky({
      projectKey,
      content: sticky.body,
      color: sticky.color ?? null,
      sortOrder: sticky.sortOrder,
    });
    await this.store.appendActivity({
      itemId: record.id,
      projectKey,
      verb: "sticky_created",
      field: "sticky",
      oldValue: null,
      newValue: record.content.slice(0, 40),
      actorKind: "user",
      actorId: null,
    });
    return { sticky: toWorkStickyPayload(record), error: null };
  }

  async deleteSticky(id: string): Promise<{ success: boolean; error: string | null }> {
    const host = await this.resolveHostForId(id);
    if (host !== null && host !== "local") {
      return this.forwardToPeer<{ success: boolean; error: string | null }>(
        host,
        "work.sticky.delete.request",
        { id },
      );
    }
    let projectKey: string | null = null;
    const all = await this.store.listProjects();
    for (const p of all) {
      const s = await this.store.listStickies(p.projectKey);
      if (s.some((x) => x.id === id)) {
        projectKey = p.projectKey;
        break;
      }
    }
    await this.store.deleteSticky(id);
    if (projectKey) {
      await this.store.appendActivity({
        itemId: id,
        projectKey,
        verb: "sticky_deleted",
        field: "sticky",
        oldValue: id,
        newValue: null,
        actorKind: "user",
        actorId: null,
      });
    }
    return { success: true, error: null };
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  async listViews(projectKey: string): Promise<{ projectKey: string; views: WorkView[] }> {
    const views = (await this.store.listViews(projectKey)).map(toWorkViewPayload);
    return { projectKey, views };
  }

  async upsertView(
    projectKey: string,
    view: {
      id?: string;
      name: string;
      filters?: Record<string, unknown> | null;
      groupBy?: string | null;
      orderBy?: string | null;
    },
  ): Promise<{ view: WorkView | null; error: string | null }> {
    const id = view.id ?? undefined;
    if (id) {
      const host = await this.resolveHostForId(id);
      if (host !== null && host !== "local") {
        return this.forwardToPeer<{ view: WorkView | null; error: string | null }>(
          host,
          "work.view.upsert.request",
          { projectKey, view },
        );
      }
    }
    let record: WorkViewRecord;
    if (id) {
      const existing = await this.store
        .listViews(projectKey)
        .then((ls) => ls.find((v) => v.id === id));
      if (existing) {
        record = {
          ...existing,
          name: view.name,
          filters: view.filters ?? existing.filters ?? null,
          groupBy: view.groupBy ?? existing.groupBy ?? null,
          orderBy: view.orderBy ?? existing.orderBy ?? null,
          updatedAt: new Date().toISOString(),
        };
        const saved = await this.store.upsertView(record);
        return { view: toWorkViewPayload(saved), error: null };
      }
    }
    record = await this.store.createView({
      projectKey,
      name: view.name,
      filters: view.filters ?? null,
      groupBy: view.groupBy ?? null,
      orderBy: view.orderBy ?? null,
    });
    return { view: toWorkViewPayload(record), error: null };
  }
}
