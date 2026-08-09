import type { MissionControlMetaPlan } from "@getpaseo/protocol/mission-control/types";
import type { ProposalCreateInput } from "./approvals.js";
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
    metaPlan.action === "adopt_agent";
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
