# 06 — Identity and status capture

## Title: written once, then frozen

- Registration always produces a title: `explicit ?? first-prompt-line(60) ??
derived stub` — eliminate the `title:null` path
  (`agent-manager.ts:4283-4290`; derivation exists in
  `packages/server/src/server/agent/create-agent-title.ts`). MCP/internal
  creates without prompts get a derived stub ("Agent started <date>" style is
  acceptable; prefer any available context).
- `report_status.title` is accepted only when the record has no title yet
  (backfill); afterwards ignored — the tool result says
  `"title is fixed; description updated"`. The only rename path is
  `fleet_rename_agent_title`.
- Self-report system prompt
  (`packages/server/src/server/mission-control/self-report-prompt.md`)
  rewritten: title = set once, never resend; description = replace on every
  report.

## Description: living

- `report_status.description` stays schema-optional (old agents), but the
  result nags whenever the record lacks one; first report of a run without a
  description on record → helpful error naming what is missing.
- Event cards snapshot `agentName`, `agentTitle`, `agentDescription` as
  separate additive fields. `resolveAgentTitle` (`service.ts:4386-4394`) flips
  to `record.title ?? live.name ?? id` — work title first; name stays the chip.
- Board rows (`board.tsx:613-642` `deriveRowIdentity`): key line = title,
  chip = name, hover = description.

## Description at finish — three tiers, no LLM

1. Agent self-reports (normal case, driven by the terminal-state guarantee).
2. Terminal transition with zero self-sourced reports this epoch → one
   status-ask steer (below).
3. Still nothing → deterministic fallback: `shortDescription` = first line of
   the last assistant message, flagged auto-derived.

## Terminal-state guarantee (the only automatic nudge)

- Trigger: turn-terminal transition — finished, error, machinery-interrupt
  (not user-stop) — with zero self-sourced `report_status` this run epoch.
- Action: exactly one status-ask steer per epoch. Never repeated. Never
  time-based. Blocked-on-permission gets no nudge (turn suspended); its
  announcements use the blocked headline + last known description.
- **All wall-clock nudges are removed from the status path**: the 30s stall
  sweep's silence (120s) and cadence (300s) status nudges
  (`service.ts:3061`, `3237-3274`) are deleted. Dormant-turn recovery and
  dead-runtime watchdogs stay — they are failure recovery, not status.
  `stallDetectionEnabled` config remains as the master switch for what
  remains.

## Invisible nudge

The status-ask steer (terminal guarantee and `fleet_agent_status fresh:true`)
is wrapped in a machinery envelope the timeline renderer hides — same
mechanism as the `<paseo-system>` envelopes the Commander thread strips
(`thread.tsx:195-205`). Agent panels must hide it too: the timeline renderer
recognizes the envelope and skips the row (verbose mode shows it). The agent's
`report_status` tool call remains visible.

## Tests

- Title: null-path eliminated at registration (all create paths); post-set
  report_status title ignored with notice; rename still works.
- Description tiers: self-report wins; steer fires once per epoch only when
  zero reports; deterministic fallback content; auto-derived flag.
- Invisible envelope: timeline projection hides the steer row, shows the
  report_status call; verbose shows both.
- No wall-clock nudges: simulate 20-minute silent run → zero steers.
