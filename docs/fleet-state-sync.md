# Fleet state sync

How state crosses host boundaries and system boundaries. Read this before touching any code that projects state between Paseo, itsaplan, and Mission Control.

The fleet is three hosts (`iammvaibhav`, `blrofc3`, `macbook`) and one itsaplan instance. Agents run on any host. Almost every bug in this area comes from one mistake: **code doing fleet work with host-local data**. This doc names who owns each fact, what an edge must do when it crosses a host, and the checks that catch the mistake before it ships.

## The bug class

On 2026-08-30 a single ticket produced four separate defects. All four are the same shape.

| Symptom                                                    | Mechanism                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket never moved to In Progress                          | The bridge resolved the itsaplan project through `<paseoHome>/itsaplan/projects.json`, which only the sync host writes. On a peer the lookup returned undefined and the handler returned early — silently. |
| Ticket reached Ready to review a minute late               | Nothing projected it on an event. The 60s reconcile sweep was doing the work.                                                                                                                              |
| Ready to review unreachable for ordinary agents            | The only trigger was a `report_status` finished event. An agent that just goes idle never emits one.                                                                                                       |
| Moving a ticket to Done changed nothing in Mission Control | Ingress exists and is received, but the handler only dispatches and unblocks dependents. No reverse edge writes agent lifecycle.                                                                           |

None of them threw. Each one degraded into "nothing happened", which is why they survived so long.

## Who owns each fact

An owner is the one component allowed to write a fact. Everything else projects from it.

| Fact                                | Owner                                       | Notes                                                                                                                                             |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent lifecycle and bucket          | The daemon running the agent                | `deriveLifecycleBucket` is the only function allowed to compute a bucket.                                                                         |
| Ticket column                       | itsaplan                                    | Paseo projects onto it; it never becomes Paseo's fact.                                                                                            |
| The user's Done transition          | The user, in itsaplan                       | The one transition Paseo does not own — and therefore the one it must listen for.                                                                 |
| Project to board mapping            | itsaplan                                    | Every issue payload carries `identifier` (`AMBIENTAISTA-9`), which encodes the board key. Paseo's `projects.json` is a **cache**, not the source. |
| Fleet-wide Mission Control settings | `central-config.json` on the Commander host | Per-host keys (`enabled`, `hostAlias`, `hostGlyph`) live in that host's `config.json` and never here.                                             |

Single writer is a rule about **facts**, not about **directions**. A fact having one writer does not make the edge one-way. Wherever the other system owns a transition, the reverse edge has to exist.

## The asymmetry that keeps biting

Two properties of the current topology point in opposite directions:

- **Outbound work is distributed.** Every daemon runs a bridge and a reconcile sweep, and each sees only its own agents. That is correct: a host owns its agents' lifecycle.
- **Inbound work and shared data are centralised.** `isThisHostTheItsaplanSyncHost` resolves to the Commander host, so only that host writes the project mapping — and `getWebhookUrl` derives from that host's own listen target, so every `issue.state_changed` delivery lands there too.

So the host that receives an itsaplan event is usually **not** the host that owns the agent the event concerns. Any handler that reaches for an agent after ingress needs a hop, and any handler that reaches for shared data on a peer finds it missing.

## Rules

**1. Derive before you replicate.** A lookup table copied to every host becomes a host-locality bug the first time a peer needs it. Prefer recovering the fact from the payload. The project key is the worked example: it is already in `identifier`, so the mapping file is an optimisation and never a precondition. When you must replicate, the consumer treats absence as normal and has a derivation to fall back to.

**2. Ingress terminates once, then routes explicitly.** A webhook lands on one host by construction. That host may only act on facts it owns; for anything else it routes to the owning host over the peer surface. Routing is code you can point at and a test you can run — never an assumption that the agent happens to be local.

**3. Events are the mechanism; polling is the backstop.** Every projection must work on its own event path. The reconcile sweep exists to repair missed events, not to deliver them. If removing the sweep breaks a transition, that transition has no event path and the sweep is load-bearing by accident — which is exactly how Ready to review sat at 60 seconds.

**4. Never degrade to silence.** `if (!mapping) return;` cost a day. A handler that cannot proceed logs why, at a level someone will see, with the ids needed to find it. Silent early return is only acceptable where "nothing to do" is the expected common case, and then it says so in a comment.

**5. A column is identified by name, not by state type.** Boards share names, not ids, and several columns share a state type — `In Progress` and `Ready to review` are both `started`. Grouping or matching on state type silently merges distinct columns. Match on name; treat a missing name on some board as a real case to handle.

**6. Standard columns are guaranteed, not assumed.** Paseo projects onto `In Progress`, `Ready to review`, and `Done`. A projection target that exists on only some boards is a bug waiting for the next project. New projects are created with the full set, and adding a standard column backfills every existing board.

## Verification that would have caught all four

Add these to any change in this area. Each maps to a defect above.

- **Peer-host variant.** Every bridge and projection test gets a case where the agent is on a host that has no local mapping file. Bugs 1 and 4.
- **Event-only variant.** Assert the transition with the sweep disabled. If it fails, the event path does not exist. Bugs 2 and 3.
- **No-self-report variant.** Drive the agent to idle without `report_status`. Bug 3.
- **Idempotence and no-bounce.** Deliver the same transition twice, and deliver a competing one from the other direction, and assert the ticket does not oscillate. Required by rule 2's reverse edges.
- **Fresh-project variant.** Run the projection against a board created today, not only against the one board that happens to have every column. Rule 6.

## Work items

Ordered by dependency. Each is independently shippable.

1. **Reverse edge for Done.** `issue.state_changed` into a `completed` column sets the linked agent's Mission Control lifecycle, through the existing lifecycle mechanism. Guard the loop: Paseo already projects agent state onto the column, so this closes a cycle. Decide and document what Canceled means separately — it is a different user intent.
2. **Route ingress to the owning host.** Ingress lands on the Commander host; the agent may be anywhere. Give the bridge an explicit "find the owning host, then act there" path over the peer surface, and delete any assumption that the agent is local. Until this lands, item 1 only works for agents on the Commander host — say so in its tests rather than implying otherwise.
3. **Make the mapping cache optional everywhere.** The identifier fallback is now in the bridge. Audit every other `getByItsaplanProjectId` caller for the same silent-return shape and give each one the derivation.
4. **Column identity by name across the board surfaces.** Cross-project views group by column name; moves resolve to the same-named column in the ticket's own project. Remove state-type grouping from user-facing surfaces.
5. **Guarantee the standard column set.** `Ready to review` on every board and in the new-project template, backfilled idempotently.
6. **Audit the remaining one-way edges.** For each fact in the ownership table, name the transitions the other system can make and confirm an edge exists. Write down the ones deliberately left one-way and why.
7. **Fleet-aware by default.** The recurring root is that a host-local default is easy to write and a fleet-aware one is not. Make the fleet-aware path the ergonomic one: a single helper that resolves "the daemon that owns this agent" and is used by every cross-system handler, so writing the host-local version requires going out of your way.

## Related

- [mission-control.md](mission-control.md) — buckets, `deriveLifecycleBucket`, where central config lives.
- [commander.md](commander.md) — the Commander host designation this topology depends on.
- [rpc-namespacing.md](rpc-namespacing.md) — naming for any new peer RPC introduced by item 2.

`docs/itsaplan-rollout-plan.md` is a disposable working plan and cites two ADRs (`0001-worktree-per-dispatch`, `0002-itsaplan-two-state-machines`) that **were never written**. Code comments citing "ADR 0002" refer to nothing. Treat this doc as the standing decision until those exist.
