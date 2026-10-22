# 05 — Voice node

## Dual channel

See 03. `server.js` functionResponse becomes `{spoken, data}`; digest shapers
in `daemon.js` become projections; announce/pending_updates buffer keeps
`proposalId`/`agentId`/`kind` (today stripped at daemon.js:269-275).

## Instruction ledger (P0)

The daemon ledger exists (`MissionControlInstructionSchema`,
`packages/protocol/src/mission-control/types.ts:510-525`, `source:
chat|voice`; `deliverCommanderInstruction` `service.ts:1327-1423`; card-emit
closes rows at `service.ts:1066-1073` + approvals). Voice-direct bypasses it.

Changes:

1. New RPC `mission_control.instructions.open.request/.response`
   (dotted namespace per docs/rpc-namespacing.md): voice node calls it on each
   final user-utterance transcription with the transcript text; daemon opens
   row(s) `#N` (source `voice`) and returns `{instructions: [{id, text}]}`.
   One row per utterance is the floor; the daemon does not attempt intent
   splitting.
2. Voice tool declarations for every mutation and answer card carry
   `respondsTo`; the model cites the open id. Emit-time close already works.
3. Open rows inject into the next model turn and into `pending_updates`
   output: `Open: #12 spawn worker in paseo — #13 status of Keen Heisenberg`.
4. Prompt rule: do not end the turn while a row from this utterance is open
   without a card or an explicit "blocked on you". Unclosed rows resurface
   every turn — nothing silently drops.

## System prompt (both modes — one shared discipline block)

Replace incident-specific lines in `scripts/commander-voice/lib/voice-prompt.js`
and the relevant part of
`packages/server/src/server/mission-control/commander-prompt.md`:

```
1. Facts come from tools, never memory. Ids, statuses, placements must be
   looked up in this session.
2. Copy, never construct: every id you pass must appear verbatim in a prior
   tool result's data. Titles and names are never ids. Missing id → call the
   tool that returns it first.
3. Enums: use only values listed in the schema. A rejection listing valid
   values → retry with exactly one of them or omit the argument. Never guess.
4. Resolve, then act: spoken names go to fleet_list_inventory /
   fleet_list_agents(query) first; act on the returned id.
5. Spawn: named project/workspace → pass the resolved wks_*. Named none →
   omit placement; the daemon places. Ask only when candidates tie.
6. One mutating call per intent. Wait for its result (proposal id or error).
   Never re-issue while one is pending.
7. Buckets are server truth (data.bucket). Never infer them from statuses.
8. Speak spoken; take ids from data; never speak an id.
9. Tool error → tell the user the one-line reason. Never pretend it worked.
10. Every mutation and answer cites respondsTo from the open-instructions
    list. Do not finish with an open row uncarded.
```

Delete: "needs-you = requiresAttention or error" (voice-prompt.js), "get ids
from inventory" in its current impossible form, commander-prompt.md:13's
"finished awaiting review = needs me".

## Parity

Voice declares the full Commander catalog (same tools, same schemas — see 00).
A drift test asserts per-tool declaration parity (03).
