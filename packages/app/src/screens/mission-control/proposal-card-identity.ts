import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";

/**
 * App-composed proposal card identity (title, byline chip, plan-chip agent
 * label). Mission Control stamps every feed event with a title snapshot at
 * emit time, but for cards whose subject is an agent the daemon could not name
 * (verifier spawns targeting an unnamed worker, cross-host adopt/meta cards),
 * the snapshot falls back to the raw agent id. Those opaque ids are plumbing,
 * never display copy: this module resolves them to a live fleet identity
 * across EVERY host session (agents + agentDetails, including peer hosts and
 * archived agents), prefers an alias the record already carries
 * (metaPlan.targetLabel — the server stamps resolved labels on cross-host
 * actions even when the peer session is not connected), and fails closed to a
 * neutral label (`Agent` / `Verifier`) — a raw UUID must never render.
 *
 * Kept free of component imports so the resolution logic is unit-testable
 * without mounting the unistyles chain (same pattern as proposal-card-chips).
 */

/** Agent ids are UUIDs; the daemon's title fallback is the id itself. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Verifier-agent titles are `Verifier · <subject>` (daemon-generated). */
const VERIFIER_PREFIX = "Verifier · ";
const NEUTRAL_AGENT = "Agent";
const NEUTRAL_VERIFIER = "Verifier";

/** The identity fields a resolver needs from a stored/live agent. */
export interface AgentIdentitySource {
  name?: string | null;
  title?: string | null;
}

/** The subset of a host session's state the resolver reads. */
export interface SessionIdentitySource {
  agents: ReadonlyMap<string, AgentIdentitySource>;
  agentDetails: ReadonlyMap<string, AgentIdentitySource>;
}

/** Every connected host's session state (agents + agentDetails maps). */
export type SessionsIdentitySource = Readonly<Record<string, SessionIdentitySource>> | undefined;

/**
 * The opaque agent id a stored label stands for, or null when the label is
 * already display copy. Recognizes the daemon's two opaque shapes — the raw
 * id itself (exact match against a known id, or any UUID-shaped string) and
 * the verifier form (`Verifier · <id>`).
 */
export function opaqueAgentId(
  label: string,
  knownIds: readonly (string | undefined)[],
): string | null {
  const trimmed = label.trim();
  if (knownIds.some((id) => id && trimmed === id)) {
    return trimmed;
  }
  if (UUID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith(VERIFIER_PREFIX)) {
    const rest = trimmed.slice(VERIFIER_PREFIX.length).trim();
    if (rest.length === 0) {
      return null;
    }
    if (knownIds.some((id) => id && rest === id) || UUID_PATTERN.test(rest)) {
      return rest;
    }
  }
  return null;
}

/**
 * Live identity for an agent id across every host session: `agents` first
 * (active, project-placed), then `agentDetails` (unplaced + archived), in
 * session order. Mirrors resolveSessionAgent's per-session precedence but
 * searches all hosts — a proposal's subject may live on a peer host or be
 * archived on its own.
 */
export function resolveAgentIdentityAcrossSessions(
  sessions: SessionsIdentitySource,
  agentId: string | undefined,
): AgentIdentitySource | null {
  if (!agentId || !sessions) {
    return null;
  }
  for (const session of Object.values(sessions)) {
    const live = session.agents.get(agentId);
    if (live) {
      return live;
    }
    const detail = session.agentDetails.get(agentId);
    if (detail) {
      return detail;
    }
  }
  return null;
}

/**
 * The record's own resolved label for the subject, when it carries one:
 * `metaPlan.targetLabel` (server-stamped on cross-host meta actions even when
 * the peer session is unreachable) unless the label is itself opaque. Null
 * when absent or opaque — callers fall through to session resolution.
 */
export function nonOpaqueMetaTargetLabel(
  proposal: MissionControlProposal,
  knownIds: readonly (string | undefined)[],
): string | null {
  const label = proposal.metaPlan?.targetLabel?.trim();
  if (!label || opaqueAgentId(label, knownIds)) {
    return null;
  }
  return label;
}

/**
 * Resolves an opaque stored label to display copy: the resolved identity's
 * `name ?? title`, wrapped back in the `Verifier · ` prefix when the label
 * had one; unresolved labels fail closed to the neutral `Agent` / `Verifier`
 * (never the raw id). Non-opaque labels pass through as null (no change).
 */
export function resolveOpaqueAgentLabel(
  rawLabel: string,
  knownIds: readonly (string | undefined)[],
  resolveIdentity: (agentId: string) => AgentIdentitySource | null,
): string | null {
  const id = opaqueAgentId(rawLabel, knownIds);
  if (!id) {
    return null;
  }
  const identity = resolveIdentity(id);
  const display = identity ? (identity.name ?? identity.title ?? null) : null;
  if (rawLabel.trim().startsWith(VERIFIER_PREFIX)) {
    return display ? `${VERIFIER_PREFIX}${display}` : NEUTRAL_VERIFIER;
  }
  return display ?? NEUTRAL_AGENT;
}

/** The card's app-composed chrome for the event's stored snapshot. */
export interface ProposalCardIdentityInput {
  agentId?: string;
  agentTitle?: string;
}

/**
 * Derives the proposal card's title and byline chip from the stored event
 * snapshot. Non-opaque stored titles pass through untouched (the frozen
 * snapshot stays the card copy); opaque ones (raw ids / `Verifier · <id>`)
 * resolve to the record's own label, then live fleet identity across all
 * sessions, then the neutral fallback — never the raw id.
 */
export function deriveProposalCardIdentity(
  event: ProposalCardIdentityInput,
  proposal: MissionControlProposal,
  sessions: SessionsIdentitySource,
  hideAgentNames: boolean,
): { title: string; agentChipLabel: string } {
  const storedTitle = event.agentTitle ?? "";
  const knownIds = [event.agentId, proposal.targetAgentId];
  const resolveIdentity = (agentId: string): AgentIdentitySource | null =>
    resolveAgentIdentityAcrossSessions(sessions, agentId);

  let title = storedTitle;
  if (opaqueAgentId(storedTitle, knownIds)) {
    title =
      nonOpaqueMetaTargetLabel(proposal, knownIds) ??
      resolveOpaqueAgentLabel(storedTitle, knownIds, resolveIdentity) ??
      storedTitle;
  }
  // The chip stays live-name-first like every other card: prefer the subject's
  // live name across all hosts, then the (resolved) stored title.
  const chipName = resolveAgentIdentityAcrossSessions(sessions, event.agentId)?.name ?? null;
  const agentChipLabel = hideAgentNames ? title : (chipName ?? title);
  return { title, agentChipLabel };
}
