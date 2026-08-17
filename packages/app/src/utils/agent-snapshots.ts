import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { Agent, SessionState } from "@/stores/session-store";
import type { ActiveTurnIdentity } from "@/timeline/turn-liveness";

function normalizeActiveTurn(
  snapshot: AgentSnapshotPayload,
  lastUserMessageAt: Date | null,
): ActiveTurnIdentity | null {
  if (snapshot.activeTurn === null) return null;
  if (snapshot.activeTurn) {
    return {
      turnId: snapshot.activeTurn.turnId,
      startedAt: snapshot.activeTurn.startedAt ? new Date(snapshot.activeTurn.startedAt) : null,
    };
  }
  return snapshot.status === "running" ? { turnId: null, startedAt: lastUserMessageAt } : null;
}

function projectActiveTurn(agent: Agent): Pick<AgentSnapshotPayload, "activeTurn"> {
  if (agent.activeTurn === null) return { activeTurn: null };
  if (agent.activeTurn.turnId === null) return {};
  return {
    activeTurn: {
      turnId: agent.activeTurn.turnId,
      startedAt: agent.activeTurn.startedAt?.toISOString() ?? null,
    },
  };
}

export function derivePendingPermissionKey(
  agentId: string,
  request: AgentPermissionRequest,
): string {
  const fallbackId =
    request.id ||
    (typeof request.metadata?.id === "string" ? request.metadata.id : undefined) ||
    request.name ||
    request.title ||
    `${request.kind}:${JSON.stringify(request.input ?? request.metadata ?? {})}`;

  return `${agentId}:${fallbackId}`;
}

export function projectAgentSnapshot(agent: Agent): AgentSnapshotPayload {
  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    ...(agent.features ? { features: agent.features } : {}),
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    ...projectActiveTurn(agent),
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    availableModes: agent.availableModes,
    pendingPermissions: agent.pendingPermissions,
    persistence: agent.persistence,
    ...(agent.runtimeInfo ? { runtimeInfo: agent.runtimeInfo } : {}),
    ...(agent.lastUsage ? { lastUsage: agent.lastUsage } : {}),
    ...(agent.lastError ? { lastError: agent.lastError } : {}),
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp?.toISOString() ?? null,
    ...(agent.bucket ? { bucket: agent.bucket } : {}),
    archivedAt: agent.archivedAt?.toISOString() ?? null,
  };
}

export function normalizeAgentSnapshot(snapshot: AgentSnapshotPayload, serverId: string) {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  const lastUserMessageAt = snapshot.lastUserMessageAt
    ? new Date(snapshot.lastUserMessageAt)
    : null;
  const attentionTimestamp = snapshot.attentionTimestamp
    ? new Date(snapshot.attentionTimestamp)
    : null;
  const archivedAt = snapshot.archivedAt ? new Date(snapshot.archivedAt) : null;
  const parentAgentId = getParentAgentIdFromLabels(snapshot.labels);
  // COMPAT(agentTurnIdentity): added in v0.2.6, remove after 2027-01-31 once daemon floor >= v0.2.6.
  // Old daemons expose only status. Normalize that legacy signal once so the rest
  // of the app consumes one activity shape.
  const activeTurn = normalizeActiveTurn(snapshot, lastUserMessageAt);

  return {
    serverId,
    id: snapshot.id,
    provider: snapshot.provider,
    status: snapshot.status,
    activeTurn,
    createdAt,
    updatedAt,
    lastUserMessageAt,
    lastActivityAt: updatedAt,
    capabilities: snapshot.capabilities,
    currentModeId: snapshot.currentModeId,
    availableModes: snapshot.availableModes ?? [],
    pendingPermissions: snapshot.pendingPermissions ?? [],
    persistence: snapshot.persistence ?? null,
    runtimeInfo: snapshot.runtimeInfo,
    lastUsage: snapshot.lastUsage,
    lastError: snapshot.lastError ?? null,
    title: snapshot.title ?? null,
    name: snapshot.name ?? null,
    shortDescription: snapshot.shortDescription ?? null,
    cwd: snapshot.cwd,
    workspaceId: snapshot.workspaceId,
    model: snapshot.model ?? null,
    features: snapshot.features,
    thinkingOptionId: snapshot.thinkingOptionId ?? null,
    effectiveThinkingOptionId:
      snapshot.effectiveThinkingOptionId ??
      snapshot.runtimeInfo?.thinkingOptionId ??
      snapshot.thinkingOptionId ??
      null,
    requiresAttention: snapshot.requiresAttention ?? false,
    attentionReason: snapshot.attentionReason ?? null,
    attentionTimestamp,
    stoppedBy: snapshot.stoppedBy ?? null,
    bucket: snapshot.bucket,
    archivedAt,
    parentAgentId,
    labels: snapshot.labels,
    providerUnavailable: snapshot.providerUnavailable === true,
  };
}

/**
 * Resolve an agent snapshot from a session, spanning both directories.
 *
 * Active, project-placed agents live in `agents`; agents hydrated without a
 * project placement (and archived ones) live in `agentDetails` — see
 * `storeFetchedAgentDetail`. Callers that render or gate on an agent must
 * consult both, otherwise a live agent looks statusless for the whole run.
 */
export function resolveSessionAgent(
  session: Pick<SessionState, "agents" | "agentDetails"> | undefined,
  agentId: string | undefined,
): Agent | null {
  if (!agentId) return null;
  return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
}
