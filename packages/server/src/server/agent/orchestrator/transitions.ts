import type {
  OrchestratorPlan,
  OrchestratorPlanTask,
  OrchestratorTaskStatus,
} from "@getpaseo/protocol/agent-types";

export class OrchestratorTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorTransitionError";
  }
}

const VALID_TRANSITIONS: Record<OrchestratorTaskStatus, Record<string, true>> = {
  pending: { ready: true, running: true, blocked: true, skipped: true, canceled: true },
  ready: { running: true, blocked: true, skipped: true, canceled: true },
  running: { completed: true, failed: true, canceled: true, blocked: true },
  blocked: { ready: true, running: true, skipped: true, canceled: true },
  failed: { ready: true, running: true, canceled: true }, // Retry support
  skipped: { ready: true, pending: true },
  canceled: { ready: true, pending: true },
  completed: {}, // Terminal state
};

/**
 * Validates whether a transition from currentStatus to newStatus is permissible.
 */
export function isValidTaskTransition(
  currentStatus: OrchestratorTaskStatus,
  newStatus: OrchestratorTaskStatus,
): boolean {
  if (currentStatus === newStatus) {
    return true;
  }
  return Boolean(VALID_TRANSITIONS[currentStatus]?.[newStatus]);
}

/**
 * Validates a transition, throwing OrchestratorTransitionError if invalid.
 */
export function assertValidTaskTransition(
  currentStatus: OrchestratorTaskStatus,
  newStatus: OrchestratorTaskStatus,
  taskId?: string,
): void {
  if (!isValidTaskTransition(currentStatus, newStatus)) {
    const taskPrefix = taskId ? `Task '${taskId}': ` : "";
    throw new OrchestratorTransitionError(
      `${taskPrefix}Cannot transition task status from '${currentStatus}' to '${newStatus}'`,
    );
  }
}

/**
 * Applies a task update to an OrchestratorPlan, validating transitions and updating fields.
 */
export function applyTaskUpdate(
  plan: OrchestratorPlan,
  update: {
    taskId: string;
    status?: OrchestratorTaskStatus;
    childAgentId?: string;
  },
): { task: OrchestratorPlanTask; modified: boolean } {
  const task = plan.tasks.find((t) => t.id === update.taskId);
  if (!task) {
    throw new OrchestratorTransitionError(
      `Task '${update.taskId}' not found in plan '${plan.planId}'`,
    );
  }

  let modified = false;

  if (update.status && update.status !== task.status) {
    assertValidTaskTransition(task.status, update.status, task.id);
    task.status = update.status;
    modified = true;
  }

  if (update.childAgentId !== undefined && update.childAgentId !== task.childAgentId) {
    task.childAgentId = update.childAgentId;
    modified = true;
  }

  return { task, modified };
}
