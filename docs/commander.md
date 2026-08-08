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

**No digests.** The Commander's context never receives "this started, this stopped" event streams. Integrating events into current state is the daemon's job, and the snapshot is the result. When the machinery needs the Commander to act on an event — a stall escalation in Auto mode, a verdict that needs routing — it triggers a machinery turn carrying that event plus a fresh snapshot, through the same assembly path as a user turn. Nothing queued can rot, because the payload is computed at delivery.

Turns are serialized today. Because state is externalized, independent user queries could run as parallel turns against the same thread; that is specced in the roadmap, not built.

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

## Identity: names are permanent

- An agent's **name** (the fun name) is assigned once at creation and never changes. Names exist so a human can identify an agent across the board, the feed, transcripts, and memory — a name that mutates breaks every past reference to it.
- Changing the naming theme affects **new agents only**. There is no re-mapping of existing names, no rename RPC for named agents, no backfill that touches an already-named agent.
- Collision resistance comes from pool size, not renaming: generation draws from a combinatorial pool (qualifier + name) large enough that per-host uniqueness checks almost never collide, with the host glyph disambiguating across hosts.
- The **title** is the living layer — it tracks the agent's current theme and may be rewritten by the agent itself on genuine divergence. The **description** is the freshest layer — "what I'm doing right now", updated on every report. Name never moves; title moves rarely; description moves constantly.

## The Commander's own footprint

The Commander lives in a reserved home (`~/.paseo/commander`) inside a system workspace no user project can collide with. Everything system-owned — the Commander's workspace and agent, verifier agents, machinery messages — is hidden everywhere by default: sidebar, history, project lists, board buckets, badge counts. The Mission Control **verbose** toggle is the single debug gate: on, you see all of it, everywhere; off, none of it, anywhere. One predicate decides what "system-owned" means; no surface implements its own variant.

## Tools

Current surface (all mutating tools route through the approval gate):

| Tool                       | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `fleet_list_agents`        | Roster across hosts                                   |
| `fleet_create_agent`       | Spawn a worker on a host (gated)                      |
| `fleet_send_prompt`        | Message/steer a worker (gated)                        |
| `fleet_get_agent_activity` | One agent's curated timeline                          |
| `fleet_search`             | Find agents by what they worked on                    |
| `tag_message`              | Attribute your messages to agents for verifier audits |

Target additions, in roadmap order:

| Tool                                                                                                  | Purpose                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `fleet_meta` (rename/archive project·workspace·agent, move agent, promote experiment, create project) | The meta tasks. Moving an agent between workspaces needs a new daemon RPC — it does not exist today.                           |
| `fleet_recall`                                                                                        | Semantic recall over the fleet memory bank (run records)                                                                       |
| `fleet_context`                                                                                       | Fetch run records / workspace rollups for brief enrichment                                                                     |
| Schedules + webhooks CRUD, one-shot deferred runs                                                     | Time and triggers. One-shot = a schedule with `maxRuns: 1`, surfaced as its own tool so "in three hours" needs no cron syntax. |

The tool allowlist stays explicit and hash-versioned; drift recreates the Commander session. A capability that isn't a tool doesn't exist — the Commander never shells out, never improvises.
