# 01 — Canonical lifecycle bucket

## Problem

Three derivations disagree today:

- Server roster (`packages/server/src/server/mission-control/context.ts:276-291`):
  `requiresAttention` outranks `reviewState` → finished and verdict-done agents
  read "needs you". The finish latch (`agent-manager.ts:5354-5364`) clears only
  on user open/clear/archive; verdicts never clear it
  (`packages/app/src/mission-control/lifecycle.test.ts:337-341`).
- App board (`packages/app/src/mission-control/lifecycle.ts:221-270`): derives
  from a folded event window; the newest-200-per-host fetch
  (`packages/app/src/hooks/use-aggregated-mission-control-events.ts:22-26`)
  evicts old `finished` events → old agents show dormant instead of Ready.
- Sidebar (`packages/protocol/src/agent-state-bucket.ts:21-37` via
  `packages/app/src/utils/sidebar-agent-state.ts:10-16`): any
  `requiresAttention` (incl. finished) → attention bucket.

Adjacent bugs: permission requests never write record attention
(`agent-manager.ts:5086-5092` — roster shows permission-blocked agents as
"running"); delegated workers skip the finish broadcast
(`agent-manager.ts:5473-5477`); approve-failure leaves proposals `pending`
forever; a second finish without an intervening clear emits nothing (bail at
`agent-manager.ts:5344-5347`).

## Contract: one function

Extend `packages/protocol/src/agent-state-bucket.ts`:

```ts
export type LifecycleBucket = "needs_you" | "running" | "ready" | "done" | "idle";

export interface LifecycleBucketInput {
  pendingPermissionCount: number;
  pendingProposalCount: number; // pending only; expired/failed excluded
  attentionReason: "error" | "permission" | "finished" | null; // "finished" read-only compat
  lastStatus: string | null; // agent lifecycle status
  running: boolean; // lifecycle running/initializing
  reviewState: "none" | "ready" | "done" | "cleared";
  stopOrigin: "user" | "machinery" | "system" | null;
}

export function deriveLifecycleBucket(input: LifecycleBucketInput): LifecycleBucket;
```

Precedence (first match wins; user-stop excludes 1):

1. `needs_you` — pendingPermissionCount>0 | attentionReason=="permission"
   | lastStatus=="error" | attentionReason=="error" | pendingProposalCount>0
2. `running` — running
3. `done` — stopOrigin=="user" && reviewState=="none" ("Stopped by you")
4. `done` — reviewState=="done"
5. `ready` — reviewState=="ready"
6. `idle` — includes reviewState=="cleared" (Clear removes the row)

Computed **server-side from stored state** (agent record + review-state.json +
proposal index), never from a truncated client event fold. The server exposes
the bucket on: roster rows (context.ts), `fleet_list_agents` rows
(`data.bucket`), agent snapshot payloads (additive optional field), and the
world snapshot.

Consumers to rewire (delete their private derivations):

- `context.ts:276-291` roster
- `packages/app/src/mission-control/lifecycle.ts` bucketing (event fold stays
  only for card rendering/chips, not for bucket decisions)
- `packages/app/src/utils/sidebar-agent-state.ts`
- Agent tab status chip and agents-list rows (locate during implementation;
  wire to the same field)
- `scripts/commander-voice/lib/daemon.js` digest bucketing (reads
  `data.bucket`, see 03/05)

## Daemon state-machine changes

1. **Finish stops latching attention.** running→idle clean finish no longer
   writes `attentionReason:"finished"` (`agent-manager.ts:5354-5364` write path
   removed). The MC service still needs a finish signal: replace the
   attention-edge trigger with a direct running→idle notification to the MC
   service (same call site) that emits the `finished` event +
   `markReadyForReview`. The enum value `"finished"` stays readable for old
   records — `// COMPAT(finished-attention)` on the read path.
2. **Permission latches record attention** — write
   `{requiresAttention:true, reason:"permission"}` in
   `onStreamPermissionRequested`; clear when pending permissions drain.
3. **Verdict / mark-done / clear also clear stale attention**
   (`service.ts:1095-1119`, `verifier.ts:610-649` → `clearAgentAttention`).
4. **Delegated agents stop skipping the finish broadcast**
   (`agent-manager.ts:5473-5477` removed). Their finish maps to review-state
   `ready`, never attention — no worker attention spam.
5. **Proposal resolution:** approve-failure marks the proposal `failed`
   (terminal, additive status value alongside expired), never leaves
   `pending`. Expired/failed leave `pendingProposalCount`. One-time boot sweep
   resolves currently-orphaned pendings (pending + proposal's agent run long
   gone → `expired`).
6. **Second finish re-marks ready** — the review-state write no longer depends
   on the (removed) attention latch edge.

## Ready aging

Daily sweep (piggyback `store.prune` scheduling, `service.ts:958-961`):
`reviewState=="ready"` with `updatedAt` older than `readyAgeOutDays` (central
config, default 3) → `setReviewState("done", { verdict: "aged-out" })`. Board
renders an "Aged out" chip. No agent mutation.

## Audit script (pre-cutover)

`packages/server/src/server/mission-control/audit-lifecycle-buckets.ts` —
runnable via `npx tsx`, read-only. For every stored agent on this daemon (and
each reachable peer via existing fleet RPCs): print agentId, name, title, old
roster bucket, old board-bucket equivalent, old sidebar bucket, new canonical
bucket, stopOrigin, attentionReason, reviewState, pendingProposalCount.
Output: aligned table + JSON file. Disagreement rows flagged. This doubles as
the fixture source for unit tests.

## Tests

Unit-test the canonical function with every row of this event→bucket table:

| Scenario                         | Bucket                 |
| -------------------------------- | ---------------------- |
| idle, no run history             | idle                   |
| running                          | running                |
| permission requested             | needs_you              |
| error                            | needs_you              |
| pending proposal                 | needs_you              |
| clean finish (reviewState ready) | ready                  |
| finish + verdict done            | done                   |
| finish + aged out                | done                   |
| user-stop, no review             | done (stopped-by-user) |
| user-stop + Clear                | idle                   |
| user-stop then new run           | running                |
| delegated worker finish          | ready                  |
| second finish after verdict      | ready (re-marked)      |

Update deliberately: `lifecycle.test.ts:337-341` (verdict now clears
attention), `agent-manager.test.ts:1995-2043` (latch behavior),
`run-records.test.ts:200-204`.
