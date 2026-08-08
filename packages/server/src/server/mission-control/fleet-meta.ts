import type { MissionControlMetaPlan } from "@getpaseo/protocol/mission-control/types";
import type { ProposalCreateInput } from "./approvals.js";
import {
  isDestructiveMetaAction,
  resolveExperimentsProject,
  validateMetaPlan,
  type MetaActionsLookupDependencies,
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
 * targetAgentId convention (M4): "" for project/workspace actions (the
 * proposal card event falls back to the Commander's id), the real agent id
 * for agent-targeted actions (rename_agent_title, archive_agent, move_agent).
 */

export interface BuildFleetMetaProposalInput {
  serverId: string;
  metaPlan: MissionControlMetaPlan;
  /** Live-state lookups for validation (registries + agent records). */
  lookup: MetaActionsLookupDependencies;
}

function describeMetaPlan(plan: MissionControlMetaPlan): string {
  const target = plan.targetLabel?.trim() || plan.targetId?.trim() || "(target)";
  const newValue = plan.newValue?.trim() ?? "";
  const destination = plan.destination?.trim() ?? "";
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
  }
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
  const validation = await validateMetaPlan(lookup, metaPlan);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  // Agent-targeted actions carry a real targetAgentId on the proposal
  // (M4 convention); project/workspace actions use "" (the proposal event
  // falls back to the Commander's id).
  const agentTargeted =
    metaPlan.action === "rename_agent_title" ||
    metaPlan.action === "archive_agent" ||
    metaPlan.action === "move_agent";
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

export { isDestructiveMetaAction, resolveExperimentsProject };
