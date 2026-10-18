# Mission Control

Fleet monitoring. One screen: a deterministic **board** of every agent on every host, grouped by lifecycle bucket, with an **inspector** that opens any agent in place, and the **Agent Grid**. Agents report their own status with `report_status`; nothing reads transcripts to guess. Bots run the fleet through the fleet MCP tools on `/mcp/fleet`.

There is no built-in Commander agent and no approval gate. "Commander" is a role: the bot Vaibhav names in `OPERATING.md` (served by `fleet_playbook`) turns asks into tickets and agents. The daemon only provides tools, state, and notifications.

No LLM gateway in this feature. Everything is omp.

## Vocabulary (glossary-bound)

| Term             | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Board            | Every agent, every host, grouped by bucket. Plain data, no AI, cannot die.                                        |
| Inspector        | Embedded agent view inside Mission Control. Clicking a board row opens the agent here, never navigates away.      |
| Ready for review | The agent finished a run (or reported `completed`) and awaits a user verdict.                                     |
| Done             | Reviewed and confirmed complete. Bookkeeping only; a single-agent workspace auto-archives on Done (PASEO-21).     |
| Dormant          | Pre-rollout or long-idle agents. Hidden by default; visible via the "All unarchived" toggle.                      |
| report_status    | The tool every agent gets: self-reported status, title, description, milestones, proofs, learnings.               |
| Machinery prompt | A prompt the daemon itself sends an agent (status ask, stall recovery, abort resume). Never a user's instruction. |

## Architecture

```
worker agents --report_status--> event store --instant push--> app (board, inspector)
                                   |
                                   +--ready-for-review--> run record --> fleet-memory (outbox)
terminal-state guarantee --run ended, zero self-reports--> one status-ask steer (machinery prompt)
dormant-turn detector --no output, no tool in flight--> recovery interrupt (machinery prompt)
watchdog --dead session, running record--> self-heal + stalled event
bots --/mcp/fleet--> fleet tools (spawn, send, wait, meta, memory) --> agents on any host
itsaplan Todo ticket --bridge--> fleet_create_agent (placed from the brief)
```

The board never waits on any LLM. Events hit the store and push to clients instantly.

## Production rules

Hard rules for anything user-visible in Mission Control. A violation is a bug even before it shows.

- **Snapshot at emit.** A recorded card renders the values that were true when the event was recorded. Never render live agent state as historical truth. Exactly two exceptions: the name chip (names are immutable anyway) and explicitly-ticking relative timestamps.
- **Immutable cards.** Once recorded, a card never mutates. Enrichment records new data; it never rewrites old rows.
- **No shared predicates.** Two unrelated behavioral rules never share one predicate — the coalesce check doubling as the rate-limit escape silently reintroduced a fixed bug. Duplicate the logic instead.
- **Machinery never rewrites user-visible timestamps.** Boot, restore, and reconciliation must not stamp activity fields that any surface renders as "when this really happened".
- **Client caches die on reconnect.** Any app-side cache of daemon state resets when the host connection cycles.
- **Names are permanent.** Assigned once at creation, never re-mapped; theme changes affect new agents only.
- **One system-owned filter.** A single predicate (`isSystemOwnedAgentLabels`) decides what the verbose debug gate hides; no surface rolls its own variant.

## Status reporting (`report_status`)

```ts
ReportStatusInput = {
  status: "working" | "completed" | "inconclusive" | "blocked",  // working/inconclusive still parse for legacy clients
  headline: string,        // <=120 chars, plain language
  detail?: string,         // 1-2 sentences
  kind?: "finding" | "fix" | "milestone" | "decision" | "progress",
  title?: string,          // ONLY when the record has no title yet; ignored afterwards
  description?: string,    // living 2-3 sentence description, ~400 chars max
  proofs?: Proof[],
  learnings?: { title, body, kind? }[],  // with completed: each becomes a fleet-memory vault note
}
```

Rules baked into the injected system-prompt appendix:

- Report at major steps only: root cause found, fix landed, tests green, blocked, direction changed, done. Silence between milestones.
- **Title is write-once.** Set at registration (`explicit ?? first prompt line ?? derived stub`), then frozen. The only rename path is `fleet_rename_agent_title`.
- Send `completed` only when everything asked is conclusively done; `blocked` when waiting on a decision.
- Claims of completion carry proofs.
- **Description = 2-3 sentences, under ~400 characters.** The naming backfill accepts up to 400 chars (`DESCRIPTION_MAX_CHARS`).

`status: "completed"` moves the agent to ready-for-review (post-rollout). A finished run also moves it: under `evaluationScope: "all"` only when the run is auditable (a launch brief AND at least one `report_status` this run); under the default scope every finished run is marked ready. Event cards snapshot `agentName`, `agentTitle`, and `agentDescription`.

**Feed coalescing is run-scoped.** A later event supersedes the previous unacked card of the same kind and inherits its detail/proofs. A `started` event — or a daemon restart — opens a new run, so a later event neither coalesces over nor inherits from an earlier run's card. The 60s `report_status` rate limit is run-scoped the same way.

## Lifecycle

Buckets: **Needs you** (pending permission, error) → **Running** → **Ready for review** → **Done** → **Idle**. One function — `deriveLifecycleBucket` in `@getpaseo/protocol/agent-state-bucket` — computes the bucket server-side from stored state and exposes it as `bucket` on roster rows, `fleet_list_agents` rows, and agent snapshots. Every consumer reads that field.

- **Clean finish → ready, never needs-you.**
- **Ready aging**: when `readyAgeOutDays > 0`, a daily sweep moves old `ready` rows to done with `verdict: "aged-out"`. Default 0 (disabled).
- **User-stopped ≠ Needs you**: an agent whose last run the user stopped lands in **Done** with a "Stopped by you" chip. **Clear** writes `reviewState: "cleared"`. A new run clears the stop origin.
- Done is set by the user (Mark done, the itsaplan ticket moving to Done). Clear removes a row from Done; any new run puts the agent back in Running.
- Board default view: last 30 days; toggle shows all unarchived agents.

Store: `reviewState: "none" | "ready" | "done" | "cleared"` + `verdict {by, summary, at}` per agent, persisted in the mission-control store (JSONL + snapshot). `verdict.by: "verifier"` only appears on records from before the Verifier was removed.

## Delivery modes (steer / interrupt / queue)

How a send reaches a **busy** agent. Idle agents always just run the prompt. Every mode first unarchives an archived agent and loads a closed one (`sendPromptToAgent`).

| Mode        | Semantics                                                                                                                          | Used by                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `steer`     | Inject into the live turn without cancelling (native OMP `/steer`). **Non-OMP fallback: interrupt** so the message lands promptly. | **Default** for `fleet_send_prompt` and `send_agent_prompt`; status-ask steers         |
| `interrupt` | Cancel the running turn and replace it with the prompt (`replaceRunning: true`).                                                   | A send where the user asked to cancel the running turn; dormant-turn recovery          |
| `queue`     | Wait for idle (bounded, 10 min), never cancelling.                                                                                 | Machinery only (`fleet_agent_status` notify on non-OMP agents). No send tool takes it. |

- **Send tools never take `queue`**: a queued send holds the tool call open until the agent goes idle, and MCP gateways cut that off — Bifrost on `prod` cancels any MCP tool call after 30 s — while the daemon still delivers minutes later and the caller's retry queues a second copy.
- `dispatchLocalPromptMode` reports what actually happened: a steer delivered via the fallback returns `"steer-interrupt"`.
- The composer's Default send has a third mode, **Steer** (Interrupt stays the default).

## Machinery prompts in the agent's own chat

Every prompt the daemon delivers into a worker's chat carries a classification on its `user_message` timeline row — `"machinery"` (status asks) vs `"instruction"` (everything else). **Absent = instruction (visible)**, so real user messages are never hidden.

- **Steers record a row — always.** The native OMP `/steer` records no row in Paseo's timeline, so `dispatchLocalPromptMode` appends one on a handled steer.
- **Status asks are auditable, never raw**: a `"machinery"` row renders as a muted "Mission Control asked for a status" placeholder only in verbose mode.
- **Machinery rows are not agent activity**: the stall tracker ignores them for the dormant-turn clock.
- **A user stop always wins**: machinery never prompts an agent whose last run the user stopped (`deliverMachineryPrompt`).

## Watchdogs + the terminal-state guarantee

The only automatic status ask is the **terminal-state guarantee**: when a run ends (finished, failed, machinery interrupt — never user-stop) with ZERO self-sourced `report_status` calls, the daemon sends exactly ONE status-ask steer per finish chain. If the steer's run still produces nothing, the record gets a deterministic description fallback. `fleet_agent_status { fresh: true }` is the only mid-run status ask.

No wall-clock nudges. What remains is failure recovery, delivered directly as machinery prompts:

- **Eligibility — root agents with a run in progress.** Subagents and machinery-labeled agents are never recovered.
- **Reconciliation watchdog**: record `running` but provider runtime dead >2 min → self-heal to error, emit stalled, log loudly, send the recovery interrupt.
- **Dormant-turn detector** (`dormantTurnSeconds`, default 300): a running agent with no timeline output AND no unmatched in-flight tool call has a wedged turn → interrupt-and-continue. An agent inside a long declared tool call (a 30-minute `hub wait`) is working, never flagged. A pending permission counts as in flight.
- **Provider-side abort** (`stopReason=aborted` with no user stop): one resume steer per run epoch.
- **Boot adoption of surviving runs**: records still `running` whose runtime is alive are adopted into tracking at boot, seeded from `lastActivityAt`.
- Knobs: `dormantTurnSeconds` and the `stallDetectionEnabled` master switch. `silenceNudgeSeconds`, `statusNudgeSeconds`, and `escalateSeconds` are legacy keys nothing consumes. Values under ~4 min risk false positives: the slowest legitimate model call observed was 178.6s, and Paseo cannot see a model request in flight.

## Fleet MCP (`/mcp/fleet`) and the Commander role

Remote MCP clients (configured under `daemon.mcp.remoteClients`) get the fleet tools. Every call applies directly: spawns are top-level agents, meta actions (rename, move, archive, promote, create project) run on the target's host. The tool descriptions say to ask Vaibhav before archiving anything he did not name; the archive tools take `dryRun: true` to list the agents an archive would take with it (running ones flagged) without archiving.

- `fleet_create_agent` fills whatever the caller left out from one placement call (`RoutingService.suggest`): host, cwd, isolation, model, agent mode. A host the prompt names binds the placement; a model the prompt names wins; git projects always get a fresh worktree, including a caller-given cwd that is a git project root (`RoutingService.isolationForCwd`). The base ref is paseo.json `worktree.warmPool.baseRef`, else the remembered base branch, else the repo default. `dryRun: true` returns the plan without creating anything. `ticket: "new"` or a key (`PASEO-71`) gives the agent its ticket on the agent's host (`fleet_ticketize_agent`), and `ask` (Vaibhav's words) is commented on it.
- `fleet_playbook` returns `OPERATING.md`; `memory_search` / `memory_get` / `memory_write` reach fleet-memory (below).
- Peers run host-owned work for each other over `mission_control.tools.execute`, limited to `fleet_wait_agent`, `fleet_unarchive_agent`, `fleet_unarchive_workspace`, `fleet_agent_status`, and `fleet_ticketize_agent`.
- Finish notifications go to the named notify targets (`daemon.mcp.notifyTargets`) that a create or send armed. A turn Vaibhav starts from the app (a `mobile` or `browser` session's send) arms the same watch for every client subscribed to the agent, and its `paseo.agent.finished` carries `origin: "user"` (otherwise `"tool"`). Milestones are never sent to bots; they go to the ticket.

## Memory

fleet-memory is a separate service (on blrofc3, GPU embeddings) behind `memory.url` in each host's `config.json`. The daemon pushes indexed transcripts and finalized run records through a durable per-host outbox (`~/.paseo/memory/outbox.db`) with backoff, and re-offers its whole history every 5 minutes until one full pass lands. Hindsight is no longer written or read.

## itsaplan bridge

A Todo ticket with no open blockers, assigned or delegated to the project's bot user ("Paseo"), is dispatched by the bridge on the host that owns the board's webhook: it calls `fleet_create_agent` with the ticket brief and the `itsaplan.issue` label, and routing places the worker. Each host syncs only its own projects; a repo checked out on several hosts maps to one board, and only the host that created it registers the webhook.

The bridge writes the ticket's routine comments: "Dispatched", each `report_status` milestone/finding/inconclusive (`Finding: <headline>`), the agent's open question, "Ready for review" with proofs, and every prompt Vaibhav sends the agent directly from the app.

## Protocol

Per docs/rpc-namespacing.md and docs/protocol-compatibility.md. The Commander-era RPCs (`proposals.*`, `mode.set`, `instructions.*`, `inbox.fetch`, `commander.reset`, `voice.mirror`, `tag_message`, `recall`, `context.records`, `search`, `spawn.apply`, `spawn_labels.resolve`, `event.forward`, `config.replica`) stay in the protocol schemas for old clients but have no handler.

- `mission_control.lifecycle.set.request/response` — mark done / clear / reopen `{ serverId, agentId, action }`.
- `mission_control.config.get/patch.request/response` — this host's Mission Control config.
- `mission_control.events.fetch` — cursor paging (`beforeSeq`, `limit`).
- `mission_control.meta.apply.request/response` — a peer applies a meta plan on its own registries.
- `mission_control.tools.execute.request/response` — peer tool execution (see Fleet MCP).
- Push: lifecycle changes ride `mission_control_event`; owned-subscription clients get it through `observeEvents(["mission_control_event"])` on hosts advertising `features.missionControlEventSubscription`.
- Feature flag: `server_info.features.missionControlV3: true` gates the inspector.

## Config

Per host, all of it. Flotilla writes each host's files; nothing replicates between daemons.

`config.json`:

- `missionControl.enabled`, `missionControl.hostAlias` — this machine's alias.
- `memory.url` — fleet-memory.
- `daemon.mcp.remoteClients`, `daemon.mcp.notifyTargets` — fleet MCP clients and finish-notification targets.

`mission-control/central-config.json` (the name predates per-host config):

- `retentionDays` (default 30), `readyAgeOutDays` (default 0), `evaluationScope`
- `namingTheme`, `hideAgentNames`, `defaultDispatchHost`
- `routing` (placement: hosts, project roots, work hosts, `hostAliases`, model per mode, rules) and `itsaplan`
- `stallDetectionEnabled`, `dormantTurnSeconds`, `trackSubagents`

Commander-era keys (`commanderHost`, `commanderModel`, `commanderInstructions`, `mode`, `verifier*`, `trackCommanderWorkers`, `trackVerifiers`, `hindsight*`, `voice*`) still parse and are ignored.

## App

- **Screen**: header with **Board | Agent Grid**. Board view: the board plus the inspector rail when an agent is open. Compact: the inspector is a full-screen push.
- **Inspector** = embedded `AgentStreamView` with composer. Header: name/title, host glyph, "Open in workspace →" (the only thing that navigates). Reports `focusedAgentId` via the heartbeat.
- **Board**: running sorted by name (stable); needs-you / ready / done / dormant by time desc (dormant by real last activity). Rows: title is the key line, name is the identity chip, one-line last report. Host glyph: deterministic accent color + alias initial, overridable per host.
- **Board row context menu** (docs/menus.md): Open in workspace; Copy reference; Stop (running rows); Mark done / Clear; Archive (non-running rows).
- **Badges**: the sidebar Mission Control row shows needs-you and ready-for-review count chips, each only when non-zero.
- **Verbose mode = the debug gate** (Settings → Mission Control → Display): system-owned artifacts and machinery rows show only while it is on.
- **Settings**: Mission Control settings edit the config of the host the app talks to (local daemon, else the first host).
- **Names**: write-once; `hideAgentNames` hides chips leaving titles.

## Naming backfill (one-time, via omp scout — no in-daemon provider calls)

- One bulk omp one-shot per host (default model `@smol`), metadata-driven — never transcripts: current name/title/description + first user prompt excerpt (~200 chars) + last report_status headline. Descriptions capped at 400 chars.
- **Agent titles are replaced only when auto-generated** (they match the deterministic derivation from the first prompt). Anything else is user-set and untouched.
- Workspaces: old→new rename proposals only for titles equal to derived defaults, with the workspace's agents as context. Never auto-applied.
- **Deliverable = markdown report per host** (`--report <path>.md`); `--apply` consumes only the approved file.

## Logging

Background mechanisms log under `module: "mission-control"` with `component`: `stall` (status ask, watchdog heal, machinery prompts), `dormant-turn`, `turn-lifecycle` (turn-step transitions with ages), `context`, `naming`. `grep mission-control ~/.paseo/daemon.log` must tell the whole story.

**Turn-step lifecycle retention**: turn-step transitions also mirror to `~/.paseo/mission-control-lifecycle.jsonl`, rotated at 10 MB to `<name>.1` (~20 MB retained) — the single-file daemon.log had already rotated past a 30-minute-old incident window.

## Edge cases (bound decisions)

- Machinery-labeled agents (old Commander/Verifier records, build-hash stamps) are hidden from board buckets, badge counts, and the feed. Subagents are lifecycle-tracked when `trackSubagents` is on.
- Board rows show a "Stopped by you" chip only from a terminal event snapshot, except for event-less agents, where the live stop origin is the only record.
- Host offline: board shows a "host offline" row; memory pushes queue in the outbox and retry when it returns.

## Verification checklist (dev stack; NEVER restart the production daemon on 6767)

1. A worker's `report_status` → instant card; `completed` → ready-for-review; Mark done → done.
2. Board: stable order while agents stream; buckets correct; dormant hidden until toggle; Done + Clear; badges.
3. Inspector: row click opens in place, composer replies, Open in workspace navigates.
4. `/mcp/fleet`: `fleet_create_agent` with and without placement, `dryRun`, send, wait, a meta action, `memory_search`.
5. Watchdog: kill a worker's provider process → record self-heals + stalled event + recovery prompt.
6. Typecheck, lint, format, build:client, build:server all green.
