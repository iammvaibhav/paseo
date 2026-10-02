# 07 — Chat vs board routing, board UI

## Machinery-turn gate

`shouldDispatchMachineryTurn` (`service.ts:4078-4107`) new policy — chat
carries only decisions:

| Event                                         | Today       | New                                                                            |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| proposal, clarification, verdict-insufficient | chat        | chat                                                                           |
| blocked, stalled                              | always chat | board bucket + badge + monitor announce; chat only if a decision card attaches |
| finished, failed, interrupted (dispatched)    | chat        | board/feed rail only                                                           |
| started, milestone, finding                   | chat cards  | board/feed rail only                                                           |

Verbose mode unchanged (shows everything).

## Thread classification (app)

`packages/app/src/screens/mission-control/thread-classification.ts:79-94`
returns `skip` in normal mode for kinds
`started|finished|milestone|finding|interrupted|diverged|stalled|failed` and
state-verdicts. Proposals/clarifications/answers stay cards.

## Board UI

- Done section collapsed by default (count + expand).
- "Move all Ready → Done" bulk action on the Ready section header.
- "Aged out" chip on rows the aging sweep moved (01).
- Recorded row identity: key line = title, chip = name, hover = description
  (06).

## Tests

- Gate unit tests per event kind × dispatched/hand-started × ask/auto mode.
- Thread classification: normal mode skips the listed kinds; verbose renders
  them; proposals always render.
