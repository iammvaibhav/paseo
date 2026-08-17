# Commander

The Commander is agentic Paseo: one chat where vague intent becomes correctly-placed work on the fleet. Whatever Paseo can do through its UI and RPCs, the Commander can do through tools. It orchestrates — it never implements, never verifies, never explores a codebase. This doc is the north star and doctrine; [docs/mission-control.md](mission-control.md) owns the machinery around it (board, feed, verifiers, stall detection); [docs/mission-control-roadmap.md](mission-control-roadmap.md) owns the path from today's implementation to this design.

## The three layers

Mission Control is three things that must not blur:

| Layer         | What it is                                                                                                    | AI?                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| The pane      | Board + feed + inspector. View-only: what runs, what needs you, what's ready, what's done, across every host. | No                                           |
| The machinery | Deterministic hygiene: stall detectors, watchdog, verifier dispatch, the approval gate, event store.          | Spawns verifier agents, never reasons itself |
| The Commander | The intent executor. You tell it what you want; it decides where and how the work runs.                       | Yes                                          |

The pane never waits on a model. The machinery never asks a model what to do. The Commander never re-derives what the daemon already knows.

## Responsibilities

1. **Answer fleet questions.** Status of an agent, what ran overnight, where a piece of work happened. Answers come from the world snapshot and lookup tools, not from memory of old digests.
2. **Turn intent into placed work.** Given a task — vague or precise — pick the host, project, workspace, and agent per the placement doctrine below, and propose the dispatch. Explicit user instructions always override the doctrine.
3. **Meta tasks.** Rename or archive projects, workspaces, and agents; move an agent to another workspace; promote an experiment to its own project; find an old agent and revive its work into a new place.
4. **Time and triggers.** Register scheduled work (cron), one-shot deferred work ("in three hours"), and webhook-triggered work, using the existing Paseo primitives as tools.
5. **Relay, don't absorb.** When a worker finishes, blocks, or asks a question, the outcome reaches you as a card. The Commander routes; it does not answer on the worker's behalf.

Out of scope forever: writing code, running commands, reading transcripts to guess at status, verifying work (verifiers do that), and any action that isn't expressible as one of its tools. When a request falls outside the tool surface, the Commander says so plainly — the ask itself is the signal that a tool is missing.

## Runtime model: durable thread, stateless turns

The Commander is one durable conversation, but the model behind it is stateless per turn. Three kinds of state get three different treatments:

| State                                                     | Treatment                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dialogue (what you asked, what it proposed)               | The thread. Recent turns verbatim, older turns as a rolling summary.                         |
| Fleet state (hosts, projects, workspaces, agents, models) | A **world snapshot** regenerated and injected into every turn. Never accreted, never deltas. |
| Cold history (archived agents, old runs, transcripts)     | Tools only: `fleet_search`, history, memory recall.                                          |

The world snapshot is the hot set: hosts + aliases, the project/workspace index with one-line descriptions, agents active in the last 24 hours bucketed by lifecycle, invocable models, and routing defaults. A few KB, computed at turn start, stamped with its own timestamp. The system prompt stays byte-stable so the prompt cache holds; the snapshot rides inside the turn.

**No digests.** The Commander's context never receives "this started, this stopped" event streams. Integrating events into current state is the daemon's job, and the snapshot is the result. When the machinery needs the Commander to act on an event — a decision-carrying blocked/stalled event, a verdict that needs routing — it triggers a machinery turn carrying that event plus a fresh snapshot, through the same assembly path as a user turn. Nothing queued can rot, because the payload is computed at delivery.

## The mailbox (delivery and follow-through)

The Commander is an actor: one identity, one sequential turn loop, a mailbox everything writes into. Parallel Commander turns were considered and rejected — turns take seconds (the Commander only decides and delegates), the real work is already parallel because workers are parallel, and concurrent turns can race placements and interleave cards.

- **Always accept.** Every inbound message — user chat, voice dispatch, machinery event — delivers immediately. Idle → a turn starts. Mid-turn → omp live-steer with an envelope: acknowledge in one line, fold the instruction into open work, prioritize the user, continue. Nothing cancels a running turn; nothing waits for one.
- **The instruction ledger.** The daemon (not the model) records every user/voice instruction as a ledger row (id, text, open/closed). The per-turn envelope re-lists open rows the way the snapshot re-lists fleet state, so compaction can never lose an instruction. Rows close when the Commander emits a card citing the instruction (`respondsTo` on proposals/answers/clarifications); verbose mode exposes a manual close.
- **Follow-through.** Verdicts of agents the Commander dispatched or adopted enter the same mailbox as machinery turns — in both modes; Ask mode stays safe because any follow-up action becomes a gated proposal. Terminal events (finished, failed, interrupted), started, and milestones never reach the mailbox: they are board/feed-rail only, and blocked/stalled reach the Commander only when a decision card attaches (spec 07). The Commander then proposes a follow-up, posts an answer card, or stays silent.
- **Adoption.** Dispatched = spawned by the Commander (`paseo.parent-agent-id`) or adopted (`paseo.commander-adopted-at`). Adoption happens on the first delivered `fleet_send_prompt`, or explicitly via `fleet_adopt_agent` — "take care of this agent" stamps the label without messaging the worker.

## Interaction grammar

The Commander has exactly three ways to speak in normal mode, and free narration is not one of them:

| Channel       | Rendering                       | When                                                                                                                                                                                                                |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proposal      | Card: Approve / Edit / Deny     | Every side-effectful intent — spawn, send, archive, rename, move, schedule. Ask mode holds the card; Auto mode auto-approves and the card records what happened. Destructive actions always ask.                    |
| Clarification | Card with options (+ free-text) | The Commander cannot resolve which agent/workspace/project you mean, or the missing fact is one only you know.                                                                                                      |
| Answer        | Answer card, structured         | Fleet questions. An agent-status answer renders name, host chip, state, last report, proofs — the same components as feed cards, so answers feel native. Free text only when the answer genuinely has no structure. |

Thinking, tool internals, and machinery messages render only in verbose mode. A proposal card shows: host chip, project (new or existing), workspace (new or existing), agent (new or existing), model, and the brief — no raw JSON in normal mode, full payload expandable in verbose. Edit sends your changes back to the Commander, which re-proposes; the new card supersedes the old one in place.

## Placement doctrine

The Commander is opinionated. The decision tree, in order:

1. **Explicit instruction wins.** "Run it on blrofc3 in workspace X" is followed, not second-guessed.
2. **Mutating work** (feature, bug, experiment that edits files) → matched project, **new workspace on a fresh worktree**. Two mutating agents never share a worktree.
3. **Read-only work** (research, review, questions) → the project's root workspace, or the workspace whose change it concerns.
4. **Verification and follow-up** on an existing change → the same workspace and worktree as the change, so the verifier sees what the worker did.
5. **No matching project**: substantial work → propose a new project; ad hoc work → the per-host `experiments` project (create it at `~/experiments` if missing). Experiments that prove out get **promoted** to their own project on request — a meta task the Commander performs.
6. **Agent granularity**: one agent per self-sufficient unit of work. Reuse an agent only when the task needs that agent's context; otherwise spawn fresh and pass context in the brief. An agent that accumulates unrelated jobs is a bug.

Matching "where does backtesting live" uses workspace/project descriptions in the snapshot first, memory recall second. When neither resolves it, clarification card.

## Capability boundary

Triage before dispatch:

- Missing info is **fleet-knowable** (which project, which host, which agent) → look it up. Never ask the user what the snapshot or a tool can answer.
- Missing info is **user-private or consequential** (credentials, payment, which of two ambiguous targets, anything destructive) → clarification card first. Don't burn a worker to rediscover a question the Commander can already see.
- Task is clear enough to start → dispatch. The worker's eventual questions come back as cards.

Never flat-refuse a request. Absurd or underspecified asks get a clarification card or a dispatch — whichever the triage says — and out-of-capacity asks get a plain statement of what tool is missing.

## Context architecture

Agents rarely work in isolation; new work builds on prior agents' decisions. Raw transcripts don't transfer — a 1M-token timeline is not context. The layered design:

1. **Run records.** When a run ends (or hits ready-for-review), the machinery writes a compact record: the brief, self-reported milestones and decisions (`report_status` history), the verdict, proofs, files touched. Deterministic — assembled from data the daemon already holds, no transcript reads, no model calls.
2. **Rollups.** Run records aggregate at the workspace level (the living state of a feature: what's done, what's decided, what's open) and the project level (durable decisions and conventions). The workspace rollup is what a new agent in that workspace gets for free.
3. **Semantic recall.** Paseo writes run records to Hindsight in its own fleet bank, tagged `host:… project:… workspace:… agent:…`. The Commander's recall tool queries it to answer "which agent did X" and to pull related context for a brief. The existing `omp` bank (project-tagged only, no agent attribution) stays read-only as a secondary source. Hindsight lives on one host; the tool degrades to "memory unavailable" when that host is unreachable, never blocks.
4. **Spawn-brief enrichment.** When the Commander dispatches, it includes the relevant run records and rollups in the worker's brief. Workers start warm.
5. **Deep dive is last resort.** Full transcripts remain reachable (History Ask, fork with chat history), but the Commander never reads them in the normal path.

Messages between agents (`fleet_send_prompt`, hub) are notes, not context transfer — same model as Claude Code's cross-session messaging: a message is text one agent writes to another; moving a conversation means forking it.

## Identity: names and titles are permanent, description lives

- An agent's **name** (the fun name) is assigned once at creation and never changes. Names exist so a human can identify an agent across the board, the feed, transcripts, and memory — a name that mutates breaks every past reference to it.
- The **title** is written once at registration (`explicit ?? first prompt line ?? derived stub`) and then **frozen**: `report_status.title` is accepted only as a backfill when the record has none, and ignored afterwards (the tool result says "title is fixed; description updated"). The only rename path is `fleet_rename_agent_title` — a deliberate meta action, never an agent's self-report.
- The **description** is the living layer — "what I'm doing right now", a fresh 2-3 sentences (~400 chars) on every `report_status`; the daemon nags when a record lacks one. Board rows render title as the key line, name as the identity chip, description on hover.
- Changing the naming theme affects **new agents only**. There is no re-mapping of existing names, no rename RPC for named agents, no backfill that touches an already-named agent.
- Collision resistance comes from pool size, not renaming: generation draws from a combinatorial pool (qualifier + name) large enough that per-host uniqueness checks almost never collide, with the host glyph disambiguating across hosts.

## The Commander's own footprint

The Commander lives in a reserved home (`~/.paseo/commander`) inside a system workspace no user project can collide with. Everything system-owned — the Commander's workspace and agent, verifier agents, machinery messages — is hidden everywhere by default: sidebar, history, project lists, board buckets, badge counts. The Mission Control **verbose** toggle is the single debug gate: on, you see all of it, everywhere; off, none of it, anywhere. One predicate decides what "system-owned" means; no surface implements its own variant.

## Tools

The full catalog (25 tools; every mutating tool routes through the approval gate). Ids are fleet-wide: tools accept bare ids — agent UUID, `prj_*`, `wks_*`, `mcp_*` — and the commander host resolves them through the fleet id index; `host` is an optional hint, never a required routing key (spec 02).

| Tool                                                                                         | Purpose                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- |
| `fleet_list_agents`                                                                          | Roster across hosts. Rows carry the server-computed `bucket`, `workspaceId`/`projectId`/`serverId`, name, title, description, and last report headlines; filter by `bucket` (closed enum) or fuzzy `query`.                                         |
| `fleet_list_models`                                                                          | Invocable provider/model strings + the default worker model per host. Use before spawning.                                                                                                                                                          |
| `fleet_list_inventory`                                                                       | Hosts → projects → workspaces (`prj_*`/`wks_*` ids, cwd), optional fuzzy query. THE resolve-first tool: act only on returned ids, never on a spoken name.                                                                                           |
| `fleet_get_agent_activity`                                                                   | One agent's curated timeline. Read-only — never pokes the agent.                                                                                                                                                                                    |
| `fleet_search`                                                                               | Find agents by what they worked on (tiered: deterministic context, transcript scan, History Ask when `deep`).                                                                                                                                       |
| `fleet_recall`                                                                               | Semantic recall over the fleet memory bank (run records).                                                                                                                                                                                           |
| `fleet_context`                                                                              | Run records / workspace·project rollups for brief enrichment.                                                                                                                                                                                       |
| `fleet_agent_status`                                                                         | One-call "how is X doing": identity, canonical bucket, lastStatus, running turn, last report. `fresh: true` steers a status-ask (user-invisible machinery envelope, ≤60s wait) — the only mid-run status mechanism, fires only on explicit request. |
| `fleet_monitor`                                                                              | Session-scoped watches (`start`/`stop`/`status`, `fleet` or per-agent). Terminal events announce for the watched scope; never blocks the conversation.                                                                                              |
| `fleet_create_agent`                                                                         | Spawn a worker on a host (gated). Placement: `workspaceId` present → host derived via the index; no placement → `host` required (a new worktree must land somewhere).                                                                               |
| `fleet_send_prompt`                                                                          | Message/steer a worker (gated; `mode: steer                                                                                                                                                                                                         | interrupt | queue`). |
| `fleet_rename_project` / `fleet_rename_workspace` / `fleet_rename_agent_title`               | Meta renames (gated). `fleet_rename_agent_title` is the ONLY path that changes a frozen title.                                                                                                                                                      |
| `fleet_archive_project` / `fleet_archive_workspace` / `fleet_archive_agent`                  | Meta archives (gated; destructive → always ask).                                                                                                                                                                                                    |
| `fleet_create_project`                                                                       | `{ host, path, title? }` — host required, a new path must land somewhere.                                                                                                                                                                           |
| `fleet_move_agent` / `fleet_promote_workspace` / `fleet_adopt_agent` / `fleet_release_agent` | Meta moves / adoption (gated). `fleet_adopt_agent` = "take care of this agent" without messaging it.                                                                                                                                                |
| `tag_message`                                                                                | Attribute your messages to agents for verifier audits.                                                                                                                                                                                              |
| `clarify` / `post_answer`                                                                    | The two answer-card tools.                                                                                                                                                                                                                          |

The legacy `fleet_meta` tool stays registered as a `COMPAT(fleet-meta-alias)` (remove after 2026-10-01) for external/MCP callers; it is NOT in the allowlist — the Commander uses the 11 flat tools above. Time-and-triggers (schedules, webhooks, one-shot deferred runs) are still not tools.

**Fail fast, dedupe, error contract** (spec 03): every mutation validates at call time — id family shape, live existence via the index, absolute `cwd`, peer reachability — before building a proposal; approval-time checks stay as the second line. An identical mutation while the previous is pending/in-flight returns the existing `proposalId` with `guidance: "already pending"`. Every rejection names the offending field, the expected id family/enum, and live candidates when known (an unknown agent → nearest matches + "call fleet_list_agents(query)"; a host-hint mismatch → the actual host). No bare "invalid input" — the model self-corrects in one step.

The tool allowlist stays explicit and hash-versioned; drift recreates the Commander session. A capability that isn't a tool doesn't exist — the Commander never shells out, never improvises.
