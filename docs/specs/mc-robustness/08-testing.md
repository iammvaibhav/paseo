# 08 — Testing

Backend first, exhaustive; UI last, sanity only. Test model for real agents:
**deepseek v4 flash** (resolve the exact invocable `provider/model` string via
`fleet_list_models` / provider snapshot at test time; fail loudly if absent).

## Layer 1 — unit (per slice, ships with each slice)

Named in specs 01-07. Fast, no daemons.

## Layer 2 — 3-daemon fleet integration (the core sign-off)

Harness: `packages/server/src/server/mission-control/fleet-harness.e2e.test.ts`
(+ a reusable `test-utils/fleet-harness.ts`). Built on `createPaseoDaemon`
(docs/ad-hoc-daemon-testing.md) — three in-process daemons, OS-assigned ports,
real WebSocket peering:

- Daemon A = commander host (centralConfig.commanderHost = A), peers: B, C.
- B and C peer back to A (and each other where the product config would).
- `DaemonClient` per daemon (appVersion set). Real `PeerManager`, real RPCs —
  nothing mocked at the peering layer.
- Agent providers: `createTestAgentClients` fakes for state-machine scenarios
  (fast, deterministic); real omp provider with deepseek v4 flash for
  behavior scenarios (report_status flows, terminal guarantee, spawn
  execution).
- Every scenario runs through the same RPC surface the Commander/voice use
  (`mission_control.tools.execute` with commander labels) — this is the
  contract under test, not internal function calls.

Scenario matrix (each is a test; add edge cases found by the audit script):

1. **Bucket truth**: spawn on B via A; run; finish → `ready` on A's roster,
   B's local roster, and `fleet_list_agents.data.bucket`; verdict → done;
   user-stop → done(stopped-by-user); error → needs_you; permission pending →
   needs_you (record attention now written); orphaned proposal → resolved by
   sweep, bucket leaves needs_you.
2. **Fleet ids**: resolve agent on C by bare id from A; fleet_send_prompt
   without host; meta rename by bare id; host-hint mismatch error; C stopped →
   unreachable guidance names C.
3. **Fail-fast spawn**: bad workspaceId → call-time error listing candidates;
   relative cwd → error; valid wks\_ on B → proposal; approve → agent exists on
   B in that workspace.
4. **Dedupe**: two identical fleet_create_agent calls while pending → same
   proposalId; after resolve → new proposal allowed.
5. **Meta split**: each of the 11 tools round-trips (proposal → approve →
   applied on the right host); id-family validation errors.
6. **Terminal guarantee**: real-model agent (deepseek v4 flash) instructed to
   finish silently → exactly one invisible steer → report_status lands →
   description on record; agent that self-reports → zero steers; 20-minute
   silent mid-run simulation (fake clock) → zero steers.
7. **Identity**: title set at registration for every create path; title freeze;
   description nag; event fields name/title/description; run-end fallback.
8. **Aging**: ready row older than readyAgeOutDays (fake clock) → done with
   aged-out verdict.
9. **Chat routing**: machinery gate per event kind; blocked lands on board +
   announce, not chat.
10. **Instruction ledger**: instructions.open RPC; respondsTo closes rows;
    unclosed rows resurface.
11. **Monitor**: subscribe fleet on A; finish on C → one announce event with
    ids; per-agent watch; stop; status lists subscriptions.
12. **Compat**: old-record `attentionReason:"finished"` still parses; old app
    (no bucket field) still parses roster payloads (schema-level test).

Run: `npx vitest run <file> --bail=1` per file; pipe to a log file; never the
whole workspace suite.

## Layer 3 — voice scenarios (real Gemini Live, generated audio)

Harness: extends the existing bench pattern (Gemini TTS → PCM → mic-cadence
streaming → trailing silence for VAD; see scripts/commander-voice test
harness and the non-blocking bench). Voice node connects to fleet daemon A
from Layer 2 (or a dedicated single daemon for speed where fleet irrelevant).
Model under test: the production voice model; thinking minimal. Spawned
agents: deepseek v4 flash.

Scenarios (each asserts on session JSONL + daemon state, not on speech):

1. Needs-me count — spoken answer matches `data.bucket` counts; no invented
   status filters; filtered-empty phrasing correct.
2. Status by name — resolve → fleet_agent_status → answer carries title +
   last report; no ids spoken.
3. Spawn into named workspace — resolve → wks\_ id in the call → proposal;
   approve via proposal_respond with buffered id.
4. Spawn with no placement — placement omitted, host present.
5. Duplicate emission — model re-emits while pending → one proposal
   (dedupe observed).
6. Invalid enum recovery — inject a bad statuses value via prompt pressure →
   error lists enum → next call uses a listed value.
7. Multi-intent utterance — "spawn X, check Y, monitor Z" → ledger rows
   opened; all three closed by cards; nothing dropped.
8. Monitor announce — start fleet monitor; finish an agent on B → announce
   injected between turns; conversation continues meanwhile (non-blocking).
9. Meta by voice — rename an agent by spoken name.

Pass bar for direct-default flip: full scenario suite green 5 consecutive
runs.

## Layer 4 — UI sanity (browser tools, last)

Dev daemon + Expo web. Board: buckets match `fleet_list_agents.data.bucket`
for the same agents; Done collapsed; Ready bulk action; row hover shows
title + description; aged-out chip. Agent panel: invisible steer hidden,
report_status call visible. Sidebar/tab chips agree with the board for the
same agent. Screenshots as evidence.
