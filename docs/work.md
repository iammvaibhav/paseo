# Work

A native Kanban surface for authoring work items and letting agents pick them up. You move a card to Todo; an agent starts; the card then follows that agent across the board on its own.

## Work vs Mission Control

| Surface             | Answers                                        |
| ------------------- | ---------------------------------------------- |
| **Work**            | What should agents do, and what happened to it |
| **Mission Control** | What are agents doing right now                |

Work tracks intent and outcome. Mission Control tracks live execution. Both read the same bucket.

## State is derived, not stored

`deriveLifecycleBucket` at `packages/protocol/src/agent-state-bucket.ts:50` is the one live-state authority. The server computes it and publishes it as `bucket` on `AgentSnapshotPayload` and `AgentListItemPayload` (`packages/protocol/src/messages.ts:1094`, `:1120`).

A work item stores only an authored lane, a link to an agent, and an optional terminal close:

- `lane` (`backlog` | `todo`) — the only state you write
- `agentId` / `agentHost` — which agent, if any, owns the item
- `closed` (`done` | `cancelled` | null) — terminal close

The board column is derived by `deriveWorkColumn` (`packages/protocol/src/work/state.ts`). Columns are a grouping over lanes and lifecycle buckets, not a separate state machine. This matches how Plane groups its board by `State.group` rather than by state id.

When you drag a card to In Review or Done, Work writes Mission Control's existing `reviewState` (`ready` or `done`). `reviewState` is an input to `deriveLifecycleBucket`, so the move changes the bucket and the card's column follows without a second write.

Do not add a second state:

- Do not add a `status` or `state` field to `WorkItem`.
- Do not derive a bucket on the client. Read the server's `bucket`.
- Do not add an agent tool that sets its own column. An agent moves its card by working and by calling `report_status`; the bucket does the rest.

Two state machines drift. A stored status diverges from the agent's actual lifecycle, then every consumer patches the gap.

## Drag is intent

A drop declares what you want. Columns that derive from a live agent are not drop targets.

| Drop target     | When you can drop                                    | Effect                                                               |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| **Backlog**     | No agent, or linked agent bucket is `idle` or `done` | `lane = "backlog"`; a linked idle agent is detached (approval-gated) |
| **Todo**        | No linked agent                                      | `lane = "todo"`; the dispatcher picks it up                          |
| **In Progress** | `lane === "todo"`                                    | Dispatch now, skipping the queue                                     |
| **In Review**   | A linked agent exists                                | Write `reviewState = "ready"`                                        |
| **Needs Me**    | Never                                                | Not a drop target — derived from live agent attention                |
| **Done**        | Always                                               | Write `reviewState = "done"` and set `closed`                        |

Reordering inside a column writes `sortOrder` only.

## Auto-pickup

When an item lands in `todo` with an assignment, the dispatcher enqueues it (`packages/server/src/server/work/dispatcher.ts`).

- Dispatch goes through `MissionControlApprovals.createProposal` (`packages/server/src/server/mission-control/approvals.ts:336`, `kind: "spawn"`), so Ask mode still asks before an agent starts. Auto mode sends immediately.
- `work.autoPickupConcurrency` (default 3, in daemon config) bounds the queue. Drag twenty items to Todo and the dispatcher starts at most three at once.
- After the agent exists, the dispatcher stops tracking the item. The card's column now follows the agent's bucket with no further bookkeeping.

The daemon reads peer hosts and `work.autoPickupConcurrency` at boot.

Cross-host dispatch reuses Mission Control's `spawnProposalOnPeer` (`packages/server/src/server/bootstrap.ts:329`) → `peerClient.fleetSpawnApply`.

## Cross-host

Work items are keyed by `projectKey`, the cross-host equivalence key that groups a logical project across hosts. Where `projectKey` is null, the item falls back to `projectId` and records `homeHost`.

- An item lives on the host that created it.
- Reads aggregate fleet-wide. Copy `buildFleetContextData` (`packages/server/src/server/mission-control/context.ts:454`): serve local, fan out to online peers, represent an unreachable peer as `reachable: false` with an empty list. Never throw.
- Mutations route to the owning host via `FleetIdIndex.resolveFleetId` (`packages/server/src/server/fleet-id-index.ts:86`). An unreachable peer surfaces `buildPeerUnreachableError` (`:64`).

Gotcha: a peer `url` must be a bare `host:port`. A `ws://` URL is passed through and then lacks `/ws`, so the peer never connects.

## Projects mirror one way

Creating a Paseo project creates a Work project (`packages/server/src/server/work/mirror.ts` hooks `ProjectRegistry.subscribeToMutations` at `packages/server/src/server/workspace-registry/registry.ts:149`). Work cannot create a project, because a project needs a directory.

- `identifier` is derived from the display name, uppercased, ≤12 chars, uniquified with a numeric suffix.
- `identifier` is immutable after assignment. It is baked into every human key (`${identifier}-${sequenceId}`), so renaming a project updates the display name only.
- Archiving a Paseo project archives the Work project and keeps its items.
- `work.item.create` against an unknown project returns `work_project_requires_paseo_project`.

## What Work took from Plane

Plane is the reference (`https://github.com/makeplane/plane`). Work re-implements the relevant parts natively.

| Concept                                                                                 | Verdict | Reason                                         |
| --------------------------------------------------------------------------------------- | ------- | ---------------------------------------------- |
| Work items (title, description, priority, `sequenceId`, `sortOrder`, dates, assignment) | Keep    | Core ticket                                    |
| Sub-items (self-FK, computed count)                                                     | Keep    | Hierarchy without a second table               |
| Labels (project-scoped, `color` + `sortOrder`)                                          | Keep    | Lightweight grouping                           |
| Comments (markdown)                                                                     | Keep    | Agent and user discussion on the item          |
| Activity (append-only audit)                                                            | Keep    | Who changed what                               |
| Pages (project-scoped markdown, nestable)                                               | Keep    | Docs next to tickets                           |
| Drafts (buffer, no `sequenceId` until promoted)                                         | Keep    | Fast capture                                   |
| Stickies (project-scoped scratch notes)                                                 | Keep    | Requested explicitly                           |
| Saved views (filters, `groupBy`, `orderBy`)                                             | Keep    | Per-project board config                       |
| Fractional `sortOrder` algorithm                                                        | Keep    | Stable ordering without renumbering the column |
| Cycles (time-boxed sprints)                                                             | Drop    | Orthogonal to agent dispatch                   |
| Modules (optional grouping)                                                             | Drop    | Revisit later                                  |
| Intake / triage                                                                         | Drop    | `needs_me` covers the triage signal            |
| Estimates                                                                               | Drop    | Story points have no meaning for agents        |
| Reactions, votes, mentions                                                              | Drop    | No multi-human audience                        |
| Workspaces, members, roles                                                              | Drop    | No multi-tenancy; Paseo projects own the board |
| Plane auth, billing, integrations, analytics                                            | Drop    | Paseo owns these                               |
| Plane UI chrome                                                                         | Drop    | No top bar, account menu, or Plane sidebar     |

Descriptions are markdown, not Plane's Tiptap JSON.

## Ordering

`sortOrder` is a float defaulting to `65535` (`packages/protocol/src/work/state.ts:computeSortOrder`). On drop: empty column `65535`; top `first - 65535`; bottom `last + 65535`; between `(prev + next) / 2`. You compute the value on the client and persist it on the server.

When a computed gap drops below `1`, the server rebalances that column to even `65535` multiples and returns the new orders (`needsSortOrderRebalance`). Plane lacks this rebalance and exhausts float precision after ~50 mid-inserts.

## Where code lives

- Wire types and column derivation: `packages/protocol/src/work/`
- Persistence, mirroring, fleet aggregation, dispatch: `packages/server/src/server/work/`
- Board, columns, detail, pages, drafts, stickies, project rail: `packages/app/src/screens/work/`
- Queries and mutations: `packages/app/src/data/work.ts`

Wire schemas stay pure (no `.transform()` / `.catch()` / `.preprocess()`). Live updates push `work.item.updated` and `work.project.updated` over the existing `Session` fan-out, gated on the `workBoard` feature flag (`packages/protocol/src/messages.ts:3732`).
