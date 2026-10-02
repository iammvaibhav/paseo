import type { OrchestratorPlanTask } from "@getpaseo/protocol/agent-types";

export class OrchestratorDagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorDagError";
  }
}

export interface RawPlanTaskInput {
  id: string;
  title: string;
  brief?: string;
  files?: string[];
  dependsOn?: string[];
  model?: string;
  childAgentId?: string;
  status?: OrchestratorPlanTask["status"];
}

export interface RawPlanInput {
  planId?: string;
  title: string;
  maxParallel?: number;
  tasks: RawPlanTaskInput[];
}

/**
 * Validates a plan's tasks to ensure they form a valid directed acyclic graph (DAG).
 *
 * Checks:
 * 1. Plan has at least one task.
 * 2. maxParallel must be a positive integer.
 * 3. Task IDs must be non-empty and unique.
 * 4. No task may depend on itself.
 * 5. All dependencies must reference existing tasks in the plan.
 * 6. No cycles in dependencies (Kahn's / DFS cycle detection).
 */
function normalizeTitle(title: unknown): string {
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    throw new OrchestratorDagError("Plan title is required");
  }
  return title.trim();
}

function normalizeMaxParallel(maxParallel: unknown): number {
  const value = maxParallel ?? 4;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new OrchestratorDagError(`maxParallel must be a positive integer, got ${value}`);
  }
  return value;
}

function indexTasksById(tasks: RawPlanTaskInput[]): {
  taskIds: Set<string>;
  idToTask: Map<string, RawPlanTaskInput>;
} {
  const taskIds = new Set<string>();
  const idToTask = new Map<string, RawPlanTaskInput>();
  for (const task of tasks) {
    if (!task.id || typeof task.id !== "string" || task.id.trim().length === 0) {
      throw new OrchestratorDagError("Every task must have a non-empty id");
    }
    const id = task.id.trim();
    if (taskIds.has(id)) {
      throw new OrchestratorDagError(`Duplicate task id: '${id}'`);
    }
    taskIds.add(id);
    idToTask.set(id, task);
  }
  return { taskIds, idToTask };
}

function assertDependenciesExist(
  idToTask: Map<string, RawPlanTaskInput>,
  taskIds: Set<string>,
): void {
  for (const [id, task] of idToTask) {
    const dependsOn = task.dependsOn ?? [];
    for (const dep of dependsOn) {
      if (dep === id) {
        throw new OrchestratorDagError(`Task '${id}' cannot depend on itself`);
      }
      if (!taskIds.has(dep)) {
        throw new OrchestratorDagError(`Task '${id}' depends on nonexistent task '${dep}'`);
      }
    }
  }
}

export function validatePlanDag(input: RawPlanInput): {
  title: string;
  maxParallel: number;
  tasks: OrchestratorPlanTask[];
} {
  const title = normalizeTitle(input.title);
  const maxParallel = normalizeMaxParallel(input.maxParallel);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new OrchestratorDagError("Plan must contain at least one task");
  }
  const { taskIds, idToTask } = indexTasksById(input.tasks);
  assertDependenciesExist(idToTask, taskIds);
  assertAcyclic(idToTask, taskIds);

  // Construct validated tasks
  const validatedTasks: OrchestratorPlanTask[] = input.tasks.map((t) => ({
    id: t.id.trim(),
    title: t.title?.trim() || t.id.trim(),
    brief: t.brief ?? "",
    files: Array.isArray(t.files) ? t.files : [],
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((d) => d.trim()) : [],
    status: t.status ?? "pending",
    ...(t.model ? { model: t.model } : {}),
    ...(t.childAgentId ? { childAgentId: t.childAgentId } : {}),
  }));

  return {
    title,
    maxParallel,
    tasks: validatedTasks,
  };
}

function assertAcyclic(idToTask: Map<string, RawPlanTaskInput>, taskIds: Set<string>): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function checkCycle(nodeId: string, path: string[]): void {
    visited.add(nodeId);
    inStack.add(nodeId);
    path.push(nodeId);
    const deps = idToTask.get(nodeId)?.dependsOn ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        checkCycle(dep, path);
      } else if (inStack.has(dep)) {
        const cyclePath = path.slice(path.indexOf(dep)).concat(dep);
        throw new OrchestratorDagError(
          `Cycle detected in plan dependencies: ${cyclePath.join(" -> ")}`,
        );
      }
    }
    inStack.delete(nodeId);
    path.pop();
  }

  for (const id of taskIds) {
    if (!visited.has(id)) {
      checkCycle(id, []);
    }
  }
}
