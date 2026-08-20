# Work — project management for agents

Implementation spec. A native Kanban surface where the user authors work items and agents pick them up.

Modeled on [Plane](https://github.com/makeplane/plane) but re-implemented natively. Nothing is embedded; no web view, no Plane server, no Plane auth.

## 1. Product shape

The user authors tickets on a board and assigns them to agents. An item in **Backlog** sits still. Moved to **Todo**, an agent picks it up, and the card then follows that agent across the board on its own.

Two surfaces, one job each:

| Surface             | Answers                                        |
| ------------------- | ---------------------------------------------- |
| **Work**            | What should agents do, and what happened to it |
| **Mission Control** | What are agents doing right now                |

### Naming

`Board` and `Feed` already belong to Mission Control, and `Task`, `Job`, and `Run` are forbidden synonyms for an agent session (see [glossary.md](../../glossary.md)). So:

| Term             | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| **Work**         | The sidebar item and the screen. Route `/work`                                   |
| **Work item**    | One ticket. Code: `WorkItem`, id `wit_<16 hex>`, human key `PASEO-12`            |
| **Work board**   | The Kanban canvas inside Work. Never bare "Board"                                |
| **Work project** | The per-project board record mirroring a Paseo project                           |
| **Lane**         | An authored state (`backlog`, `todo`) — the only state a human writes            |
| **Column**       | A board column. A grouping over lanes and lifecycle buckets, never its own state |

Add every row above to `docs/glossary.md`.

## 2. The state rule

**There is exactly one live-state authority and it already exists.**

`deriveLifecycleBucket` (`packages/protocol/src/agent-state-bucket.ts:50`) returns `needs_you | running | ready | done | idle`. The server computes it from stored state and publishes it as `bucket` on `AgentSnapshotPayload` (`packages/protocol/src/messages.ts:1094`) and `AgentListItemPayload` (`:1120`).

A work item **never stores a live state.** It stores an authored lane, an optional link to an agent, and an optional terminal close. The column is derived.

This mirrors how Plane itself works: its board groups by `State.group`, not by state id (`apps/api/plane/db/models/state.py:12`). Columns are a grouping over an enum, not a parallel enum.

```ts
// packages/protocol/src/work/state.ts

/** The only states a human writes directly, and the only ones stored. */
export type WorkItemLane = "backlog" | "todo";

/** Board columns. A grouping over lanes + LifecycleBucket. NOT a state machine. */
export type WorkColumnId = "backlog" | "todo" | "in_progress" | "in_review" | "needs_me" | "done";

const BUCKET_TO_COLUMN: Record<LifecycleBucket, WorkColumnId> = {
  running: "in_progress",
  idle: "in_progress",
  needs_you: "needs_me",
  ready: "in_review",
  done: "done",
};

export function deriveWorkColumn(
  item: { lane: WorkItemLane; closed: { state: "done" | "cancelled" } | null },
  agentBucket: LifecycleBucket | null,
): WorkColumnId | "cancelled" {
  if (item.closed) return item.closed.state;
  if (agentBucket) return BUCKET_TO_COLUMN[agentBucket];
  return item.lane;
}
```

`deriveWorkColumn` is the only column authority. It consumes `deriveLifecycleBucket`'s output verbatim and never re-derives it. Cards render the bucket label verbatim too, so an idle agent in **In Progress** reads "Idle" on the card rather than inventing a "Stalled" state.

`cancelled` is a state but not a column. Cancelled items are hidden by default and reachable through a filter.

### Forbidden

- A `status`/`state` field on `WorkItem` that mirrors a bucket.
- Client-side bucket derivation. Read the server's `bucket`.
- An agent tool that sets its own column.
- A column-to-bucket write path other than the table in §2.1.

### 2.1 Drag semantics

A drop is an **intent**, not a state write. Columns that derive from a live agent are not drop targets.

| Drop target     | Allowed when                               | Effect                                                               |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| **Backlog**     | no agent, or agent bucket is `idle`/`done` | `lane = "backlog"`; a linked idle agent is detached (approval-gated) |
| **Todo**        | no linked agent                            | `lane = "todo"`; the dispatcher picks it up                          |
| **In Progress** | `lane === "todo"`                          | Dispatch now, skipping the queue                                     |
| **In Review**   | a linked agent exists                      | Write Mission Control `reviewState = "ready"`                        |
| **Needs Me**    | never                                      | Not a drop target — derived from live agent attention                |
| **Done**        | always                                     | Write `reviewState = "done"` and set `closed`                        |

**In Review** and **Done** write Mission Control's existing `reviewState`, which is an input to `deriveLifecycleBucket`. That is the single-source-of-truth guarantee made concrete: moving a card to Done is the same write the Mission Control board makes.

Reordering within a column writes `sortOrder` only.

### 2.2 Ordering

Plane's fractional gap algorithm, kept verbatim (`apps/web/core/components/issues/issue-layouts/utils.tsx:460`): `sortOrder` is a float defaulting to `65535`. On drop — empty column `65535`; top `first - 65535`; bottom `last + 65535`; between `(prev + next) / 2`. Compute client-side, persist server-side.

Add one thing Plane lacks: when a computed gap falls below `1`, the server rebalances that column to even `65535` multiples and returns the new orders. Plane's float exhaustion after ~50 mid-inserts is a real bug we decline to inherit.

## 3. What we take from Plane

| Concept                                | Verdict       | Notes                                                                                                                                                                  |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                                | **Keep**, 1:1 | A Paseo project is the board root. `identifier` prefix (≤12 chars, uppercase) drives the human key                                                                     |
| Work item                              | **Keep**      | Title, description, priority (`urgent\|high\|medium\|low\|none`), labels, parent (sub-items), `sequenceId`, `sortOrder`, dates, assignment                             |
| State/StateGroup                       | **Adapt**     | Replaced by §2. Plane's 6 groups collapse onto our existing `LifecycleBucket`. We do **not** ship a `State` table — that would be the duplicate state the user forbade |
| Comments                               | **Keep**      | Markdown. Author is a user or an agent                                                                                                                                 |
| Activity                               | **Keep**      | Append-only audit: `verb`, `field`, `oldValue`, `newValue`, `actor`                                                                                                    |
| Attachments / links                    | **Keep**      | Links keep a `metadata` preview. Agent proofs land here                                                                                                                |
| Labels                                 | **Keep**      | Project-scoped, `color` + `sortOrder`                                                                                                                                  |
| Pages                                  | **Keep**      | Project-scoped markdown docs, nestable                                                                                                                                 |
| Drafts                                 | **Keep**      | Quick-add buffer; no sequence id until promoted                                                                                                                        |
| Stickies                               | **Keep**      | Project-scoped scratch notes. The user asked for these explicitly                                                                                                      |
| Saved views                            | **Keep**      | Per-project filters, `groupBy`, `orderBy`                                                                                                                              |
| Sub-items                              | **Keep**      | Self-FK plus a computed count                                                                                                                                          |
| Cycles                                 | **Drop**      | Time-boxed sprints, orthogonal to this                                                                                                                                 |
| Modules                                | **Drop**      | Optional grouping; revisit later                                                                                                                                       |
| Intake/Triage                          | **Drop**      | Superseded by `needs_me`                                                                                                                                               |
| Estimates                              | **Drop**      | Story points mean nothing here                                                                                                                                         |
| Reactions, votes, mentions             | **Drop**      | No multi-human audience                                                                                                                                                |
| Workspaces, members, roles             | **Drop**      | No multi-tenancy. Paseo projects own the board                                                                                                                         |
| Auth, billing, integrations, analytics | **Drop**      | Paseo owns these                                                                                                                                                       |
| All Plane UI chrome                    | **Drop**      | No top bar, no account menu, no Plane sidebar, no command palette                                                                                                      |

Descriptions are **markdown**, not Plane's Tiptap JSON triple. The app already renders markdown everywhere; a rich-text editor is a separate project.

## 4. Persistence

Host-local, under `$PASEO_HOME/work/`. Follow `FileBackedRegistry` (`packages/server/src/server/workspace-registry.ts:176`) and `writeJsonFileAtomic` (`atomic-file.ts:5`). No migrations; new fields are optional.

| File                                                                           | Shape                               |
| ------------------------------------------------------------------------------ | ----------------------------------- |
| `work/projects.json`                                                           | `WorkProjectRecord` by `projectKey` |
| `work/items.json`                                                              | `WorkItemRecord` by id              |
| `work/comments.jsonl`                                                          | Append-only                         |
| `work/activity.jsonl`                                                          | Append-only                         |
| `work/pages.json`, `work/drafts.json`, `work/stickies.json`, `work/views.json` | By id                               |

Persisted schemas are **separate** from wire schemas, per repo convention.

### Cross-host scoping

Work items are keyed by **`projectKey`**, the cross-host equivalence key that groups a logical project across hosts (`docs/glossary.md`). Where `projectKey` is null, fall back to `projectId` and record `homeHost`.

An item lives on the host that created it. Reads aggregate fleet-wide; writes route to the owning host.

```ts
interface WorkItemRecord {
  id: string; // wit_<16 hex>
  projectKey: string;
  projectId: string;
  sequenceId: number; // per work project
  title: string;
  description: string; // markdown
  priority: "urgent" | "high" | "medium" | "low" | "none";
  labelIds: string[];
  parentId: string | null;
  sortOrder: number;
  lane: "backlog" | "todo";
  assignment: WorkAssignment | null;
  agentId: string | null;
  agentHost: string | null;
  closed: { state: "done" | "cancelled"; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkAssignment {
  provider: string; // e.g. "codex"
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  host: string | null; // null = owning host
  workspaceId: string | null; // null = cut a fresh worktree
  isolation: "worktree" | "local";
}
```

`sequenceId` is allocated under the store's existing mutation queue (`registry.ts:183`), which serialises per host. The human key is `${identifier}-${sequenceId}`.

## 5. Auto-pickup

`WorkDispatcher` (`packages/server/src/server/work/dispatcher.ts`) subscribes to work-item mutations and to `AgentManager.subscribe`.

1. An item enters `lane === "todo"` with a non-null `assignment` → enqueue.
2. A concurrency cap gates the queue. Today the daemon has no general agent cap; `verifierConcurrency = 3` (`verifier.ts:31`) is the precedent. Add `work.autoPickupConcurrency`, default `3`, to daemon config. Dragging twenty items to Todo must not spawn twenty agents.
3. Dispatch resolves a host from `assignment.host`, else the owning host. It must have a workspace in the project.
4. `assignment.isolation === "worktree"` → `createPaseoWorktree` (`paseo-worktree-service.ts:64`), branch named from the item key.
5. Create the agent with `createAgentCommand` (`packages/server/src/server/agent/mcp/create.ts:188`), labels:
   - `paseo.work-item-id`, `paseo.work-item-key`, `paseo.work-project-key`
     Labels are `Record<string, string>` on the stored agent record (`agent-storage.ts:65`) — the same mechanism as `paseo.mission-control=commander`.
6. `initialPrompt` is a rendered brief: key, title, description, acceptance criteria, parent and sub-items, links, existing comments, and the instruction to comment on progress and call `report_status` at milestones.
7. Dispatch is a spawn, so it routes through `MissionControlApprovals.createProposal` (`approvals.ts:336`, `kind: "spawn"`). Ask mode still asks.

After step 7 the dispatcher stops caring. The card's column follows the agent's bucket with no further bookkeeping — that is the point of deriving.

Cross-host dispatch reuses `spawnProposalOnPeer` (`bootstrap.ts:329`) → `peerClient.fleetSpawnApply`.

## 6. Agent-facing tools

Register beside `report_status` in `packages/server/src/server/agent/tools/paseo-tools.ts:1452`. Each resolves the caller's item from its own labels; none takes an item id from the model for its own item.

| Tool                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `work_item_get`     | Read my assigned item with comments and sub-items                 |
| `work_item_comment` | Post a markdown comment                                           |
| `work_item_update`  | Update description, add links or proofs, tick acceptance criteria |
| `work_item_list`    | Read-only list for my project                                     |

**No `work_item_set_state` tool.** An agent moves its own card by working and by calling `report_status`; its bucket does the rest. A tool that writes a column would be the duplicate state the user forbade.

## 7. Cross-host reads

Copy `buildFleetContextData` (`packages/server/src/server/mission-control/context.ts:454`) exactly: serve local, then fan out to online peers, and represent an unreachable peer as `reachable: false` with an empty list. Never throw.

Writes resolve a host through `FleetIdIndex.resolveFleetId` (`fleet-id-index.ts:86`). Unreachable peers surface `buildPeerUnreachableError` (`:64`) — "Host X unreachable since … (likely asleep)".

No host-specific API appears anywhere in this feature.

## 8. Protocol

Namespace `work.`, dotted, `.request`/`.response` pairs, per [rpc-namespacing.md](../../rpc-namespacing.md).

Add feature flag `workBoard` to `ServerInfoStatusPayloadSchema.features` (`packages/protocol/src/messages.ts:3732`) with a COMPAT tag. The app gates the sidebar item on it once.

| RPC                                               | Purpose                                           |
| ------------------------------------------------- | ------------------------------------------------- |
| `work.project.list`                               | Work projects with per-column counts, fleet-wide  |
| `work.item.list`                                  | Items for a `projectKey`, fleet-wide              |
| `work.item.get`                                   | One item with comments, activity, sub-items       |
| `work.item.create` / `.update` / `.delete`        | CRUD. `create` requires an existing Paseo project |
| `work.item.move`                                  | Column intent plus `sortOrder`. Implements §2.1   |
| `work.item.dispatch`                              | Dispatch now                                      |
| `work.comment.list` / `.create`                   | Comments                                          |
| `work.activity.list`                              | Activity                                          |
| `work.label.list` / `.upsert` / `.delete`         | Labels                                            |
| `work.page.list` / `.get` / `.upsert` / `.delete` | Pages                                             |
| `work.draft.list` / `.create` / `.promote`        | Drafts                                            |
| `work.sticky.list` / `.upsert` / `.delete`        | Stickies                                          |
| `work.view.list` / `.upsert`                      | Saved views                                       |

Live updates push over the existing `Session.emit` fan-out: `work.item.updated` and `work.project.updated` outbound messages, gated on `workBoard`.

Wire schemas stay pure — no `.transform()`, `.catch()`, `.preprocess()`. Register in `SessionInboundMessageSchema` (`messages.ts:3337`), `WSInbound` (`:7495`), and `SessionOutboundMessageSchema` (`:6685`), then re-run `npm run generate:validators`.

## 9. Project mirroring

One direction only. Creating a Paseo project creates a work project. Creating a project from Work is refused, because a project needs a directory.

Hook `ProjectRegistry.subscribeToMutations` (`packages/server/src/server/workspace-registry/registry.ts:149`) — the one seam covering every creation path, including fleet meta-actions.

- Project created → ensure a `WorkProjectRecord` for its `projectKey`. Derive `identifier` from the display name, uppercase, ≤12 chars, uniquified with a numeric suffix.
- Project renamed → update the display name. Never change `identifier`, which is baked into existing item keys.
- Project archived → archive the work project; keep items.
- `work.item.create` against an unknown project → error `work_project_requires_paseo_project`.

## 10. App

Follow Mission Control as the worked example throughout.

- **Sidebar**: a `SidebarHeaderRow` above Mission Control at `packages/app/src/components/left-sidebar.tsx:1043`, icon `KanbanSquare`, label `Work`, gated on the `workBoard` host feature the same way `hasMissionControl` gates its neighbour.
- **Route**: `packages/app/src/app/work.tsx` plus `WorkPersistent`, copying `mission-control-persistent.web.tsx:24` so the surface is keep-mounted on web and does not yank on return. Register in `_layout.tsx:936` and add `buildWorkRoute` to `host-routes.ts`.
- **Layout**: project rail | work board | inspector. Compact form factor collapses to one pane with a `SegmentedControl`, as `mission-control-screen.tsx:577` does.
- **Inspector**: copy `MissionControlInspector` (`packages/app/src/screens/mission-control/inspector.tsx:65`). A card opens its item detail; if the item has an agent, the inspector embeds that live agent exactly as Mission Control does, with the same **Open in workspace** action (`:243`).
- **Views**: Board, Pages, Drafts, Stickies.
- **Drag and drop**: no new dependency. Metro platform split, re-exported from `work-board.tsx`:
  - `work-board.web.tsx` — `@dnd-kit/core@6.3.1` + `@dnd-kit/sortable@10.0.0` in one top-level `DndContext`, `pointerWithin` → `closestCenter` collision, `verticalListSortingStrategy` per column, `DragOverlay`. Copy `split-container.tsx:642` and `draggable-list.web.tsx:251`.
  - `work-board.native.tsx` — horizontal `ScrollView` with per-column `NestableDraggableFlatList` inside a `NestableScrollContainer`, plus `HorizontalScrollContext` arbitration (`horizontal-scroll-context.tsx:47`) so board panning does not fight mobile panel swipes.
- **Unistyles**: `useUnistyles()` is forbidden. Use `inlineUnistylesStyle` for drag transforms, a wrapper `View` for themed backgrounds, and never a Unistyles style on an `Animated.View` (`docs/unistyles.md:295`).
- **Hover**: plain `View` with `onPointerEnter`/`onPointerLeave` and a separate inner `Pressable`, per `docs/hover.md`. Card actions use `isHovered || isNative || isCompact`.
- **i18n**: every string goes through the existing i18n layer.

## 11. Verification

1. `npm run typecheck` and `npm run lint` green.
2. Targeted server tests only, via `createTestPaseoDaemon` (`docs/ad-hoc-daemon-testing.md:75`): column derivation, the drag intent table, sequence allocation, fractional ordering and rebalance, dispatcher concurrency cap, project mirroring, fleet aggregation with an unreachable peer.
3. Two dev daemons peered, on dev ports, never `6767`. Projects on both hosts; confirm the board aggregates both and that a killed peer degrades to `reachable: false` instead of erroring.
4. Browser drive the dev web UI: create an item, drag Backlog → Todo, watch an agent get created and the card land in In Progress on its own, open the agent from the card, comment as the agent, move to Done, confirm the same state shows in Mission Control and in the agent tab.

Never restart the daemon on port 6767.
