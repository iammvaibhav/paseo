export type OrchestratorPlanTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped"
  | "canceled";

export interface OrchestratorPlanTaskView {
  id: string;
  title: string;
  brief: string;
  files: string[];
  dependsOn: string[];
  model?: string;
  childAgentId?: string;
  status: OrchestratorPlanTaskStatus;
}

export interface OrchestratorPlanView {
  planId: string;
  version: number;
  title: string;
  maxParallel: number;
  tasks: OrchestratorPlanTaskView[];
}

export function isOrchestratorPlanTaskStatus(value: unknown): value is OrchestratorPlanTaskStatus {
  return (
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "skipped" ||
    value === "canceled"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parsePlanTask(value: unknown): OrchestratorPlanTaskView | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id !== "string" || typeof record.title !== "string") return null;
  const status = isOrchestratorPlanTaskStatus(record.status) ? record.status : "pending";
  return {
    id: record.id,
    title: record.title,
    brief: typeof record.brief === "string" ? record.brief : "",
    files: asStringArray(record.files),
    dependsOn: asStringArray(record.dependsOn),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.childAgentId === "string" ? { childAgentId: record.childAgentId } : {}),
    status,
  };
}

export function parseOrchestratorPlan(value: unknown): OrchestratorPlanView | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.planId !== "string" || !Array.isArray(record.tasks)) return null;
  const tasks = record.tasks
    .map(parsePlanTask)
    .filter((task): task is OrchestratorPlanTaskView => task !== null);
  if (tasks.length === 0) return null;
  return {
    planId: record.planId,
    version: typeof record.version === "number" ? record.version : 0,
    title: typeof record.title === "string" ? record.title : "",
    maxParallel: typeof record.maxParallel === "number" ? record.maxParallel : 1,
    tasks,
  };
}

/**
 * Layer tasks by dependency depth. Unknown dependency ids are ignored.
 * Cyclic tasks fall back to layer 0 so the graph always renders.
 */
export function layoutPlanLayers(tasks: readonly OrchestratorPlanTaskView[]): {
  layers: OrchestratorPlanTaskView[][];
  layerByTaskId: Record<string, number>;
  maxLayer: number;
} {
  const byId: Record<string, OrchestratorPlanTaskView> = {};
  for (const task of tasks) byId[task.id] = task;
  const depthById: Record<string, number> = {};
  const visiting: Record<string, true> = {};

  function depthOf(taskId: string): number {
    const cached = depthById[taskId];
    if (cached !== undefined) return cached;
    if (visiting[taskId]) return 0;
    const task = byId[taskId];
    if (!task) return 0;
    visiting[taskId] = true;
    let depth = 0;
    for (const depId of task.dependsOn) {
      if (!byId[depId]) continue;
      depth = Math.max(depth, depthOf(depId) + 1);
    }
    delete visiting[taskId];
    depthById[taskId] = depth;
    return depth;
  }

  let maxLayer = 0;
  for (const task of tasks) {
    maxLayer = Math.max(maxLayer, depthOf(task.id));
  }
  const layers: OrchestratorPlanTaskView[][] = Array.from({ length: maxLayer + 1 }, () => []);
  const layerByTaskId: Record<string, number> = {};
  for (const task of tasks) {
    const layer = depthById[task.id] ?? 0;
    layers[layer]?.push(task);
    layerByTaskId[task.id] = layer;
  }
  return { layers, layerByTaskId, maxLayer };
}

export function planTaskStatusToJsonPatchBriefs(input: {
  planTasks: readonly OrchestratorPlanTaskView[];
  briefDrafts: Record<string, string>;
}): Array<{ id: string; brief: string }> {
  return input.planTasks
    .filter((task) => {
      const draft = input.briefDrafts[task.id];
      return typeof draft === "string" && draft !== task.brief;
    })
    .map((task) => ({ id: task.id, brief: input.briefDrafts[task.id] ?? task.brief }));
}
