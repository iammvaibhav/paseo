import { isAbsolute } from "node:path";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { MissionControlProposalSpawnPlan } from "@getpaseo/protocol/mission-control/types";

import { resolveMetaTargetHost, type MetaTargetResolutionDependencies } from "./meta-actions.js";

/**
 * The single execution path for approved spawn-kind proposals (Commander
 * fleet_create_agent in ask mode; auto mode runs the same hook) and the
 * target-host side of a peer-routed spawn.
 *
 * Two live-confirmed bugs this module fixes at the source:
 *  - OWN-ALIAS REFUSED: a plan whose `host` is THIS daemon's own
 *    missionControl.hostAlias (the world snapshot teaches the Commander the
 *    aliases: "local (alias \"alpha\")") used to fall into the peer branch
 *    ("Host \"alpha\" is not an online peer"). Host strings resolve through
 *    the SAME fleet map the meta executor uses (resolveMetaTargetHost):
 *    absent / "local" / own serverId / own hostname / own alias → local;
 *    a peer name → that peer; anything else is refused loudly.
 *  - MISSING-CWD REFUSED: a plan whose absolute cwd does not exist used to
 *    fail deep in the create path ("Working directory does not exist").
 *    Approval of the card IS consent for the shown cwd: the executor creates
 *    an ABSOLUTE cwd with mkdir recursive before spawning. Relative and
 *    `~`-prefixed cwds still refuse (the card never showed a resolved target
 *    for those). For peer targets the mkdir happens on the TARGET host (the
 *    peer apply handler below), never on the commander's disk.
 *
 * The commander also stamps paseo.parent-agent-id = the commander agent id at
 * execution time (BUG-4): without it spawned workers land with labels:{}, so
 * isDispatchedByCommander() is false and the finished-event machinery
 * follow-up is silently gated. The peer-routed plan carries the stamped label
 * over the wire, so the TARGET host persists it in ITS registry.
 *
 * Every successful spawn also returns the serverId of the host that actually
 * ran it (spawnedOnServerId): local spawns carry this daemon's serverId, peer
 * spawns the peer's (from the spawn.apply response, which the applying daemon
 * stamps with its own identity — mirroring mission_control.meta.apply). The
 * approvals gate stamps it onto the proposal so the app opens the spawned
 * agent against the executing host, never the card's emitting host (the
 * Commander's).
 */

/**
 * A spawn attempt result. Every SUCCESSFUL spawn records the serverId of the
 * host that actually created the agent — this daemon for local spawns, the
 * peer for peer-routed spawns (the commander's audit trail stamps it onto the
 * proposal as spawnedOnServerId so the app opens the agent against the right
 * host, never the emitting Commander host).
 */
export type SpawnExecutorResult =
  | { ok: true; agentId: string; serverId?: string }
  | { ok: false; error: string };

export interface SpawnExecutorDependencies {
  /**
   * This daemon's host identity + fleet map for the plan's `host` resolution
   * (own alias → local, peer name → peer).
   */
  host: MetaTargetResolutionDependencies;
  /**
   * Whether to stamp paseo.parent-agent-id on the plan before dispatching.
   * Commander-origin spawns (fleet_create_agent) stamp; verifier spawns do
   * not (their workers are not Commander-dispatched).
   */
  stampCommanderParentLabel: boolean;
  /** The commander's agent id (label value). Null → no stamp. */
  resolveCommanderAgentId: () => Promise<string | null>;
  /** mkdir -p for absolute spawn cwds, on THIS host's filesystem. */
  mkdirp: (dirPath: string) => Promise<void>;
  /**
   * Create the agent on THIS host (the local create-agent command). Receives
   * the fully prepared plan — absolute cwd already ensured, labels already
   * stamped — and the split "provider/model" string the local MCP create
   * path consumes. The ok result carries THIS host's serverId (the host the
   * spawn actually ran on).
   */
  createLocally: (
    plan: MissionControlProposalSpawnPlan,
    providerModel: string,
  ) => Promise<SpawnExecutorResult>;
  /**
   * Route the prepared plan to a PEER (the peer apply RPC
   * mission_control.spawn.apply). The peer validates + mkdirs + creates on
   * ITS host; this host never touches the peer's filesystem. The ok result
   * carries the PEER's serverId (the host the spawn actually ran on).
   */
  createOnPeer: (
    peerName: string,
    plan: MissionControlProposalSpawnPlan,
  ) => Promise<SpawnExecutorResult>;
}

/**
 * The cwd contract for an approved spawn: the card showed the cwd, approval
 * is consent — an ABSOLUTE path is created with mkdir recursive by the host
 * that will run the agent. Relative and `~`-prefixed paths never resolve to
 * a concrete target the card could have shown, so they still refuse.
 */
export function validateSpawnCwd(
  cwd: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!cwd) {
    return { ok: true };
  }
  if (!isAbsolute(cwd)) {
    return { ok: false, error: `Spawn cwd must be an absolute path (got "${cwd}")` };
  }
  return { ok: true };
}

/**
 * Commander-side execution of an approved spawn proposal: stamp the parent
 * label, resolve the plan's host through the shared fleet map (own alias →
 * local), enforce the cwd contract, then dispatch — local hosts create here
 * (mkdir first), peers are forwarded (the peer mkdirs on its own disk). The
 * ok result carries the serverId of the host the spawn RAN on (this daemon
 * or the peer), so the caller can stamp spawnedOnServerId on the proposal.
 */
export async function executeSpawnProposal(
  plan: MissionControlProposalSpawnPlan,
  deps: SpawnExecutorDependencies,
): Promise<SpawnExecutorResult> {
  const prepared = await prepareSpawnPlan(plan, deps);
  const target = resolveMetaTargetHost(deps.host, prepared.host);
  if (!target.ok) {
    return { ok: false, error: target.error };
  }
  if (target.kind === "peer") {
    // Fail fast on a relative cwd before forwarding; the PEER creates the
    // absolute cwd on its own disk (never the commander's).
    const cwdCheck = validateSpawnCwd(prepared.cwd);
    if (!cwdCheck.ok) {
      return cwdCheck;
    }
    return deps.createOnPeer(target.peerName, prepared);
  }
  return spawnOnThisHost(prepared, deps);
}

/**
 * Target-host side of a peer-routed spawn (the peer apply handler
 * mission_control.spawn.apply): THIS host validates the cwd contract against
 * its own filesystem, creates the absolute cwd, and creates the agent in its
 * own registry — the mkdir happens here, never on the commander's disk. Also
 * the local branch of executeSpawnProposal. The ok result passes through
 * createLocally's serverId (THIS host's — the host the spawn actually ran
 * on).
 */
export async function spawnOnThisHost(
  plan: MissionControlProposalSpawnPlan,
  deps: Pick<SpawnExecutorDependencies, "mkdirp" | "createLocally">,
): Promise<SpawnExecutorResult> {
  const cwdCheck = validateSpawnCwd(plan.cwd);
  if (!cwdCheck.ok) {
    return cwdCheck;
  }
  if (plan.cwd) {
    await deps.mkdirp(plan.cwd);
  }
  return deps.createLocally(plan, plan.model ? `${plan.provider}/${plan.model}` : plan.provider);
}

async function prepareSpawnPlan(
  plan: MissionControlProposalSpawnPlan,
  deps: SpawnExecutorDependencies,
): Promise<MissionControlProposalSpawnPlan> {
  if (!deps.stampCommanderParentLabel) {
    return plan;
  }
  const commanderId = await deps.resolveCommanderAgentId();
  if (!commanderId) {
    return plan;
  }
  return { ...plan, labels: { ...plan.labels, [PARENT_AGENT_ID_LABEL]: commanderId } };
}
