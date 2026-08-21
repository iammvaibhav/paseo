import type {
  MissionControlMetaPlan,
  MissionControlProposal,
  MissionControlProposalMetaPlanAction,
} from "@getpaseo/protocol/mission-control/types";
import type { ProposalCreateInput } from "./approvals.js";
import { formatShortId, type FleetIdResolution } from "./fleet-id-index.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import {
  isDestructiveMetaAction,
  resolveExperimentsProject,
  resolveMetaTargetHost,
  validateMetaPlan,
  validateMetaPlanShape,
  type MetaActionsLookupDependencies,
  type MetaPeerManager,
} from "./meta-actions.js";

/**
 * M5 fleet_meta tool (Commander): the proposal builder for the approval gate.
 * `buildFleetMetaProposalInput` validates the incoming metaPlan against live
 * fleet state (target exists, rename non-empty, promote source is a workspace
 * in the per-host experiments project) and produces the meta-kind
 * ProposalCreateInput the gate decides on. The paseo-tools `fleet_meta`
 * registration routes through `runCommanderGatedAction`, which calls this
 * builder, then creates the proposal (ask mode holds the card, auto mode
 * applies, archive actions classify destructive so they ALWAYS ask). On
 * approval the daemon applies the action through the metaFromProposal hook
 * (bootstrap) — see meta-actions.ts.
 *
 * Cross-host: `metaPlan.serverId` names the target host ("local" or a peer
 * name). The builder resolves it through the same fleet map fleet_create_agent
 * uses; an UNKNOWN host is a validation refusal before the gate (tool error,
 * never a card). Local targets validate against THIS host's registries; peer
 * targets can only be shape-validated here (their registry state lives on the
 * target) — the apply routes over peering and the peer validates against ITS
 * registries (see applyMetaFromProposal).
 *
 * targetAgentId convention (M4): "" for project/workspace actions (the
 * proposal card event falls back to the Commander's id), the real agent id
 * for agent-targeted actions (rename_agent_title, archive_agent, move_agent).
 */

export interface BuildFleetMetaProposalInput {
  serverId: string;
  /** This daemon's OS hostname (optional — the tool catalog lacks it). */
  hostName?: string;
  /** This daemon's mission-control host alias (missionControl.hostAlias). */
  hostAlias?: string | null;
  /** The fleet map (peer-manager) the target host resolves through. */
  peerManager?: MetaPeerManager | null;
  metaPlan: MissionControlMetaPlan;
  /** Live-state lookups for validation (registries + agent records). */
  lookup: MetaActionsLookupDependencies;
}

function describeMetaPlan(plan: MissionControlMetaPlan): string {
  const target = plan.targetLabel?.trim() || plan.targetId?.trim() || "(target)";
  const newValue = plan.newValue?.trim() ?? "";
  const destination = plan.destination?.trim() ?? "";
  const base = (() => {
    switch (plan.action) {
      case "rename_project":
        return `Rename project ${target} to "${newValue}"`;
      case "rename_workspace":
        return `Rename workspace ${target} to "${newValue}"`;
      case "rename_agent_title":
        return `Rename agent ${target} title to "${newValue}"`;
      case "archive_project":
        return `Archive project ${target}`;
      case "archive_workspace":
        return `Archive workspace ${target}`;
      case "archive_agent":
        return `Archive agent ${target}`;
      case "create_project":
        return `Create project at ${destination}`;
      case "move_agent":
        return `Move agent ${target} to workspace ${destination}`;
      case "promote_workspace":
        return `Promote workspace ${target} to its own project`;
      case "adopt_agent":
        return `Adopt agent ${target} (take over its lifecycle, no message sent)`;
      case "release_agent":
        return `Release agent ${target} from Commander management`;
    }
  })();
  // The card must read as fleet-wide: a non-local target names the host it
  // applies to (the proposal event detail — event.detail — is this message).
  const host = plan.serverId?.trim();
  return host && host !== "local" ? `${base} on ${host}` : base;
}

/**
 * Validate the plan against live state and build the gate payload. Throws a
 * plain Error on invalid plans (the tool surfaces it as a tool error so the
 * Commander can fix the argument and retry — never a proposal for nonsense).
 */
export async function buildFleetMetaProposalInput(
  input: BuildFleetMetaProposalInput,
): Promise<ProposalCreateInput> {
  const { serverId, metaPlan, lookup } = input;
  // Resolve the target host BEFORE any registry validation: a plan aimed at a
  // peer must not be judged against THIS host's registries (the bug that put
  // a create_project aimed at a peer into the commander's own registry), and
  // an unknown host is refused here, before the gate.
  const target = resolveMetaTargetHost(
    {
      serverId,
      hostName: input.hostName,
      hostAlias: input.hostAlias,
      peerManager: input.peerManager,
    },
    metaPlan.serverId,
  );
  if (!target.ok) {
    throw new Error(target.error);
  }
  if (target.kind === "peer") {
    // The target's registry state is unreachable from here: validate only the
    // host-independent plan shape. The apply routes over peering and the
    // target re-validates the full plan against ITS registries.
    const shape = await validateMetaPlanShape(metaPlan);
    if (!shape.ok) {
      throw new Error(shape.error);
    }
  } else {
    const validation = await validateMetaPlan(lookup, metaPlan);
    if (!validation.ok) {
      throw new Error(validation.error);
    }
  }
  // Agent-targeted actions carry a real targetAgentId on the proposal
  // (M4 convention); project/workspace actions use "" (the proposal event
  // falls back to the Commander's id).
  const agentTargeted =
    metaPlan.action === "rename_agent_title" ||
    metaPlan.action === "archive_agent" ||
    metaPlan.action === "move_agent" ||
    metaPlan.action === "adopt_agent" ||
    metaPlan.action === "release_agent";
  const targetAgentId = agentTargeted ? (metaPlan.targetId?.trim() ?? "") : "";
  return {
    origin: "commander",
    serverId,
    targetAgentId,
    message: describeMetaPlan(metaPlan),
    deliveryMode: "interrupt",
    reason: "Commander meta action",
    classification: isDestructiveMetaAction(metaPlan.action) ? "destructive" : "normal",
    kind: "meta",
    metaPlan,
  };
}

/** Destructive-classification hook for runCommanderGatedAction (authoritative
 *  over the builder's classification). */
export function classifyFleetMetaAction(
  metaPlan: MissionControlMetaPlan,
): "normal" | "destructive" {
  return isDestructiveMetaAction(metaPlan.action) ? "destructive" : "normal";
}

export { isDestructiveMetaAction, resolveExperimentsProject, resolveMetaTargetHost };

// ============================================================================
// 04 — fleet_meta split: the 11 flat per-action tools. Each tool resolves its
// bare id through the fleet id index (02), validates family + existence at
// call time (03 error contract: candidates + resolver guidance), and builds
// the IDENTICAL metaPlan proposal payload the old fleet_meta built — zero
// protocol change; the approval gate, the peer-forward apply, and the
// proposal card rendering are untouched.
// ============================================================================

/** Live lookups the split meta tools need: existence plus list access for
 *  candidate-listing errors. A structural superset of
 *  MetaActionsLookupDependencies, so the same object also feeds
 *  buildFleetMetaProposalInput. */
export interface SplitMetaLookupDependencies {
  agentManager: Pick<AgentManager, "getAgent">;
  agentStorage: Pick<AgentStorage, "get" | "list">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list">;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
}

/** A flat, schema-validated call to one of the 11 split meta tools. */
export interface SplitMetaToolArgs {
  action: MissionControlProposalMetaPlanAction;
  /** The id family of `targetId`; "create-project" has no id (host + path). */
  kind: "agent" | "workspace" | "project" | "create-project";
  targetId?: string;
  /** Optional host hint — ids are fleet-wide; required for create_project. */
  host?: string;
  /** rename_* title; create_project display name. */
  newValue?: string;
  /** move_agent target workspace id; create_project root path. */
  destination?: string;
  /** M8 instruction ledger: the open instruction id this dispatch answers. */
  respondsTo?: string;
}

export interface SplitMetaToolDeps {
  serverId: string;
  hostAlias?: string | null;
  peerManager?: MetaPeerManager | null;
  lookup: SplitMetaLookupDependencies;
  /** The fleet id index (02): bare id -> owning host ("local" or peer name). */
  resolveFleetId: (id: string) => Promise<FleetIdResolution>;
  /** This daemon's display host label ("local" or the configured alias). */
  hostLabel: string;
}

type ResolvedMetaToolTarget =
  | { ok: true; host: string; label?: string }
  | { ok: false; error: string };

/** Same-fleet-host comparison as the fleet tools (this daemon's own aliases
 *  count as "local"; peer names compare case-insensitively). */
function metaHostsMatch(deps: SplitMetaToolDeps, hostA: string, hostB: string): boolean {
  const localA = resolveMetaTargetHost(deps, hostA);
  const localB = resolveMetaTargetHost(deps, hostB);
  if (localA.ok && localA.kind === "local" && localB.ok && localB.kind === "local") {
    return true;
  }
  return hostA.trim().toLowerCase() === hostB.trim().toLowerCase();
}

async function lookupLocalMetaTarget(
  deps: SplitMetaToolDeps,
  kind: "agent" | "workspace" | "project",
  id: string,
): Promise<{ label?: string } | null> {
  if (kind === "agent") {
    const live = deps.lookup.agentManager.getAgent(id);
    if (live) {
      return { label: live.name };
    }
    const record = await deps.lookup.agentStorage.get(id);
    return record ? { label: record.name } : null;
  }
  if (kind === "workspace") {
    const record = await deps.lookup.workspaceRegistry.get(id);
    return record ? { label: record.title ?? record.displayName } : null;
  }
  const record = await deps.lookup.projectRegistry.get(id);
  return record ? { label: record.customName ?? record.displayName } : null;
}

/** Candidate-listing refusals (03): the offending field, live candidates,
 *  and the resolver tool that returns the model a fresh id. */
async function metaTargetCandidatesError(
  deps: SplitMetaToolDeps,
  kind: "agent" | "workspace" | "project",
  id: string,
): Promise<string> {
  const short = formatShortId(id);
  if (kind === "agent") {
    const records = await deps.lookup.agentStorage.list();
    const nearest = records
      .filter((record) => !record.archivedAt)
      .slice(0, 3)
      .map((record) => `${record.name} (${formatShortId(record.id)})`);
    const candidates = nearest.length > 0 ? ` Nearest: ${nearest.join(", ")}.` : "";
    return `Agent ${short} not found on this host.${candidates} Call fleet_list_agents(query) to resolve.`;
  }
  if (kind === "workspace") {
    const records = await deps.lookup.workspaceRegistry.list();
    const listed = records
      .filter((record) => !record.archivedAt)
      .slice(0, 5)
      .map(
        (record) => `${formatShortId(record.workspaceId)} '${record.title ?? record.displayName}'`,
      );
    const candidates = listed.length > 0 ? ` This host has: ${listed.join(", ")}.` : "";
    return `Workspace ${short} not found on this host.${candidates} Call fleet_list_inventory to resolve.`;
  }
  const records = await deps.lookup.projectRegistry.list();
  const listed = records
    .filter((record) => !record.archivedAt)
    .slice(0, 5)
    .map(
      (record) => `${formatShortId(record.projectId)} '${record.customName ?? record.displayName}'`,
    );
  const candidates = listed.length > 0 ? ` This host has: ${listed.join(", ")}.` : "";
  return `Project ${short} not found on this host.${candidates} Call fleet_list_inventory to resolve.`;
}

/**
 * Call-time id resolution for the split meta tools (02): explicit host hint
 * validated (mismatch names the actual host), else local first then the
 * fleet id index. Every refusal lists candidates or carries the index's
 * resolver guidance so the model self-corrects in one step.
 */
async function resolveMetaToolTarget(
  deps: SplitMetaToolDeps,
  kind: "agent" | "workspace" | "project",
  id: string,
  hostHint: string | undefined,
): Promise<ResolvedMetaToolTarget> {
  const displayHost = (host: string): string => (host === "local" ? deps.hostLabel : host);
  if (hostHint) {
    const target = resolveMetaTargetHost(deps, hostHint);
    if (!target.ok) {
      return { ok: false, error: target.error };
    }
    if (target.kind === "local") {
      const local = await lookupLocalMetaTarget(deps, kind, id);
      if (local) {
        return { ok: true, host: "local", label: local.label };
      }
      return { ok: false, error: await metaTargetCandidatesError(deps, kind, id) };
    }
    // Peer hint: never silently trusted — the index knows where the id
    // lives; a mismatch names the actual host.
    const resolution = await deps.resolveFleetId(id);
    if (resolution.kind === "unknown") {
      return { ok: false, error: resolution.guidance };
    }
    if (!metaHostsMatch(deps, target.peerName, resolution.host)) {
      return {
        ok: false,
        error: `${kind} ${formatShortId(id)} is on host "${displayHost(resolution.host)}", not "${hostHint}"`,
      };
    }
    return { ok: true, host: resolution.host };
  }
  // No hint: local registries are live; the index adds the peers.
  const local = await lookupLocalMetaTarget(deps, kind, id);
  if (local) {
    return { ok: true, host: "local", label: local.label };
  }
  const resolution = await deps.resolveFleetId(id);
  if (resolution.kind === "unknown") {
    return { ok: false, error: resolution.guidance };
  }
  if (resolution.kind !== kind) {
    return {
      ok: false,
      error: `${kind} ${formatShortId(id)} resolved as a ${resolution.kind} id, not a ${kind} id. Call fleet_list_agents or fleet_list_inventory to resolve.`,
    };
  }
  if (resolution.host === "local") {
    // Stale index vs live registries: re-check locally so the label and the
    // candidate-listing error contract still hold.
    const localRetry = await lookupLocalMetaTarget(deps, kind, id);
    if (!localRetry) {
      return { ok: false, error: await metaTargetCandidatesError(deps, kind, id) };
    }
    return { ok: true, host: "local", label: localRetry.label };
  }
  return { ok: true, host: resolution.host };
}

/**
 * The split-tool proposal builder: resolve the bare id, build the metaPlan
 * (same fields the old fleet_meta accepted — action, serverId, targetId,
 * targetLabel, newValue, destination), then delegate to
 * buildFleetMetaProposalInput so approval/apply/peer-forward paths are
 * byte-identical. Throws a plain Error on invalid calls (the tool surfaces
 * it as a tool error so the Commander fixes the argument and retries).
 */
export async function buildSplitMetaProposalInput(
  deps: SplitMetaToolDeps,
  args: SplitMetaToolArgs,
): Promise<ProposalCreateInput> {
  const { action, kind, targetId, host, newValue, destination, respondsTo } = args;
  const metaPlan: MissionControlMetaPlan = { action };
  if (kind === "create-project") {
    // No id: the new project root must land on an explicit host (the schema
    // requires host). Resolve through the same fleet map the meta executor
    // uses — unknown hosts are refused before the gate.
    const target = resolveMetaTargetHost(deps, host);
    if (!target.ok) {
      throw new Error(target.error);
    }
    metaPlan.serverId = target.label;
    if (destination) {
      metaPlan.destination = destination;
    }
    if (newValue) {
      metaPlan.newValue = newValue;
    }
  } else {
    const id = targetId?.trim() ?? "";
    if (!id) {
      throw new Error(`${action} requires a ${kind} id`);
    }
    const target = await resolveMetaToolTarget(deps, kind, id, host);
    if (!target.ok) {
      throw new Error(target.error);
    }
    metaPlan.serverId = target.host;
    metaPlan.targetId = id;
    if (target.label) {
      metaPlan.targetLabel = target.label;
    }
    if (newValue) {
      metaPlan.newValue = newValue;
    }
    if (destination) {
      metaPlan.destination = destination;
    }
  }
  const proposalInput = await buildFleetMetaProposalInput({
    serverId: deps.serverId,
    hostAlias: deps.hostAlias,
    peerManager: deps.peerManager,
    metaPlan,
    lookup: deps.lookup,
  });
  return respondsTo ? { ...proposalInput, respondsTo } : proposalInput;
}

/** The structured outcome every meta tool reports (same as fleet_meta today):
 *  pending card vs applied. */
export function formatMetaToolOutcome(proposal: MissionControlProposal): Record<string, unknown> {
  if (proposal.status === "pending") {
    return {
      ok: true,
      status: "pending",
      proposalId: proposal.id,
      guidance: `Meta action sent for approval (proposal ${proposal.id}). It will be applied once approved.`,
    };
  }
  return {
    ok: true,
    status: "sent",
    proposalId: proposal.id,
    guidance: `Meta action applied (proposal ${proposal.id}).`,
  };
}
