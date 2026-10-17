import type { CardRunRowClass, FeedCardEvent } from "./feed-card";
import type { StreamItem } from "@/types/stream";
import { fleetToolLeafName } from "@getpaseo/protocol/tool-call-display";

/**
 * Pretty-rendered dispatch actions (spec "Tool rendering"). These are the only
 * Commander tool calls that surface in normal (non-verbose) mode — everything
 * else is machinery. `tag_message` is additionally silent in normal mode even
 * though it renders pretty in verbose.
 *
 * `create_agent` is deliberately NOT here: it is the LOCAL agent-scoped spawn
 * form ("creates your subagent") — a subagent spawn is machinery, so it stays
 * verbose-only even though it renders pretty ("Spawned …") in verbose.
 * `fleet_create_agent` (the fleet dispatch with an explicit host) is the
 * normal-mode allowed form.
 */
const PRETTY_DISPATCH_TOOLS: Record<string, true> = {
  fleet_send_prompt: true,
  fleet_list_agents: true,
  fleet_create_agent: true,
  fleet_search: true,
};

/**
 * The pretty-dispatch leaf for a tool name, or null when it is machinery.
 * Normalization delegates to the protocol's fleet-name resolver (single
 * source of truth for `fleet_*` / `mcp__paseo__` / `paseo.` spellings).
 */
export function prettyDispatchToolLeaf(name: string): string | null {
  const leaf = fleetToolLeafName(name);
  return leaf && PRETTY_DISPATCH_TOOLS[leaf] ? leaf : null;
}

/** True for the tag_message tool, which renders pretty only in verbose mode. */
export function isTagMessageTool(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "tag_message" || (trimmed.split(/[.:/]/).at(-1) ?? "") === "tag_message";
}

/**
 * Machinery-only proposal card: stall status-ask nudges (origin "stall",
 * deliveryMode "steer") that already went out. The daemon stamps these
 * `verboseOnly: true` (spec: a steer never disrupts the turn; recorded as an
 * auto-sent proposal, never pending). Normal (non-verbose) mode never renders
 * them; verbose is the debug view. Escalation/recovery proposals
 * (deliveryMode "interrupt", approval-gated) and verifier/commander cards
 * always render. Legacy hosts / pre-field persisted events fall back to the
 * origin+delivery shape — any stall-origin steer is machinery regardless of
 * how it resolved (sent, expired, denied, or a pending that went stale): the
 * pre-field fallback previously required status "sent", leaking expired stall
 * cards into normal mode.
 *
 * Lives here (not proposal-card) because thread row classification shares the
 * same gate; proposal-card re-exports it for the feed-card rendering path.
 */
export function isVerboseOnlyProposalEvent(event: FeedCardEvent): boolean {
  if (event.kind !== "proposal" || !event.proposal) {
    return false;
  }
  const proposal = event.proposal;
  if (event.verboseOnly === true || proposal.verboseOnly === true) {
    return true;
  }
  return proposal.origin === "stall" && proposal.deliveryMode === "steer";
}

/**
 * A single Mission Control thread row: either a feed event (renders as a
 * card) or a Commander stream item (message / tool call / thought).
 */
export type ThreadRow =
  | { kind: "event"; event: FeedCardEvent; ts: number }
  | { kind: "commander"; item: StreamItem; ts: number };

/**
 * Machinery status kinds normal (non-verbose) mode hides (spec 07 "Chat vs
 * board routing"): the chat carries only decisions; these render board/feed
 * rail only. `blocked` is deliberately NOT here — a blocker is a needs-you
 * card for the user and stays visible; `stalled` (nudge escalation) is
 * machinery noise and hides.
 */
const NORMAL_MODE_SKIP_KINDS: ReadonlySet<FeedCardEvent["kind"]> = new Set([
  "started",
  "finished",
  "milestone",
  "finding",
  "interrupted",
  "diverged",
  "stalled",
  "failed",
]);

/**
 * Classifies a thread row for card-run derivation: event rows render as cards
 * ("card"); rows hidden by normal mode render nothing and take no height
 * ("skip") — transparent to runs so the cards around it stay visually
 * adjacent; commander rows (messages, tool calls) render visible content and
 * break runs ("gap").
 *
 * Normal (non-verbose) mode shows only decisions: proposals (except machinery
 * stall status-ask nudges), clarifications, answers, blocked needs-you cards,
 * and verdict-insufficient cards. Status kinds (started | finished |
 * milestone | finding | interrupted | diverged | stalled | failed) and
 * state-only verdict cards (the item resolved) are board/feed-rail only.
 * Verbose renders every event (existing behavior).
 */
export function classifyThreadRow(row: ThreadRow, verbose: boolean): CardRunRowClass {
  if (row.kind !== "event") {
    return "gap";
  }
  if (verbose) {
    return "card";
  }
  if (row.event.kind === "proposal") {
    return isVerboseOnlyProposalEvent(row.event) ? "skip" : "card";
  }
  if (row.event.kind === "clarification" || row.event.kind === "answer") {
    return "card";
  }
  if (row.event.kind === "blocked") {
    return "card";
  }
  if (row.event.kind === "verdict") {
    // State-only verdicts resolved the item; verdict-insufficient (no stamp)
    // stays a decision card.
    return row.event.stateOnly === true ? "skip" : "card";
  }
  if (NORMAL_MODE_SKIP_KINDS.has(row.event.kind)) {
    return "skip";
  }
  return "card";
}
