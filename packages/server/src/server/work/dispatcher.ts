import type { Logger } from "pino";
import type { MissionControlApprovals } from "../mission-control/approvals.js";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { WorkStore, WorkStoreMutation } from "./store.js";
import type { WorkCommentRecord, WorkItemRecord, WorkProjectRecord } from "./model.js";

export interface WorkDispatcherDeps {
  store: WorkStore;
  logger: Logger;
  concurrency: number;
  approvals: MissionControlApprovals;
  workspaces: WorkspaceRegistry;
}

export interface WorkBriefInput {
  item: WorkItemRecord;
  project: WorkProjectRecord | null;
  parentItem: WorkItemRecord | null;
  subItems: WorkItemRecord[];
  comments: WorkCommentRecord[];
  humanKey: string;
}

export function renderWorkItemBrief(input: WorkBriefInput): string {
  const { item, project, parentItem, subItems, comments, humanKey } = input;
  const lines: string[] = [];
  lines.push(`# Work item ${humanKey}: ${item.title}`);
  lines.push("");
  lines.push(`- id: ${item.id}`);
  lines.push(`- key: ${humanKey}`);
  lines.push(`- project: ${project?.displayName ?? item.projectKey} (${item.projectKey})`);
  lines.push(`- priority: ${item.priority}`);
  lines.push(`- lane: ${item.lane}`);
  if (parentItem) lines.push(`- parent: ${parentItem.title} (${parentItem.id})`);
  lines.push("");
  lines.push("## Description");
  lines.push(item.description?.trim() ? item.description : "_No description._");
  lines.push("");
  if (subItems.length > 0) {
    lines.push("## Sub-items");
    for (const child of subItems) {
      lines.push(
        `- ${child.title} (${child.id}) — ${child.lane}${child.agentId ? ` · agent ${child.agentId}` : ""}`,
      );
    }
    lines.push("");
  }
  if (comments.length > 0) {
    lines.push("## Comments");
    for (const comment of comments) {
      lines.push(`- ${comment.body}`);
    }
    lines.push("");
  }
  lines.push("## Instructions");
  lines.push(
    "Comment progress on the work item with work_item_comment and call report_status at milestones.",
  );
  lines.push(
    "Keep the brief and acceptance criteria in scope; attach links or proofs with work_item_update.",
  );
  return lines.join("\n");
}

function deriveHumanKey(project: WorkProjectRecord | null, item: WorkItemRecord): string {
  const fallback = item.projectKey.slice(0, 12).toUpperCase() || "WORK";
  const identifier = project?.identifier ?? fallback;
  return `${identifier}-${item.sequenceId}`;
}

function isSpawnProposal(proposal: MissionControlProposal): boolean {
  return proposal.kind === "spawn";
}

function isPending(proposal: MissionControlProposal): boolean {
  return proposal.status === "pending";
}

function proposalTargetsItem(proposal: MissionControlProposal, itemId: string): boolean {
  if (!isSpawnProposal(proposal)) return false;
  return proposal.spawnPlan?.labels?.["paseo.work-item-id"] === itemId;
}

export class WorkDispatcher {
  private readonly store: WorkStore;
  private readonly logger: Logger;
  private concurrency: number;
  private readonly approvals: MissionControlApprovals;
  private readonly workspaces: WorkspaceRegistry;

  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeApprovals: (() => void) | null = null;
  private started = false;

  // Bounded pool: inFlight counts concurrent spawns, queue holds ids waiting for a slot.
  // Invariant: inFlight increments only when inFlight < concurrency, decrements in finally.
  private queue: string[] = [];
  private inFlight = 0;
  private readonly enqueued = new Set<string>();
  private readonly dispatching = new Set<string>();

  constructor(deps: WorkDispatcherDeps) {
    this.store = deps.store;
    this.logger = deps.logger.child({ module: "work", component: "dispatcher" });
    this.concurrency = Math.max(1, Math.floor(deps.concurrency) || 3);
    this.approvals = deps.approvals;
    this.workspaces = deps.workspaces;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeStore = this.store.subscribeToMutations((mutation) => {
      void this.handleMutation(mutation);
    });
    this.unsubscribeApprovals = this.approvals.onProposalChange((proposal) => {
      void this.handleProposalChange(proposal);
    });
    void this.sweepExistingTodo().catch((error) => {
      this.logger.error({ err: error }, "WorkDispatcher sweep failed");
    });
  }

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.floor(value) || 3);
    this.drain();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    if (this.unsubscribeApprovals) {
      this.unsubscribeApprovals();
      this.unsubscribeApprovals = null;
    }
    this.queue = [];
    this.enqueued.clear();
  }

  async dispatchNow(itemId: string): Promise<void> {
    const item = await this.store.getItem(itemId);
    if (!item) return;
    if (item.agentId) return;
    if (item.lane !== "todo" || !item.assignment) return;
    if (item.closed) return;
    if (this.dispatching.has(itemId)) return;
    if (this.findPendingProposalForItem(itemId)) return;
    await this.acquireSlotAndDispatch(itemId);
  }

  private async handleMutation(mutation: WorkStoreMutation): Promise<void> {
    if (mutation.entity !== "item") return;
    if (mutation.kind !== "upsert") return;
    const record = mutation.record as WorkItemRecord | null;
    if (!record) return;
    if (record.lane !== "todo") return;
    if (!record.assignment) return;
    if (record.agentId) return;
    if (record.closed) return;
    this.enqueue(record.id);
  }

  private enqueue(itemId: string): void {
    if (this.enqueued.has(itemId) || this.dispatching.has(itemId)) return;
    if (this.findPendingProposalForItem(itemId)) return;
    this.queue.push(itemId);
    this.enqueued.add(itemId);
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0 && this.inFlight < this.concurrency) {
      const next = this.queue.shift();
      if (!next) break;
      this.enqueued.delete(next);
      if (this.dispatching.has(next)) continue;
      if (this.findPendingProposalForItem(next)) continue;
      this.inFlight++;
      this.dispatching.add(next);
      const run = this.doDispatch(next)
        .catch((error) => {
          this.logger.error({ err: error, itemId: next }, "Work dispatch failed");
        })
        .finally(() => {
          this.inFlight--;
          this.dispatching.delete(next);
          this.drain();
        });
      void run;
    }
  }

  private async acquireSlotAndDispatch(itemId: string): Promise<void> {
    if (this.inFlight >= this.concurrency) {
      if (!this.enqueued.has(itemId) && !this.dispatching.has(itemId)) {
        this.queue.unshift(itemId);
        this.enqueued.add(itemId);
      }
      while (this.enqueued.has(itemId) || this.dispatching.has(itemId)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        this.drain();
        const item = await this.store.getItem(itemId);
        if (item?.agentId) break;
        if (this.findPendingProposalForItem(itemId)) break;
      }
      return;
    }
    this.inFlight++;
    this.dispatching.add(itemId);
    try {
      await this.doDispatch(itemId);
    } finally {
      this.inFlight--;
      this.dispatching.delete(itemId);
      this.drain();
    }
  }

  private async doDispatch(itemId: string): Promise<void> {
    const item = await this.store.getItem(itemId);
    if (!item) return;
    if (item.agentId) return;
    if (item.lane !== "todo" || !item.assignment) return;
    if (item.closed) return;

    const workspace = await this.resolveWorkspaceForItem(item);
    if (!workspace) {
      this.logger.warn({ itemId }, "Work dispatch has no workspace for project");
      return;
    }

    const project = await this.store.getProjectByKey(item.projectKey);
    const humanKey = deriveHumanKey(project, item);

    const [comments, subItems, parentItem] = await Promise.all([
      this.store.listComments(item.id),
      this.store.listChildren(item.id),
      item.parentId ? this.store.getItem(item.parentId) : Promise.resolve(null),
    ]);

    const brief = renderWorkItemBrief({
      item,
      project,
      parentItem: parentItem ?? null,
      subItems,
      comments,
      humanKey,
    });

    const targetHost = item.assignment.host?.trim() || null;
    const labels: Record<string, string> = {
      "paseo.work-item-id": item.id,
      "paseo.work-item-key": humanKey,
      "paseo.work-project-key": item.projectKey,
    };

    const isWorktree = item.assignment.isolation === "worktree";

    const proposal = await this.approvals.createProposal({
      origin: "commander",
      serverId: "local",
      targetAgentId: "",
      message: `Work ${humanKey}: ${item.title}: ${brief.slice(0, 200)}`,
      deliveryMode: "interrupt",
      reason: `Work auto-pickup ${humanKey}`,
      classification: "normal",
      kind: "spawn",
      spawnPlan: {
        provider: item.assignment.provider,
        ...(item.assignment.model ? { model: item.assignment.model } : {}),
        title: item.title,
        summary: `Work ${humanKey}: ${item.title}`,
        initialPrompt: brief,
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        ...(item.assignment.modeId ? { mode: item.assignment.modeId } : {}),
        ...(item.assignment.thinkingOptionId ? { thinking: item.assignment.thinkingOptionId } : {}),
        labels,
        background: true,
        ...(targetHost ? { host: targetHost } : {}),
        ...(isWorktree
          ? {
              worktree: {
                branchName: `work/${humanKey.toLowerCase()}`,
                worktreeName: `work-${humanKey.toLowerCase()}`,
              },
            }
          : {}),
      },
    });

    if (proposal.spawnedAgentId) {
      const spawnedHost = targetHost ?? proposal.spawnedOnServerId ?? null;
      await this.commitBinding(item, proposal.spawnedAgentId, spawnedHost);
    } else if (proposal.status === "pending") {
      this.logger.info(
        { itemId, proposalId: proposal.id, humanKey },
        "Work dispatch pending approval",
      );
    }
  }

  private async commitBinding(
    item: WorkItemRecord,
    agentId: string,
    agentHost: string | null,
  ): Promise<void> {
    const fresh = await this.store.getItem(item.id);
    if (!fresh) return;
    if (fresh.agentId) return;
    await this.store.updateItem(item.id, (record) => ({
      ...record,
      agentId,
      agentHost,
    }));
    await this.store.appendActivity({
      itemId: item.id,
      projectKey: item.projectKey,
      verb: "agent.assigned",
      field: "agentId",
      oldValue: null,
      newValue: agentId,
      actorKind: "system",
      actorId: null,
    });
  }

  private async handleProposalChange(proposal: MissionControlProposal): Promise<void> {
    if (proposal.kind !== "spawn") return;
    const spawnedAgentId = proposal.spawnedAgentId;
    if (!spawnedAgentId) return;
    const labels = proposal.spawnPlan?.labels;
    if (!labels) return;
    const itemId = labels["paseo.work-item-id"];
    if (!itemId) return;
    const item = await this.store.getItem(itemId);
    if (!item) return;
    if (item.agentId) return;
    const host = proposal.spawnPlan?.host ?? proposal.spawnedOnServerId ?? null;
    await this.commitBinding(item, spawnedAgentId, host);
  }

  private findPendingProposalForItem(itemId: string): MissionControlProposal | null {
    try {
      const proposals = this.approvals.listProposals();
      for (const proposal of proposals) {
        if (!isPending(proposal)) continue;
        if (proposalTargetsItem(proposal, itemId)) return proposal;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async resolveWorkspaceForItem(
    item: WorkItemRecord,
  ): Promise<{ cwd: string; workspaceId: string } | null> {
    if (item.assignment?.workspaceId) {
      const record = await this.workspaces.get(item.assignment.workspaceId);
      if (record && !record.archivedAt) return { cwd: record.cwd, workspaceId: record.workspaceId };
    }
    const all = await this.workspaces.list();
    const match = all.find(
      (workspace) => workspace.projectId === item.projectId && !workspace.archivedAt,
    );
    if (match) return { cwd: match.cwd, workspaceId: match.workspaceId };
    return null;
  }

  private async sweepExistingTodo(): Promise<void> {
    const projects = await this.store.listProjects();
    for (const project of projects) {
      const items = await this.store.listItems({ projectKey: project.projectKey });
      for (const item of items) {
        if (item.lane === "todo" && item.assignment && !item.agentId && !item.closed) {
          this.enqueue(item.id);
        }
      }
    }
  }
}
