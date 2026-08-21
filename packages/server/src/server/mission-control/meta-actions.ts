import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import type { Logger } from "pino";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MissionControlMetaPlan,
  MissionControlPeerStatus,
  MissionControlProposal,
} from "@getpaseo/protocol/mission-control/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ArchiveAgentResult } from "../agent/lifecycle-command.js";
import type {
  PersistedProjectRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import type { ArchiveResult } from "../workspace-archive-service.js";
import { areEquivalentPaths } from "../../utils/path.js";
import { COMMANDER_ADOPTED_AT_LABEL } from "./commander-contract.js";
import { hasMissionControlLabels } from "./naming.js";

/**
 * M5 meta actions: the daemon-side executor for the Commander's `fleet_meta`
 * tool. `applyMetaFromProposal` is the single execution path for an approved
 * meta-kind proposal (bootstrap wires it into MissionControlService as
 * `metaFromProposal`, which the approvals gate calls on approve and on
 * auto-send in auto mode). Every action validates against live fleet state
 * before applying and logs loudly under module "mission-control", component
 * "meta". Destructive actions (archives) are classified destructive by the
 * tool so the gate always asks, even in auto mode.
 *
 * Cross-host routing: `metaPlan.serverId` names the host the action applies
 * to ("local" or a peer name). Local targets validate + apply against THIS
 * daemon's registries; peer targets are FORWARDED over peering
 * (mission_control.meta.apply → fleetMetaApply on the peer), and the PEER
 * validates the plan against ITS OWN registries and applies there. The
 * proposal card always lives on the commander host (gate unchanged) — only
 * the apply hops. Unknown hosts are refused before the gate (the fleet_meta
 * tool) and again at apply (the fleet map may change while a card sits
 * pending).
 *
 * Placement rules honored here (docs/commander.md "Placement doctrine"):
 *  - `promote_workspace` requires the source workspace to live in the
 *    per-host `experiments` project (root `~/experiments` by convention,
 *    displayName "experiments" accepted as a fallback for dev stacks).
 *  - Agent NAMES are write-once: the only agent mutation this module performs
 *    on identity is TITLE (`rename_agent_title`) — the name is never touched.
 *  - `move_agent` refuses running agents (workspace attribution is stable
 *    while a run is in flight) and archived agents, and refuses archived or
 *    missing target workspaces. Cross-host moves are refused by construction:
 *    both ids are resolved against THIS host's registries (a peer move
 *    targets the peer via its own serverId, so it validates there).
 *
 * The executor mutates the registries directly, so connected sessions observe
 * project/workspace changes through their registry-mutation subscriptions
 * (Session.subscribeToRegistryMutations) and live-agent changes through
 * agent_state events. Stored (not-running) agent records have no event stream
 * of their own — callers must emit through `emitStoredAgentUpdate` (wired to
 * the session's agent_update service in bootstrap).
 */

export interface MoveAgentDependencies {
  agentManager: Pick<AgentManager, "getAgent" | "moveAgentWorkspace">;
  agentStorage: Pick<AgentStorage, "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
}

export interface MoveAgentInput {
  agentId: string;
  workspaceId: string;
}

export interface MoveAgentResult {
  agentId: string;
  fromWorkspaceId: string | null;
  toWorkspaceId: string;
  /** True when the agent is live (idle/closed/error) on this daemon. */
  live: boolean;
  /** The rewritten record (live agents persisted, stored agents patched). */
  record: StoredAgentRecord;
}

/**
 * Move a non-archived agent record to another workspace on this host. Shared
 * by the `agent.workspace.move` RPC and the meta-actions `move_agent` action —
 * one validation + mutation path for both callers.
 *
 * Refusals (all validated BEFORE any write so the record is never half-moved):
 *  - agent not found on this host (a peer agent id is a cross-host move → refused);
 *  - agent archived;
 *  - agent running (workspace attribution is a stable identity mid-run;
 *    callers stop the agent first — "non-running preferred");
 *  - target workspace missing or archived on this host.
 */
export async function moveAgentToWorkspace(
  dependencies: MoveAgentDependencies,
  input: MoveAgentInput,
): Promise<MoveAgentResult> {
  const agentId = input.agentId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!agentId) {
    throw new Error("agentId is required");
  }
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const liveAgent = dependencies.agentManager.getAgent(agentId);
  const storedRecord = await dependencies.agentStorage.get(agentId);
  if (!liveAgent && !storedRecord) {
    throw new Error(`Agent ${agentId} not found on this host`);
  }
  if (storedRecord?.archivedAt) {
    throw new Error(`Agent ${agentId} is archived`);
  }
  if (liveAgent && liveAgent.lifecycle === "running") {
    throw new Error(`Agent ${agentId} is running; stop it before moving workspaces`);
  }

  const workspace = await dependencies.workspaceRegistry.get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found on this host`);
  }
  if (workspace.archivedAt) {
    throw new Error(`Workspace ${workspaceId} is archived`);
  }

  const fromWorkspaceId = liveAgent?.workspaceId ?? storedRecord?.workspaceId ?? null;
  if (fromWorkspaceId === workspaceId && storedRecord) {
    // Already there: idempotent no-op, record unchanged.
    return {
      agentId,
      fromWorkspaceId,
      toWorkspaceId: workspaceId,
      live: Boolean(liveAgent),
      record: storedRecord,
    };
  }

  const moved = await dependencies.agentManager.moveAgentWorkspace(agentId, workspaceId);
  return {
    agentId,
    fromWorkspaceId,
    toWorkspaceId: workspaceId,
    live: Boolean(liveAgent),
    record: moved,
  };
}

/** The live-state lookups validation needs (existence + experiments root). */
export interface MetaActionsLookupDependencies {
  agentManager: Pick<AgentManager, "getAgent">;
  agentStorage: Pick<AgentStorage, "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
}

/**
 * The daemon-to-daemon client surface host resolution + peer routing need.
 * The real PeerManager satisfies this structurally (peers/peer-manager.ts);
 * tests hand it a fake without a PeerManager instance.
 */
export interface MetaPeerManager {
  getPeerStatus(name: string): MissionControlPeerStatus | null;
  getPeerClient(name: string): DaemonClient | null;
}

/**
 * The host-identity + fleet-map lookups `resolveMetaTargetHost` needs.
 * `hostName`/`hostAlias` are optional: the tool catalog (fleet_meta) has the
 * daemon's serverId + hostAlias but no OS hostname; bootstrap has all three.
 */
export interface MetaTargetResolutionDependencies {
  serverId: string;
  hostName?: string;
  hostAlias?: string | null;
  peerManager?: MetaPeerManager | null;
}

/** What every action needs from the live daemon to validate and apply. */
export interface MetaActionsDependencies
  extends MetaActionsLookupDependencies, MetaTargetResolutionDependencies {
  serverId: string;
  hostName: string;
  logger: Logger;
  agentManager: Pick<
    AgentManager,
    "getAgent" | "moveAgentWorkspace" | "updateAgentMetadata" | "setLabels"
  >;
  agentStorage: Pick<AgentStorage, "get" | "list">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update" | "upsert" | "list">;
  projectRegistry: Pick<
    ProjectRegistry,
    "get" | "list" | "getOrCreateActiveByRoot" | "update" | "archive"
  >;
  /** Existing cascade: archive a workspace (agents + terminals + record). */
  archiveWorkspace: (workspaceId: string, requestId: string) => Promise<ArchiveResult>;
  /** Existing cascade: archive a single agent (cancel run + record). */
  archiveAgent: (agentId: string) => Promise<ArchiveAgentResult>;
  /**
   * mkdir -p a directory (and any missing parents) on this host. Project
   * creation/promotion ensures the project root exists on disk BEFORE the
   * record is registered: a registered root that does not exist breaks
   * provider/model resolution against it ("models error" when opening the
   * project). No-op when the directory already exists.
   */
  mkdirp: (dirPath: string) => Promise<void>;
  /**
   * Emit an agent_update for a STORED (not-running) agent record after a
   * mutation. Live agents flow through agent_state automatically; stored
   * records have no event stream, so the caller (bootstrap → session's
   * agent_update service) emits for them. Best-effort: failures must never
   * fail the applied action.
   */
  emitStoredAgentUpdate: (record: StoredAgentRecord) => Promise<void>;
}

export type MetaActionValidationResult = { ok: true } | { ok: false; error: string };

export type MetaPlanActionResult = { ok: true; summary: string } | { ok: false; error: string };

/**
 * Where a meta plan's `serverId` resolves. "local" means apply on THIS daemon
 * against its own registries; "peer" means forward the plan to that peer over
 * peering (fleetMetaApply), which validates against ITS registries and
 * applies there. The proposal/card always lives on the commander host — only
 * the apply hops.
 */
export type ResolvedMetaTarget =
  | { ok: true; kind: "local"; label: string }
  | { ok: true; kind: "peer"; peerName: string; label: string }
  | { ok: false; error: string };

/**
 * Resolve a meta plan's target host (`metaPlan.serverId`) through the same
 * fleet map the fleet tools use (peer-manager), accepting the aliases the
 * Commander writes:
 *   - absent / "local"              → this daemon
 *   - this daemon's serverId / hostName / hostAlias → this daemon
 *   - a peer name from the fleet map → that peer
 * Anything else is an unknown host (refused before the gate by
 * buildFleetMetaProposalInput, and refused at apply by applyMetaFromProposal —
 * belt and suspenders, the fleet map may change while a proposal sits
 * pending).
 */
export function resolveMetaTargetHost(
  deps: MetaTargetResolutionDependencies,
  serverId: string | undefined,
): ResolvedMetaTarget {
  const raw = serverId?.trim() || "local";
  if (raw === "local") {
    return { ok: true, kind: "local", label: "local" };
  }
  // Own identity compares case-insensitively: the Commander echoes fleet
  // labels verbatim, and the machine/alias casing must never turn this
  // daemon into an "unknown host". Peer names stay exact (config values).
  const rawLower = raw.toLowerCase();
  if (deps.serverId.trim().toLowerCase() === rawLower) {
    return { ok: true, kind: "local", label: raw };
  }
  if (deps.hostName?.trim().toLowerCase() === rawLower) {
    return { ok: true, kind: "local", label: raw };
  }
  if (deps.hostAlias?.trim().toLowerCase() === rawLower) {
    return { ok: true, kind: "local", label: raw };
  }
  const peerStatus = deps.peerManager?.getPeerStatus(raw) ?? null;
  if (peerStatus) {
    return { ok: true, kind: "peer", peerName: peerStatus.name, label: peerStatus.name };
  }
  return { ok: false, error: `Host "${raw}" is not a configured peer or this host` };
}

function requireTargetId(plan: MissionControlMetaPlan): string {
  const targetId = plan.targetId?.trim();
  if (!targetId) {
    return "";
  }
  return targetId;
}

function requireNewValue(plan: MissionControlMetaPlan): string {
  const newValue = plan.newValue?.trim();
  if (!newValue) {
    return "";
  }
  return newValue;
}

function requireDestination(plan: MissionControlMetaPlan): string {
  const destination = plan.destination?.trim();
  if (!destination) {
    return "";
  }
  return destination;
}

async function resolveAgentRecord(
  deps: Pick<MetaActionsLookupDependencies, "agentManager" | "agentStorage">,
  agentId: string,
): Promise<{ live: boolean; record: StoredAgentRecord } | null> {
  const liveAgent = deps.agentManager.getAgent(agentId);
  if (liveAgent) {
    return { live: true, record: liveAgent as unknown as StoredAgentRecord };
  }
  const record = await deps.agentStorage.get(agentId);
  return record ? { live: false, record } : null;
}

/** The per-host experiments project: root `~/experiments` (path match first,
 *  displayName fallback for dev stacks). Null when the host has none. */
export async function resolveExperimentsProject(
  deps: Pick<MetaActionsLookupDependencies, "projectRegistry">,
): Promise<PersistedProjectRecord | null> {
  const projects = await deps.projectRegistry.list();
  const experimentsRoot = resolve(homedir(), "experiments");
  const byPath = projects.find(
    (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, experimentsRoot),
  );
  if (byPath) {
    return byPath;
  }
  return (
    projects.find(
      (project) =>
        !project.archivedAt &&
        (project.customName ?? project.displayName).toLowerCase() === "experiments",
    ) ?? null
  );
}

async function validateRenameProject(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "rename_project requires a targetId" };
  }
  const project = await deps.projectRegistry.get(targetId);
  if (!project) {
    return { ok: false, error: `Project ${targetId} not found` };
  }
  if (!requireNewValue(plan)) {
    return { ok: false, error: "rename_project requires a non-empty newValue" };
  }
  return { ok: true };
}

async function validateRenameWorkspace(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "rename_workspace requires a targetId" };
  }
  const workspace = await deps.workspaceRegistry.get(targetId);
  if (!workspace) {
    return { ok: false, error: `Workspace ${targetId} not found` };
  }
  if (!requireNewValue(plan)) {
    return { ok: false, error: "rename_workspace requires a non-empty newValue" };
  }
  return { ok: true };
}

async function validateRenameAgentTitle(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "rename_agent_title requires a targetId" };
  }
  const agent = await resolveAgentRecord(deps, targetId);
  if (!agent) {
    return { ok: false, error: `Agent ${targetId} not found` };
  }
  if (!requireNewValue(plan)) {
    return { ok: false, error: "rename_agent_title requires a non-empty newValue" };
  }
  return { ok: true };
}

async function validateArchiveProject(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "archive_project requires a targetId" };
  }
  const project = await deps.projectRegistry.get(targetId);
  if (!project) {
    return { ok: false, error: `Project ${targetId} not found` };
  }
  return { ok: true };
}

async function validateArchiveWorkspace(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "archive_workspace requires a targetId" };
  }
  const workspace = await deps.workspaceRegistry.get(targetId);
  if (!workspace) {
    return { ok: false, error: `Workspace ${targetId} not found` };
  }
  return { ok: true };
}

async function validateArchiveAgent(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "archive_agent requires a targetId" };
  }
  const agent = await resolveAgentRecord(deps, targetId);
  if (!agent) {
    return { ok: false, error: `Agent ${targetId} not found` };
  }
  return { ok: true };
}

async function validateCreateProject(
  _deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const destination = requireDestination(plan);
  if (!destination) {
    return { ok: false, error: "create_project requires a destination (project root path)" };
  }
  // The destination becomes the on-disk project root. A relative path would
  // silently resolve against the daemon's cwd (and ~ never expands), so it
  // must be absolute — the Commander passes an explicit absolute root.
  if (!isAbsolute(destination)) {
    return {
      ok: false,
      error: `create_project destination must be an absolute path (got "${destination}")`,
    };
  }
  return { ok: true };
}

async function validateMoveAgent(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "move_agent requires a targetId (agent id)" };
  }
  const destination = requireDestination(plan);
  if (!destination) {
    return { ok: false, error: "move_agent requires a destination (target workspace id)" };
  }
  const agent = await resolveAgentRecord(deps, targetId);
  if (!agent) {
    return { ok: false, error: `Agent ${targetId} not found` };
  }
  if (agent.record.archivedAt) {
    return { ok: false, error: `Agent ${targetId} is archived` };
  }
  if (agent.live && deps.agentManager.getAgent(targetId)?.lifecycle === "running") {
    return { ok: false, error: `Agent ${targetId} is running; stop it before moving` };
  }
  const workspace = await deps.workspaceRegistry.get(destination);
  if (!workspace) {
    return { ok: false, error: `Workspace ${destination} not found` };
  }
  if (workspace.archivedAt) {
    return { ok: false, error: `Workspace ${destination} is archived` };
  }
  return { ok: true };
}

async function validatePromoteWorkspace(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "promote_workspace requires a targetId (workspace id)" };
  }
  const workspace = await deps.workspaceRegistry.get(targetId);
  if (!workspace) {
    return { ok: false, error: `Workspace ${targetId} not found` };
  }
  if (workspace.archivedAt) {
    return { ok: false, error: `Workspace ${targetId} is archived` };
  }
  const experimentsProject = await resolveExperimentsProject(deps);
  if (!experimentsProject) {
    return {
      ok: false,
      error:
        "promote_workspace requires the workspace to live in the per-host experiments project, but this host has no experiments project (~/experiments)",
    };
  }
  if (workspace.projectId !== experimentsProject.projectId) {
    return {
      ok: false,
      error: `Workspace ${targetId} is not in the experiments project (it belongs to ${workspace.projectId})`,
    };
  }
  return { ok: true };
}

async function validateAdoptAgent(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "adopt_agent requires a targetId (agent id)" };
  }
  const agent = await resolveAgentRecord(deps, targetId);
  if (!agent) {
    return { ok: false, error: `Agent ${targetId} not found` };
  }
  if (agent.record.archivedAt) {
    return { ok: false, error: `Agent ${targetId} is archived` };
  }
  // Mission-control machinery (the Commander, verifiers) is never adopted —
  // "this is my agent, you take care of it" applies to fleet workers.
  const labels = agent.live ? deps.agentManager.getAgent(targetId)?.labels : agent.record.labels;
  if (labels && hasMissionControlLabels(labels)) {
    return {
      ok: false,
      error: `Agent ${targetId} is mission-control machinery; it cannot be adopted`,
    };
  }
  return { ok: true };
}

async function validateReleaseAgent(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  const targetId = requireTargetId(plan);
  if (!targetId) {
    return { ok: false, error: "release_agent requires a targetId (agent id)" };
  }
  const agent = await resolveAgentRecord(deps, targetId);
  if (!agent) {
    return { ok: false, error: `Agent ${targetId} not found` };
  }
  if (agent.record.archivedAt) {
    return { ok: false, error: `Agent ${targetId} is archived` };
  }
  const labels = agent.live ? deps.agentManager.getAgent(targetId)?.labels : agent.record.labels;
  const adoptedAt = labels?.[COMMANDER_ADOPTED_AT_LABEL];
  if (typeof adoptedAt !== "string" || adoptedAt.trim().length === 0) {
    return { ok: false, error: `Agent ${targetId} is not adopted by the Commander` };
  }
  return { ok: true };
}

/**
 * Host-independent plan SHAPE validation: required identifying fields and
 * path rules (create_project absolute destination). No registry lookups — safe
 * to run on the commander host even when the plan targets a peer whose
 * registries live elsewhere. Runs before the registry checks in
 * `validateMetaPlan` (local applies) and alone at the gate for peer targets
 * (the target host re-validates the full plan against ITS registries at
 * apply time).
 */
export async function validateMetaPlanShape(
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  switch (plan.action) {
    case "rename_project":
    case "rename_workspace":
    case "rename_agent_title": {
      if (!requireTargetId(plan)) {
        return { ok: false, error: `${plan.action} requires a targetId` };
      }
      if (!requireNewValue(plan)) {
        return { ok: false, error: `${plan.action} requires a non-empty newValue` };
      }
      return { ok: true };
    }
    case "archive_project":
    case "archive_workspace":
    case "archive_agent":
    case "adopt_agent":
    case "release_agent": {
      if (!requireTargetId(plan)) {
        return { ok: false, error: `${plan.action} requires a targetId` };
      }
      return { ok: true };
    }
    case "promote_workspace": {
      if (!requireTargetId(plan)) {
        return { ok: false, error: "promote_workspace requires a targetId (workspace id)" };
      }
      return { ok: true };
    }
    case "create_project": {
      const destination = requireDestination(plan);
      if (!destination) {
        return { ok: false, error: "create_project requires a destination (project root path)" };
      }
      // The destination becomes the on-disk project root. A relative path
      // would silently resolve against the daemon's cwd (and ~ never
      // expands), so it must be absolute — the Commander passes an explicit
      // absolute root.
      if (!isAbsolute(destination)) {
        return {
          ok: false,
          error: `create_project destination must be an absolute path (got "${destination}")`,
        };
      }
      return { ok: true };
    }
    case "move_agent": {
      if (!requireTargetId(plan)) {
        return { ok: false, error: "move_agent requires a targetId (agent id)" };
      }
      if (!requireDestination(plan)) {
        return { ok: false, error: "move_agent requires a destination (target workspace id)" };
      }
      return { ok: true };
    }
  }
}

/**
 * Validate a meta plan against live fleet state. Every refusal path returns a
 * human-readable error WITHOUT mutating anything; the fleet_meta tool runs
 * this before routing through the approval gate, and applyMetaPlan runs it
 * again before applying (belt and suspenders — the proposal may sit pending
 * for hours while the world changes).
 */
export async function validateMetaPlan(
  deps: MetaActionsLookupDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaActionValidationResult> {
  // Shape first: field presence + path rules are host-independent and fail
  // fast before any registry lookup.
  const shape = await validateMetaPlanShape(plan);
  if (!shape.ok) {
    return shape;
  }
  switch (plan.action) {
    case "rename_project":
      return validateRenameProject(deps, plan);
    case "rename_workspace":
      return validateRenameWorkspace(deps, plan);
    case "rename_agent_title":
      return validateRenameAgentTitle(deps, plan);
    case "archive_project":
      return validateArchiveProject(deps, plan);
    case "archive_workspace":
      return validateArchiveWorkspace(deps, plan);
    case "archive_agent":
      return validateArchiveAgent(deps, plan);
    case "create_project":
      return validateCreateProject(deps, plan);
    case "move_agent":
      return validateMoveAgent(deps, plan);
    case "promote_workspace":
      return validatePromoteWorkspace(deps, plan);
    case "adopt_agent":
      return validateAdoptAgent(deps, plan);
    case "release_agent":
      return validateReleaseAgent(deps, plan);
  }
}

/** Audit-trail logger shared by every apply handler: full plan + event. */
function logMetaEvent(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
  event: string,
  extra?: Record<string, unknown>,
): void {
  deps.logger.info(
    {
      module: "mission-control",
      component: "meta",
      action: plan.action,
      serverId: plan.serverId ?? deps.serverId,
      targetId: plan.targetId,
      targetLabel: plan.targetLabel,
      newValue: plan.newValue,
      destination: plan.destination,
      ...extra,
    },
    event,
  );
}

async function applyRenameProject(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const projectId = plan.targetId!;
  const newValue = plan.newValue!.trim();
  const updated = await deps.projectRegistry.update(projectId, (record) => ({
    ...record,
    customName: newValue,
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) {
    return { ok: false, error: `Project ${projectId} not found` };
  }
  logMetaEvent(deps, plan, "mission_control.meta.rename_project_applied", {
    projectId,
    newCustomName: newValue,
  });
  return { ok: true, summary: `Renamed project ${projectId} to "${newValue}"` };
}

async function applyRenameWorkspace(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const workspaceId = plan.targetId!;
  const newValue = plan.newValue!.trim();
  const updated = await deps.workspaceRegistry.update(workspaceId, (record) => ({
    ...record,
    title: newValue,
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) {
    return { ok: false, error: `Workspace ${workspaceId} not found` };
  }
  logMetaEvent(deps, plan, "mission_control.meta.rename_workspace_applied", {
    workspaceId,
    newTitle: newValue,
  });
  return { ok: true, summary: `Renamed workspace ${workspaceId} to "${newValue}"` };
}

async function applyRenameAgentTitle(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const agentId = plan.targetId!;
  const newValue = plan.newValue!.trim();
  // TITLE only — names are write-once (docs/commander.md "Identity"):
  // updateAgentMetadata routes title through setTitle for live agents and
  // a stored title patch for closed ones; `name` is never passed.
  await deps.agentManager.updateAgentMetadata(agentId, { title: newValue });
  const after = await resolveAgentRecord(deps, agentId);
  if (after && !after.live) {
    await safeEmitStoredAgentUpdate(deps, after.record);
  }
  logMetaEvent(deps, plan, "mission_control.meta.rename_agent_title_applied", {
    agentId,
    newTitle: newValue,
  });
  return {
    ok: true,
    summary: `Renamed agent ${agentId} title to "${newValue}" (name untouched)`,
  };
}

async function applyArchiveProject(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const projectId = plan.targetId!;
  const requestId = `meta-archive-project-${projectId}`;
  const workspaces = (await deps.workspaceRegistry.list()).filter(
    (workspace) => workspace.projectId === projectId && !workspace.archivedAt,
  );
  for (const workspace of workspaces) {
    await deps.archiveWorkspace(workspace.workspaceId, requestId);
  }
  await deps.projectRegistry.archive(projectId, new Date().toISOString());
  logMetaEvent(deps, plan, "mission_control.meta.archive_project_applied", {
    projectId,
    archivedWorkspaces: workspaces.map((workspace) => workspace.workspaceId),
  });
  return {
    ok: true,
    summary: `Archived project ${projectId} and ${workspaces.length} workspace(s)`,
  };
}

async function applyArchiveWorkspace(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const workspaceId = plan.targetId!;
  const requestId = `meta-archive-workspace-${workspaceId}`;
  const result = await deps.archiveWorkspace(workspaceId, requestId);
  logMetaEvent(deps, plan, "mission_control.meta.archive_workspace_applied", {
    workspaceId,
    archivedAgentIds: result.archivedAgentIds,
  });
  return {
    ok: true,
    summary: `Archived workspace ${workspaceId} (${result.archivedAgentIds.length} agent(s))`,
  };
}

async function applyArchiveAgent(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const agentId = plan.targetId!;
  const result = await deps.archiveAgent(agentId);
  logMetaEvent(deps, plan, "mission_control.meta.archive_agent_applied", {
    agentId,
    archivedAt: result.archivedAt,
  });
  return { ok: true, summary: `Archived agent ${agentId}` };
}

async function applyCreateProject(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const rootPath = resolve(requireDestination(plan));
  // Ensure the root exists on disk BEFORE registering the record: a project
  // whose root does not exist cannot be opened (provider/model resolution
  // against the missing cwd fails with a models error). Validation above
  // guarantees the destination is absolute, so this is the Commander's
  // explicitly provided path — never a cwd-relative guess.
  await deps.mkdirp(rootPath);
  const displayName = plan.newValue?.trim() || basename(rootPath) || rootPath;
  const project = await deps.projectRegistry.getOrCreateActiveByRoot({
    rootPath,
    kind: "non_git",
    displayName,
    timestamp: new Date().toISOString(),
  });
  logMetaEvent(deps, plan, "mission_control.meta.create_project_applied", {
    projectId: project.projectId,
    rootPath,
    displayName,
    directoryEnsured: rootPath,
  });
  return { ok: true, summary: `Project ${project.projectId} ready at ${rootPath}` };
}

async function applyMoveAgent(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const agentId = plan.targetId!;
  const workspaceId = plan.destination!;
  const result = await moveAgentToWorkspace(deps, { agentId, workspaceId });
  if (!result.live) {
    await safeEmitStoredAgentUpdate(deps, result.record);
  }
  logMetaEvent(deps, plan, "mission_control.meta.move_agent_applied", {
    agentId,
    fromWorkspaceId: result.fromWorkspaceId,
    toWorkspaceId: workspaceId,
  });
  return {
    ok: true,
    summary: `Moved agent ${agentId} to workspace ${workspaceId}`,
  };
}

async function applyPromoteWorkspace(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const workspaceId = plan.targetId!;
  const workspace = (await deps.workspaceRegistry.get(workspaceId))!;
  // Create the project at the workspace's path root (the worktree root
  // for worktree workspaces, the working directory otherwise) using the
  // same allocation semantics as normal project creation, then re-parent
  // the workspace record into it. Agents stay put: they are owned by the
  // workspace, which now lives under the new project.
  const rootPath = workspace.worktreeRoot ?? workspace.cwd;
  // Same gap as create_project: the new project's root must exist on disk
  // before the record is registered, or opening the promoted project fails
  // model resolution. mkdir -p is a no-op when the workspace root already
  // exists (the normal case) and repairs stale/missing workspace records.
  await deps.mkdirp(rootPath);
  const kind = workspace.kind === "directory" ? "non_git" : "git";
  const displayName = plan.newValue?.trim() || basename(rootPath) || rootPath;
  const project = await deps.projectRegistry.getOrCreateActiveByRoot({
    rootPath,
    kind,
    displayName,
    timestamp: new Date().toISOString(),
  });
  await deps.workspaceRegistry.update(workspaceId, (record) => ({
    ...record,
    projectId: project.projectId,
    updatedAt: new Date().toISOString(),
  }));
  const agentIds = (await deps.agentStorage.list())
    .filter((record) => record.workspaceId === workspaceId && !record.archivedAt)
    .map((record) => record.id);
  logMetaEvent(deps, plan, "mission_control.meta.promote_workspace_applied", {
    workspaceId,
    fromProjectId: workspace.projectId,
    projectId: project.projectId,
    rootPath,
    movedAgentIds: agentIds,
  });
  return {
    ok: true,
    summary: `Promoted workspace ${workspaceId} to project ${project.projectId} (${agentIds.length} agent(s) moved with it)`,
  };
}

/**
 * M8 adopt_agent: stamp paseo.commander-adopted-at on the target agent (live
 * + stored — agentManager.setLabels merges into the live snapshot and
 * persists to the stored record through the same write path the approvals
 * deliver hook uses) WITHOUT sending any message. "This is my agent, you
 * take care of it": adoption flips the target into verifier scope
 * "commander" and follow-up machinery turns. First adoption wins (idempotent
 * — an already-stamped agent stays stamped, never re-stamped).
 */
async function applyAdoptAgent(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const agentId = plan.targetId!;
  const live = deps.agentManager.getAgent(agentId);
  const storedLabels = live
    ? live.labels
    : ((await deps.agentStorage.get(agentId).catch(() => null))?.labels ?? {});
  const existing = storedLabels[COMMANDER_ADOPTED_AT_LABEL];
  if (typeof existing === "string" && existing.trim().length > 0) {
    logMetaEvent(deps, plan, "mission_control.meta.adopt_agent_already_adopted", {
      agentId,
      adoptedAt: existing,
    });
    return { ok: true, summary: `Agent ${agentId} was already adopted (${existing})` };
  }
  const adoptedAt = new Date().toISOString();
  try {
    await deps.agentManager.setLabels(agentId, { [COMMANDER_ADOPTED_AT_LABEL]: adoptedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to stamp adoption on agent ${agentId}: ${message}` };
  }
  const after = await resolveAgentRecord(deps, agentId);
  if (after && !after.live) {
    await safeEmitStoredAgentUpdate(deps, after.record);
  }
  logMetaEvent(deps, plan, "mission_control.meta.adopt_agent_applied", {
    agentId,
    adoptedAt,
  });
  return { ok: true, summary: `Adopted agent ${agentId} (no message sent)` };
}

/**
 * M8b release_agent: clear paseo.commander-adopted-at so the Commander stops
 * managing the worker (verifier scope "commander" no longer includes it).
 * Requires the stamp to already be present (validateReleaseAgent enforces).
 */
async function applyReleaseAgent(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const agentId = plan.targetId!;
  try {
    await deps.agentManager.setLabels(agentId, { [COMMANDER_ADOPTED_AT_LABEL]: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to release agent ${agentId}: ${message}` };
  }
  const after = await resolveAgentRecord(deps, agentId);
  if (after && !after.live) {
    await safeEmitStoredAgentUpdate(deps, after.record);
  }
  logMetaEvent(deps, plan, "mission_control.meta.release_agent_applied", { agentId });
  return { ok: true, summary: `Released agent ${agentId} from Commander management` };
}

/**
 * Apply a validated meta plan: the action switch. Logs every applied action
 * loudly (module mission-control, component meta) with the full plan so the
 * audit trail shows exactly what the Commander did and when.
 */
export async function applyMetaPlan(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
): Promise<MetaPlanActionResult> {
  const validation = await validateMetaPlan(deps, plan);
  if (!validation.ok) {
    return validation;
  }
  switch (plan.action) {
    case "rename_project":
      return applyRenameProject(deps, plan);
    case "rename_workspace":
      return applyRenameWorkspace(deps, plan);
    case "rename_agent_title":
      return applyRenameAgentTitle(deps, plan);
    case "archive_project":
      return applyArchiveProject(deps, plan);
    case "archive_workspace":
      return applyArchiveWorkspace(deps, plan);
    case "archive_agent":
      return applyArchiveAgent(deps, plan);
    case "create_project":
      return applyCreateProject(deps, plan);
    case "move_agent":
      return applyMoveAgent(deps, plan);
    case "promote_workspace":
      return applyPromoteWorkspace(deps, plan);
    case "adopt_agent":
      return applyAdoptAgent(deps, plan);
    case "release_agent":
      return applyReleaseAgent(deps, plan);
  }
}

async function safeEmitStoredAgentUpdate(
  deps: MetaActionsDependencies,
  record: StoredAgentRecord,
): Promise<void> {
  try {
    await deps.emitStoredAgentUpdate(record);
  } catch (error) {
    deps.logger.warn(
      { module: "mission-control", component: "meta", agentId: record.id, err: error },
      "mission_control.meta.stored_agent_update_emit_failed",
    );
  }
}

/**
 * The approvals-gate entry point: apply the meta plan carried by an approved
 * meta-kind proposal. Resolves the plan's target host (metaPlan.serverId)
 * through the fleet map and routes:
 *   - local (absent / "local" / this daemon's own ids) → apply against THIS
 *     daemon's registries;
 *   - a peer → forward the validated-shape plan over peering
 *     (mission_control.meta.apply → fleetMetaApply); the PEER re-validates
 *     against ITS registries and applies there. Only the apply hops — the
 *     proposal/card stays on this (commander) host, gate unchanged.
 * Unknown hosts are refused (the fleet map may have changed since the gate).
 * Fails loudly with a plain error so the gate logs it and never bounces the
 * proposal back to pending (the same contract as spawn).
 */
export async function applyMetaFromProposal(
  deps: MetaActionsDependencies,
  proposal: MissionControlProposal,
): Promise<{ ok: true; metaAppliedOnHost?: string } | { ok: false; error: string }> {
  const plan = proposal.metaPlan;
  if (!plan) {
    return { ok: false, error: "Meta proposal has no meta plan" };
  }
  const target = resolveMetaTargetHost(deps, plan.serverId);
  if (!target.ok) {
    deps.logger.error(
      {
        module: "mission-control",
        component: "meta",
        proposalId: proposal.id,
        action: plan.action,
        error: target.error,
      },
      "mission_control.meta.target_host_unknown",
    );
    return { ok: false, error: target.error };
  }
  if (target.kind === "peer") {
    return applyMetaPlanOnPeer(deps, plan, proposal.id, target);
  }
  const result = await applyMetaPlan(deps, plan);
  if (!result.ok) {
    return result;
  }
  deps.logger.info(
    {
      module: "mission-control",
      component: "meta",
      proposalId: proposal.id,
      targetHost: target.label,
      summary: result.summary,
    },
    "mission_control.meta.proposal_applied",
  );
  return { ok: true, metaAppliedOnHost: target.label };
}

/**
 * Peer branch of applyMetaFromProposal: forward the validated-shape plan to
 * the target host over peering (mirrors the fleet_create_agent peer path —
 * getPeerClient → correlated session RPC). The peer validates the plan
 * against ITS OWN registries and applies; the result carries the peer's
 * identity so this host's audit trail records where the action ran.
 */
async function applyMetaPlanOnPeer(
  deps: MetaActionsDependencies,
  plan: MissionControlMetaPlan,
  proposalId: string,
  target: Extract<ResolvedMetaTarget, { ok: true; kind: "peer" }>,
): Promise<{ ok: true; metaAppliedOnHost?: string } | { ok: false; error: string }> {
  const peerStatus = deps.peerManager?.getPeerStatus(target.peerName) ?? null;
  if (!peerStatus || peerStatus.state !== "online") {
    const error = `Host "${target.peerName}" is not an online peer`;
    deps.logger.error(
      { module: "mission-control", component: "meta", proposalId, peer: target.peerName, error },
      "mission_control.meta.peer_unreachable",
    );
    return { ok: false, error };
  }
  const client = deps.peerManager?.getPeerClient(target.peerName) ?? null;
  if (!client) {
    const error = `Host "${target.peerName}" has no peer client`;
    deps.logger.error(
      { module: "mission-control", component: "meta", proposalId, peer: target.peerName, error },
      "mission_control.meta.peer_client_unavailable",
    );
    return { ok: false, error };
  }
  try {
    const payload = await client.fleetMetaApply(plan);
    if (!payload.ok) {
      const error = payload.error ?? `Meta apply on "${target.peerName}" failed`;
      deps.logger.error(
        {
          module: "mission-control",
          component: "meta",
          proposalId,
          peer: target.peerName,
          action: plan.action,
          error,
        },
        "mission_control.meta.proposal_applied_peer_failed",
      );
      return { ok: false, error };
    }
    deps.logger.info(
      {
        module: "mission-control",
        component: "meta",
        proposalId,
        targetHost: target.peerName,
        targetServerId: payload.serverId,
        targetHostName: payload.hostName,
        action: plan.action,
        summary: payload.summary,
      },
      "mission_control.meta.proposal_applied",
    );
    return { ok: true, metaAppliedOnHost: target.peerName };
  } catch (error) {
    const message = `fleet meta apply failed: ${String(error)}`;
    deps.logger.error(
      {
        module: "mission-control",
        component: "meta",
        proposalId,
        peer: target.peerName,
        err: error,
      },
      "mission_control.meta.proposal_applied_peer_error",
    );
    return { ok: false, error: message };
  }
}

/** True when the action must always ask (destructive), even in auto mode. */
export function isDestructiveMetaAction(action: MissionControlMetaPlan["action"]): boolean {
  return (
    action === "archive_project" || action === "archive_workspace" || action === "archive_agent"
  );
}
