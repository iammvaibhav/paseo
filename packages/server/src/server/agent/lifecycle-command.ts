import type { Logger } from "pino";

import {
  AgentRunCancellationError,
  type AgentRunCancellationResult,
  type ManagedAgent,
} from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import type { AgentProviderNotice } from "./agent-sdk-types.js";

export type LifecycleAgentSnapshot = Pick<ManagedAgent, "id" | "cwd" | "lifecycle">;

export interface LifecycleAgentManager {
  getAgent(agentId: string): LifecycleAgentSnapshot | null;
  hasInFlightRun(agentId: string): boolean;
  cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult>;
  clearAgentAttention(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord>;
  closeAgent(agentId: string): Promise<void>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
  detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }>;
  notifyAgentState(agentId: string): void;
  setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
      provider?: string;
      model?: string | null;
      modeId?: string;
    },
  ): Promise<void>;
}

export interface LifecycleAgentStorage {
  get(agentId: string): Promise<StoredAgentRecord | null>;
  upsert(record: StoredAgentRecord): Promise<void>;
}

export interface AgentLifecycleCommandDependencies {
  agentManager: LifecycleAgentManager;
  agentStorage: LifecycleAgentStorage;
  logger: Logger;
}

export interface CancelAgentRunResult {
  agent: LifecycleAgentSnapshot;
  cancelled: boolean;
}

interface RequestedAgentRunCancellation extends CancelAgentRunResult {
  cancellation: AgentRunCancellationResult;
}

async function requestAgentRunCancellation(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "logger">,
  agentId: string,
): Promise<RequestedAgentRunCancellation> {
  const { agentManager, logger } = dependencies;
  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    logger.trace({ agentId }, "cancelAgentRunCommand: agent not found");
    throw new Error(`Agent ${agentId} not found`);
  }

  const hasInFlightRun = agentManager.hasInFlightRun(agentId);
  if (!hasInFlightRun) {
    logger.trace(
      { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
      "cancelAgentRunCommand: skipping because agent is not running",
    );
    return { agent, cancelled: false, cancellation: { status: "not_running" } };
  }

  logger.debug(
    { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
    "cancelAgentRunCommand: interrupting",
  );
  const startedAt = Date.now();
  const cancellation = await agentManager.cancelAgentRun(agentId);
  logger.debug(
    { agentId, cancellation: cancellation.status, durationMs: Date.now() - startedAt },
    "cancelAgentRunCommand: cancelAgentRun completed",
  );

  return {
    agent,
    cancelled: cancellation.status === "settled",
    cancellation,
  };
}

/**
 * Reconcile a stored record that claims a busy state but has NO live runtime
 * (a "phantom": the provider never launched, or the daemon restarted over a
 * dead run). The record would otherwise stay "running" forever — an explicit
 * cancel must clear it, mirroring the mission-control watchdog's
 * selfHealDeadRuntime (record -> error, terminal). Returns the reconciled
 * snapshot, or null when there is nothing to reconcile (no record, archived,
 * or already in a terminal state).
 */
async function reconcileDeadRunRecord(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "agentStorage" | "logger">,
  agentId: string,
): Promise<LifecycleAgentSnapshot | null> {
  const { agentStorage, logger } = dependencies;
  const record = await agentStorage.get(agentId);
  if (!record || record.archivedAt) {
    return null;
  }
  if (record.lastStatus !== "running" && record.lastStatus !== "initializing") {
    return null;
  }
  await agentStorage.upsert({
    ...record,
    lastStatus: "error",
    // Keep any existing provider error text (a failed launch already carried
    // it); a dead runtime with none gets a diagnostic so the board explains
    // the state instead of a bare "running" zombie.
    lastError: record.lastError ?? "Provider runtime is no longer alive; run interrupted",
    updatedAt: new Date().toISOString(),
  });
  logger.warn(
    { agentId, previousStatus: record.lastStatus },
    "cancelAgentRunCommand: reconciled phantom running record to error (no live runtime)",
  );
  return { id: agentId, cwd: record.cwd, lifecycle: "error" };
}

export async function cancelAgentRunCommand(
  dependencies: AgentLifecycleCommandDependencies,
  agentId: string,
): Promise<CancelAgentRunResult> {
  // An explicit cancel of an agent whose record says busy but that has NO
  // live runtime must reconcile the record to a terminal state instead of
  // reporting "Agent not found" while the record stays "running" forever.
  if (!dependencies.agentManager.getAgent(agentId)) {
    const reconciled = await reconcileDeadRunRecord(dependencies, agentId);
    if (reconciled) {
      return { agent: reconciled, cancelled: true };
    }
  }
  const result = await requestAgentRunCancellation(dependencies, agentId);
  if (result.cancellation.status === "refused") {
    dependencies.logger.warn(
      { agentId },
      "cancelAgentRunCommand: reported running but no active run was cancelled",
    );
    throw new AgentRunCancellationError(agentId, "stop");
  }

  return { agent: result.agent, cancelled: result.cancelled };
}

export interface ArchiveAgentResult {
  agentId: string;
  archivedAt: string;
  record: StoredAgentRecord;
}

export async function archiveAgentCommand(
  dependencies: AgentLifecycleCommandDependencies,
  agentId: string,
): Promise<ArchiveAgentResult> {
  const liveAgent = dependencies.agentManager.getAgent(agentId);
  let record: StoredAgentRecord | null;
  if (liveAgent) {
    await requestAgentRunCancellation(dependencies, agentId);
    await dependencies.agentManager.clearAgentAttention(agentId).catch(() => undefined);
    await dependencies.agentManager.archiveAgent(agentId);
    record = await dependencies.agentStorage.get(agentId);
  } else {
    record = await archiveStoredAgent(dependencies, agentId);
  }

  if (!record) {
    throw new Error(`Agent not found in storage after archive: ${agentId}`);
  }
  if (!record.archivedAt) {
    throw new Error(`Agent missing archivedAt after archive: ${agentId}`);
  }

  return {
    agentId,
    archivedAt: record.archivedAt,
    record,
  };
}

export async function closeAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<void> {
  await dependencies.agentManager.closeAgent(agentId);
}

export interface UpdateAgentResult {
  accepted: boolean;
  error: string | null;
}

/** Identity + runtime metadata the update RPC may patch on an agent. */
interface UpdateAgentMetadataPatch {
  title?: string;
  shortDescription?: string;
  labels?: Record<string, string>;
  provider?: string;
  model?: string | null;
  modeId?: string;
}

export async function updateAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    name?: string;
    title?: string;
    shortDescription?: string;
    labels?: Record<string, string>;
    provider?: string;
    model?: string | null;
    modeId?: string;
  },
): Promise<UpdateAgentResult> {
  // Legacy wire `name` is an alias for the display title (pre-v3). The
  // explicit `title` field wins when both are present.
  const title = input.title?.trim() ?? input.name?.trim();
  const shortDescription = input.shortDescription?.trim();
  const labels = input.labels && Object.keys(input.labels).length > 0 ? input.labels : undefined;
  const provider = input.provider?.trim();
  const model = input.model;
  const modeId = input.modeId?.trim();

  const updates: UpdateAgentMetadataPatch = {};
  if (title) {
    updates.title = title;
  }
  if (shortDescription) {
    updates.shortDescription = shortDescription;
  }
  if (labels) {
    updates.labels = labels;
  }
  if (provider) {
    updates.provider = provider;
  }
  if (model !== undefined) {
    updates.model = model;
  }
  if (modeId !== undefined) {
    updates.modeId = modeId;
  }

  if (Object.keys(updates).length === 0) {
    return {
      accepted: false,
      error:
        "Nothing to update (provide name, title, shortDescription, labels, provider, and/or model)",
    };
  }

  await dependencies.agentManager.updateAgentMetadata(input.agentId, updates);

  return {
    accepted: true,
    error: null,
  };
}

export interface DetachAgentResult {
  agentId: string;
  record: StoredAgentRecord;
  live: boolean;
  previousParentAgentId: string | null;
}

export async function detachAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<DetachAgentResult> {
  const result = await dependencies.agentManager.detachAgent(agentId);
  return {
    agentId,
    ...result,
  };
}

export async function setAgentModeCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    modeId: string;
  },
): Promise<{ modeId: string; notice: AgentProviderNotice | null }> {
  const notice = await dependencies.agentManager.setAgentMode(input.agentId, input.modeId);
  return { modeId: input.modeId, notice };
}

async function archiveStoredAgent(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "agentStorage">,
  agentId: string,
): Promise<StoredAgentRecord> {
  const existing = await dependencies.agentStorage.get(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (existing.archivedAt) {
    return existing;
  }

  const archivedAt = new Date().toISOString();
  return dependencies.agentManager.archiveSnapshot(agentId, archivedAt);
}
