import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { OrchestratorPlan, OrchestratorTaskStatus } from "@getpaseo/protocol/agent-types";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentTimelineItem,
  PluginTimelineItem,
} from "../agent-sdk-types.js";
import type { ManagedAgent } from "../agent-manager.js";
import { validatePlanDag } from "./dag.js";
import { applyTaskUpdate } from "./transitions.js";

export interface OrchestratorProposePlanInput {
  title: string;
  maxParallel?: number;
  tasks: Array<{
    id: string;
    title: string;
    brief?: string;
    files?: string[];
    dependsOn?: string[];
    model?: string;
  }>;
}

export interface OrchestratorTaskUpdateInput {
  taskId: string;
  status?: OrchestratorTaskStatus;
  childAgentId?: string;
}

export interface OrchestratorDispatcher {
  isOrchestratorAgent(callerAgentId: string): boolean;
  proposePlan(
    callerAgentId: string,
    input: OrchestratorProposePlanInput,
  ): Promise<{
    planId: string;
    version: number;
    approved: boolean;
    edited: boolean;
    rejected: boolean;
    plan: OrchestratorPlan;
  }>;
  updateTask(
    callerAgentId: string,
    input: OrchestratorTaskUpdateInput,
  ): Promise<{ version: number; plan: OrchestratorPlan }>;
}

export interface OrchestratorDispatcherManager {
  getAgent(id: string): ManagedAgent | null;
  getOrchestratorPlan(agentId: string): OrchestratorPlan | null;
  setOrchestratorPlan(agentId: string, plan: OrchestratorPlan | null): Promise<void>;
  appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<unknown>;
  requestDaemonPermission(
    agentId: string,
    request: AgentPermissionRequest,
    handler: (response: AgentPermissionResponse) => Promise<AgentPermissionResult | void>,
  ): void;
}

function clonePlan(plan: OrchestratorPlan): OrchestratorPlan {
  return JSON.parse(JSON.stringify(plan)) as OrchestratorPlan;
}

function planJson(plan: OrchestratorPlan): PluginTimelineItem["data"] {
  return JSON.parse(JSON.stringify(plan)) as PluginTimelineItem["data"];
}

/**
 * Daemon-owned orchestrator plan flow. proposePlan validates the DAG, stores
 * version 1, emits the plugin plan row, then blocks the tool call until the
 * user answers the OrchestratorPlanApproval permission: approve resumes with
 * the stored plan, edit applies updatedInput.tasks briefs, reject clears the
 * plan. updateTask applies a status/child-agent transition and emits the
 * next plan version.
 */
export class AgentManagerOrchestratorDispatcher implements OrchestratorDispatcher {
  private readonly planMutationTails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly agentManager: OrchestratorDispatcherManager,
    private readonly logger: Logger,
  ) {}

  private async planMutation<T>(agentId: string, mutation: () => Promise<T>): Promise<T> {
    const prior = this.planMutationTails.get(agentId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(mutation);
    this.planMutationTails.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.planMutationTails.get(agentId) === next) {
        this.planMutationTails.delete(agentId);
      }
    }
  }

  isOrchestratorAgent(callerAgentId: string): boolean {
    return this.agentManager.getAgent(callerAgentId)?.orchestrator === true;
  }

  private requireOrchestratorAgent(callerAgentId: string): void {
    if (!this.isOrchestratorAgent(callerAgentId)) {
      throw new Error("propose_plan requires an orchestrator agent caller");
    }
  }

  async proposePlan(
    callerAgentId: string,
    input: OrchestratorProposePlanInput,
  ): Promise<{
    planId: string;
    version: number;
    approved: boolean;
    edited: boolean;
    rejected: boolean;
    plan: OrchestratorPlan;
  }> {
    this.requireOrchestratorAgent(callerAgentId);
    const validated = validatePlanDag({
      title: input.title,
      maxParallel: input.maxParallel,
      tasks: input.tasks,
    });
    const planId = randomUUID();
    const plan: OrchestratorPlan = {
      planId,
      version: 1,
      title: validated.title,
      maxParallel: validated.maxParallel,
      tasks: validated.tasks,
    };
    await this.agentManager.setOrchestratorPlan(callerAgentId, clonePlan(plan));
    await this.agentManager.appendTimelineItem(callerAgentId, {
      type: "plugin",
      id: planId,
      pluginId: "orchestrator",
      kind: "plan",
      version: 1,
      data: planJson(plan),
    });
    const provider = this.agentManager.getAgent(callerAgentId)?.provider ?? "codex";
    const outcome = await new Promise<{ approved: boolean; edited: boolean; rejected: boolean }>(
      (resolve, reject) => {
        const request: AgentPermissionRequest = {
          id: randomUUID(),
          provider,
          name: "OrchestratorPlanApproval",
          kind: "plan",
          title: `Approve plan: ${plan.title}`,
          input: { plan: clonePlan(plan) as unknown as Record<string, unknown> },
          metadata: { source: "orchestrator" },
        };
        this.agentManager.requestDaemonPermission(callerAgentId, request, async (response) => {
          try {
            if (response.behavior !== "allow") {
              await this.agentManager.setOrchestratorPlan(callerAgentId, null);
              resolve({ approved: false, edited: false, rejected: true });
              return undefined;
            }
            const edited = await this.applyBriefEdits(callerAgentId, planId, response.updatedInput);
            resolve({ approved: true, edited, rejected: false });
            return undefined;
          } catch (error) {
            reject(error);
            return undefined;
          }
        });
      },
    );
    const stored = this.agentManager.getOrchestratorPlan(callerAgentId);
    if (outcome.rejected || !stored) {
      return { planId, version: 1, approved: false, edited: false, rejected: true, plan };
    }
    return {
      planId,
      version: stored.version,
      approved: outcome.approved,
      edited: outcome.edited,
      rejected: false,
      plan: clonePlan(stored),
    };
  }

  async updateTask(
    callerAgentId: string,
    input: OrchestratorTaskUpdateInput,
  ): Promise<{ version: number; plan: OrchestratorPlan }> {
    this.requireOrchestratorAgent(callerAgentId);
    return this.planMutation(callerAgentId, async () => {
      const current = this.agentManager.getOrchestratorPlan(callerAgentId);
      if (!current) throw new Error("No orchestrator plan: call propose_plan first");
      const next = clonePlan(current);
      applyTaskUpdate(next, input);
      next.version = current.version + 1;
      await this.agentManager.setOrchestratorPlan(callerAgentId, clonePlan(next));
      await this.agentManager.appendTimelineItem(callerAgentId, {
        type: "plugin",
        id: next.planId,
        pluginId: "orchestrator",
        kind: "plan",
        version: next.version,
        data: planJson(next),
      });
      this.logger.debug(
        { agentId: callerAgentId, taskId: input.taskId },
        "orchestrator task updated",
      );
      return { version: next.version, plan: clonePlan(next) };
    });
  }

  private async applyBriefEdits(
    callerAgentId: string,
    planId: string,
    updatedInput: Extract<AgentPermissionResponse, { behavior: "allow" }>["updatedInput"],
  ): Promise<boolean> {
    return this.planMutation(callerAgentId, async () =>
      this.applyBriefEditsUnlocked(callerAgentId, planId, updatedInput),
    );
  }

  private async applyBriefEditsUnlocked(
    callerAgentId: string,
    planId: string,
    updatedInput: Extract<AgentPermissionResponse, { behavior: "allow" }>["updatedInput"],
  ): Promise<boolean> {
    const tasks = (updatedInput as { tasks?: Array<{ id: string; brief: string }> } | undefined)
      ?.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) return false;
    const current = this.agentManager.getOrchestratorPlan(callerAgentId);
    if (!current) return false;
    const next = clonePlan(current);
    let edited = false;
    for (const edit of tasks) {
      const task = next.tasks.find((t) => t.id === edit.id);
      const changed = task && typeof edit.brief === "string" && edit.brief !== task.brief;
      if (changed && task) {
        task.brief = edit.brief;
        edited = true;
      }
    }
    if (!edited) return false;
    next.version += 1;
    await this.agentManager.setOrchestratorPlan(callerAgentId, clonePlan(next));
    await this.agentManager.appendTimelineItem(callerAgentId, {
      type: "plugin",
      id: planId,
      pluginId: "orchestrator",
      kind: "plan",
      version: next.version,
      data: planJson(next),
    });
    return true;
  }
}
