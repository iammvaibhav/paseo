import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";
import type {
  MissionControlEvent,
  MissionControlInboxFetchResponse,
  MissionControlInboxReviewFact,
  MissionControlProposal,
} from "@getpaseo/protocol/mission-control/types";
import { COMMANDER_ADOPTED_AT_LABEL } from "./commander-contract.js";
import { countDistinctProofs } from "./run-records.js";
import type { MissionControlReviewStateRecord } from "./store.js";

/**
 * The pending inbox (mission_control.inbox.fetch): what waits on the user on
 * this host, derived from stored state only — the approval index, the
 * review-state store, and the retained event store. Pure; the service
 * gathers the inputs.
 */
export type MissionControlInbox = Omit<MissionControlInboxFetchResponse["payload"], "requestId">;

/** The identity slice a review row needs (live agent first, stored record fallback). */
export interface InboxAgentIdentity {
  labels: Record<string, string>;
  internal: boolean;
  archived: boolean;
}

export interface InboxInput {
  proposals: readonly MissionControlProposal[];
  /** Retained events in any order, superseded events included. */
  events: readonly MissionControlEvent[];
  reviewStates: ReadonlyMap<string, MissionControlReviewStateRecord>;
  /** Identity per ready agent; agents missing here have no record and are skipped. */
  agents: ReadonlyMap<string, InboxAgentIdentity>;
  /** The Commander on THIS host; null on every other host. */
  localCommander: { agentId: string; lastUserMessageAt: string | null } | null;
  /** The fleet Commander's id (local, or the commander host's) for the dispatch marker. */
  fleetCommanderAgentId: string | null;
}

export function buildMissionControlInbox(input: InboxInput): MissionControlInbox {
  // Append order: seq is monotonic; ts breaks ties for pre-seq rows.
  const chronological = [...input.events].sort(
    (left, right) => (left.seq ?? -1) - (right.seq ?? -1) || left.ts.localeCompare(right.ts),
  );
  return {
    // Oldest first, newest last.
    pendingProposals: input.proposals
      .filter((proposal) => proposal.status === "pending" && proposal.verboseOnly !== true)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    openClarifications: input.localCommander
      ? selectOpenClarifications(chronological, input.localCommander)
      : [],
    review: selectReviewFacts(input, chronological),
  };
}

/**
 * The Commander's clarification cards newer than its last user message: the
 * user answers a clarification with a plain message to the Commander thread,
 * so any user message after the card closes it.
 */
function selectOpenClarifications(
  chronological: readonly MissionControlEvent[],
  commander: { agentId: string; lastUserMessageAt: string | null },
): MissionControlEvent[] {
  const answeredAtMs =
    commander.lastUserMessageAt === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(commander.lastUserMessageAt);
  return chronological.filter(
    (event) =>
      event.kind === "clarification" &&
      event.agentId === commander.agentId &&
      Date.parse(event.ts) > answeredAtMs,
  );
}

function selectReviewFacts(
  input: InboxInput,
  chronological: readonly MissionControlEvent[],
): MissionControlInboxReviewFact[] {
  const eventsByAgent = new Map<string, MissionControlEvent[]>();
  for (const [agentId, record] of input.reviewStates) {
    if (record.reviewState === "ready") {
      eventsByAgent.set(agentId, []);
    }
  }
  for (const event of chronological) {
    eventsByAgent.get(event.agentId)?.push(event);
  }
  const facts: MissionControlInboxReviewFact[] = [];
  for (const [agentId, agentEvents] of eventsByAgent) {
    const readyAt = input.reviewStates.get(agentId)?.updatedAt ?? null;
    const agent = input.agents.get(agentId);
    // Not a reviewable item: a row without updatedAt (the store stamps it on
    // every ready write, so it is malformed on disk), an agent with no record,
    // an archived or internal agent, or a system-owned one (Commander,
    // verifiers, machinery).
    if (
      readyAt === null ||
      !agent ||
      agent.archived ||
      agent.internal ||
      isSystemOwnedAgentLabels(agent.labels)
    ) {
      continue;
    }
    // The current run: every event after the agent's newest `started` card.
    // Run epochs cannot bound it — a daemon restart bumps every agent's epoch
    // while the item stays ready — and a new user run resets the review
    // state, so while the item is ready no later run exists. When the
    // `started` card has aged out of retention, every retained event is
    // newer than it (findLastIndex -1 → the whole list).
    const runStart = agentEvents.findLastIndex((event) => event.kind === "started") + 1;
    const run = agentEvents.slice(runStart);
    const insufficientVerdict = resolveInsufficientVerdict(run);
    facts.push({
      agentId,
      reviewState: "ready",
      ...(insufficientVerdict ? { insufficientVerdict } : {}),
      proofCount: countDistinctProofs(run),
      dispatched: isCommanderDispatched(agent.labels, input.fleetCommanderAgentId),
      readyAt,
    });
  }
  return facts.sort(
    (left, right) =>
      left.readyAt.localeCompare(right.readyAt) || left.agentId.localeCompare(right.agentId),
  );
}

/**
 * The newest verdict of the run, when it did not resolve the item: a
 * verifier card without the stateOnly stamp. A newer state-only verdict
 * (Mark done / Clear / verifier done) settled the earlier one.
 */
function resolveInsufficientVerdict(
  run: readonly MissionControlEvent[],
): MissionControlInboxReviewFact["insufficientVerdict"] {
  const verdict = run.findLast((event) => event.kind === "verdict");
  if (!verdict || verdict.stateOnly === true || verdict.source !== "verifier") {
    return undefined;
  }
  return { summary: verdict.detail?.trim() || verdict.headline, at: verdict.ts };
}

/**
 * Commander-dispatched: spawned by the Commander (paseo.parent-agent-id names
 * it) or adopted by a delivered fleet_send_prompt (paseo.commander-adopted-at).
 */
function isCommanderDispatched(
  labels: Record<string, string>,
  fleetCommanderAgentId: string | null,
): boolean {
  const parentAgentId = getParentAgentIdFromLabels(labels);
  if (fleetCommanderAgentId !== null && parentAgentId === fleetCommanderAgentId) {
    return true;
  }
  const adoptedAt = labels[COMMANDER_ADOPTED_AT_LABEL];
  return typeof adoptedAt === "string" && adoptedAt.trim().length > 0;
}
