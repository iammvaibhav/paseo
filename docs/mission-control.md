# Mission Control

Fleet monitoring and dispatch. One screen: a deterministic **board** of every agent on every host, a **feed** of self-reported status cards, a **Commander** agent you chat with that routes work, and ephemeral **Verifier** agents that audit finished work by its evidence. This doc is the implementation spec and the arbiter when two slices disagree.

Mission Control is three layers that must not blur: the **pane** (board, feed, inspector — view-only), the **machinery** (deterministic hygiene: stall detectors, watchdog, verifier dispatch, the approval gate), and the **Commander** (the intent executor). [docs/commander.md](commander.md) is the Commander's north star and doctrine; [docs/mission-control-roadmap.md](mission-control-roadmap.md) tracks the path from this implementation to that design. Where this doc and commander.md disagree, commander.md wins on direction; this doc describes what is built.

Parked in the roadmap: mid-run milestone announcements are P3 and must be hook-driven — prompt-only reporting is unreliable, agents forget, so no prompt-rule variant of milestone announcements will be shipped.

No LLM gateway anywhere in this feature. Everything is omp. Agents report their own status via a tool; nothing reads transcripts to guess.

## Vocabulary (glossary-bound)

| Term             | Meaning                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board            | Right rail: every agent, every host, grouped by bucket. Plain data, no AI, cannot die.                                                                                     |
| Feed             | Status cards interleaved with your Commander conversation in one thread.                                                                                                   |
| Commander        | The single durable fleet agent you chat with. Fast model. Routes, dispatches, steers. Never implements, never verifies.                                                    |
| Verifier         | Ephemeral omp agent spawned per ready-for-review item. Audits proofs against the brief. Marks done. Dies.                                                                  |
| Inspector        | Embedded agent view inside Mission Control (right half). Clicking a board row or feed card opens the agent here, never navigates away.                                     |
| Ask mode         | Every outbound action (steer, status-ask, proof demand) becomes a proposal card requiring Approve/Edit/Deny. Default. The status-ask steer is the one auto-sent exception. |
| Auto mode        | Proposals send immediately; card logs what went out. Destructive actions and user-presence conflicts still ask.                                                            |
| Ready for review | Agent finished a run that earned an audit (or self-reported completed) and awaits a verifier/user verdict.                                                                 |
| Done             | Reviewed and confirmed complete. Bookkeeping only — never archives the agent.                                                                                              |
| Dormant          | Pre-rollout or long-idle agents. Hidden by default; visible via the "All unarchived" toggle.                                                                               |
| report_status    | The MCP tool every agent gets: self-reported status, title, description, milestones, proofs.                                                                               |

## Architecture

```
worker agents --report_status tool--> event store --instant push--> app (board + feed)
                                        |                |
                                        |                +--decision events, AUTO mode--> machinery turn --> Commander
                                        |                     (verdict needs routing / decision-carrying blocked·stalled)
                                        +--ready-for-review--> verifier dispatcher --spawn--> Verifier (ephemeral)
                                                                       |
terminal-state guarantee --run ended, zero self-reports--> one status-ask steer (machinery envelope, auto-sent)
dormant-turn detector --no output, no tool in flight--> recovery interrupt (via approval gate)
watchdog --dead session, running record--> self-heal + stalled event

ALL outbound sends (Commander steers, Verifier contacts, status-ask steers, recovery interrupts) --> approval gate --> proposal card --> send
```

The board and feed never wait on any LLM. Events hit the store and push to clients instantly. The Commander receives fleet state only as a **per-turn world snapshot** (regenerated and injected before every user turn and machinery turn, never accreted — commander.md, roadmap M3); machinery turns carry **only decisions** (spec 07): blocked/stalled events reach the Commander only when a decision card attaches (pending proposal or clarification) — otherwise they are board bucket + badge + monitor announce; verdict-insufficient on a dispatched agent goes to chat; user Mark done / Clear and other `stateOnly` verdicts never dispatch (the next user turn already sees the new bucket in the snapshot); finished/failed/interrupted/started/milestone never dispatch. Ask mode never dispatches machinery turns — the feed card is the ask.

## Production rules

Hard rules for anything user-visible in Mission Control. A violation is a bug even before it shows.

- **Snapshot at emit.** A recorded card renders the values that were true when the event was recorded. Never render live agent state as historical truth. Exactly two exceptions: the name chip (names are immutable anyway) and explicitly-ticking relative timestamps.
- **Immutable cards.** Once recorded, a card never mutates. Enrichment records new data; it never rewrites old rows.
- **No shared predicates.** Two unrelated behavioral rules never share one predicate — the coalesce check doubling as the rate-limit escape silently reintroduced a fixed bug. Duplicate the logic instead.
- **Machinery never rewrites user-visible timestamps.** Boot, restore, and reconciliation must not stamp activity fields that any surface renders as "when this really happened".
- **Client caches die on reconnect.** Any app-side cache of daemon state resets when the host connection cycles.
- **Names are permanent.** Assigned once at creation, never re-mapped; theme changes affect new agents only (see commander.md).
- **One system-owned filter.** A single predicate decides what the verbose debug gate hides; no surface rolls its own variant.

## Status reporting (`report_status`)

Replaces `report_milestone` (clean cutover: tool renamed, schema extended, prompt injection updated; delete the old name everywhere).

```ts
ReportStatusInput = {
  status: "working" | "completed" | "inconclusive" | "blocked",
  headline: string,        // <=120 chars, plain language
  detail?: string,         // 1-2 sentences
  kind?: "finding" | "fix" | "milestone" | "decision" | "progress",
  title?: string,          // ONLY when the record has no title yet (backfill); ignored afterwards — "title is fixed; description updated". Only fleet_rename_agent_title renames.
  description?: string,    // living 2-3 sentence description, ~400 chars max (same rule)
  proofs?: Proof[],
}
Proof = {
  kind: "image" | "video" | "api" | "code" | "pr" | "url",
  path?: string,           // file on the agent's host
  url?: string,
  label?: string,
  excerpt?: string,        // inline content for api/code proofs
}
```

Rules baked into the injected system-prompt appendix (daemon-side, rides the same injection path as today):

- Report at major steps only: root cause found, fix landed, tests green, blocked, direction changed, done. Silence between milestones.
- **Title is write-once.** Set at registration (`explicit ?? first prompt line ?? derived stub`), then frozen: `report_status.title` is accepted only as a backfill when the record has none; afterwards the daemon ignores it and the tool result says "title is fixed; description updated". The only rename path is `fleet_rename_agent_title`.
- `completed` means conclusively done — everything asked, finished. Any doubt, cut short, still in discussion: report `inconclusive`, never `completed`.
- Claims of completion should carry proofs. The worker owns proving; verifiers will demand proof otherwise.
- Prefer hub-wait over `sleep`/timeout polling loops (also added to Commander playbook and worker brief templates).
- **Description = 2-3 sentences, under ~400 characters** (bound decision: the description is the Commander's context, so a little more is better). The server-side caps agree — the naming backfill accepts up to 400 chars (`DESCRIPTION_MAX_CHARS`).

`status: "completed"` always moves the agent to ready-for-review (post-rollout) — the self-declared completion is the explicit audit trigger. A finished run also moves it: under scope `"all"` only when the run is auditable (a launch brief AND at least one `report_status` this run — see Verifier); under scope `"commander"` every finished run is marked ready and the verifier's scope filter decides. `description` updates flow through the identity path (board, tabs, everywhere — same names everywhere, no diffs); titles never change after registration. Event cards snapshot `agentName`, `agentTitle`, and `agentDescription` as additive fields.

**Feed coalescing is run-scoped.** Same-kind cards coalesce: a later event supersedes the previous unacked card of that kind and inherits its detail/proofs (a system run-end `finished` keeps a self-reported completion's evidence). A `started` event — or a daemon restart — opens a new run, so a later event neither coalesces over nor inherits detail/proofs from an earlier run's card, and `coalescedCount` counts only within the current run. The 60s `report_status` rate limit is run-scoped the same way: a new run's first report is never spam and is always admitted, but it still starts a fresh chain (never folds into the previous run's card). Proposals are the exception: a proposal's status changes supersede in place across runs, because they are one logical card. Commander interaction cards (`answer` / `clarification`) never coalesce — each is content TO the user, and a later card must not hide an earlier one. (Incident: an unacked completion card absorbed 23 later finishes across 8 hours, re-displaying a stale report and stale proofs on every finish — the fix bounds the chain by run.)

## Lifecycle

Buckets: **Needs you** (pending permissions/proposals, error) → **Running** → **Ready for review** → **Done** → **Idle**. One function — `deriveLifecycleBucket` in `@getpaseo/protocol/agent-state-bucket` — computes the bucket server-side from stored state (agent record + review-state + proposal index), never from a truncated client event fold, and exposes it as `bucket` on roster rows, `fleet_list_agents` rows, agent snapshot payloads, and the world snapshot. Every consumer (app board, sidebar, tabs, voice digests) reads that field; private derivations are deleted. Precedence: pending permission/proposal or error → needs_you; running → running; unacknowledged user-stop or verdict-done → done; clean finish → ready; else idle (including cleared rows).

- **Clean finish → ready, never needs-you.** A finished run stops latching `attentionReason: "finished"` — the enum value remains only as read-only compat for old records. Finished agents never demand attention; the board, sidebar, and voice digests agree.
- **Proposals resolve terminally.** An approve-failure marks the proposal `failed` (additive status alongside `expired`) — never left `pending`. Expired/failed proposals leave `pendingProposalCount`, so an orphaned proposal cannot hold an agent in Needs-you; a boot sweep resolves pre-cutover orphans.
- **Ready aging**: a daily sweep moves `reviewState: "ready"` rows older than `readyAgeOutDays` (central config, default 3) to done with `verdict: "aged-out"`. The board renders an "Aged out" chip. No agent mutation.
- Ready for review accrues only from rollout onward (finish events after this ships). Existing idle agents become **Dormant**: hidden by default, shown under the "All unarchived" toggle. A dormant agent that runs again enters the lifecycle normally.
- **User-stopped ≠ Needs you**: an agent whose last run has `stoppedBy: "user"` and `reviewState: "none"` lands in **Done** with a distinct "Stopped by you" chip (clearable like any done row) — the user performed the stop, nothing needs them (live bug: user-stopped Hale rendered in Needs-you). **Clear** writes `reviewState: "cleared"` and the row leaves Done (idle / dormant) even if the stop origin is still `"user"`. A new run is what clears the origin. Any other stop (error, crash, machinery) keeps the current attention path → Needs-you. The stop origin must reach the app (additive snapshot field if not already on the wire).
- Done is set by a Verifier verdict or the user. Semantics: bookkeeping only. Agent record untouched (idle, alive, forkable). Card links from pruned/archived agents degrade to the history view.
- **Clear** (per-row and clear-all in the Done section): persisted acknowledgment; removes from Done display. Reopen: any new run or prompt puts the agent back in Running.
- Board default view: last 30 days. Toggle: all unarchived agents regardless of age.
- Retention prunes cards only. Mission Control never archives agents.

Store: `reviewState: "none" | "ready" | "done" | "cleared"` + `doneAt/clearedAt/verdict {by: "verifier"|"user"|"aged-out", summary, at}` per agent, persisted in the mission-control store (same JSONL + snapshot pattern as events).

## Verifier

Ephemeral. One per ready-for-review item, spawned in that item's context. Concurrency cap 3 per host (config). Verifiers are lifecycle-tracked like any worker: their spin-up and completion show on the board, and the dispatcher archives the session after the verdict. Scope setting kept: verify commander-spawned only, or all agents.

- **Commander adoption (scope `"commander"`)** — an agent is auditable when it is Commander-owned, either because the Commander spawned it (`paseo.parent-agent-id` → Commander) or because the Commander **took it over**: a delivered `fleet_send_prompt` marks the target with `paseo.commander-adopted-at` (ISO timestamp of the FIRST adoption — repeated sends never rewrite it, and the marker is a label, so it survives reloads and never collides with parentage). The rule, as the user framed it: _something I started and finished myself gets no verification; if the Commander took over, verification happens._ Adoption is applied at **delivery** (the approvals deliver hook, both Ask and Auto modes) — a denied or undelivered send never adopts — and only for commander-origin sends: stall nudges and verifier→worker contacts never adopt. The boundary is time-based: adoption audits only work that became ready-for-review **after** the take-over timestamp, so an agent the user finished on their own before the Commander ever touched it is never retroactively audited.

- **What earns an audit (scope `"all"`)** — an agent becomes ready-for-review on exactly two signals:
  1. A `report_status` with `status: "completed"` (explicit self-declared completion, any scope), or
  2. A run end for an agent that has a **launch brief** (a non-empty `user_message` timeline row) **AND** at least one `report_status` **this run** — i.e. a dispatched worker that reported progress. Both reuse records the verifier's own context pack already reads (timeline + self-report feed); nothing new is persisted.
     A hand-started conversational session that simply finished a turn is **never** sent to a verifier: it has no launch brief and no self-reported status — nothing to audit against, and an audit would interrupt healthy work to produce a guaranteed "insufficient". A dispatched worker that finished without ever calling `report_status` is also not audited (no evidence; a silent worker already surfaces through the stall/Needs-you path instead). Under scope `"commander"` the ready-for-review marking is unchanged (every finished run), and the scope filter below decides who is verified.
- **Where the setting lives** — fleet-wide Mission Control settings (`evaluationScope`, `mode`, `verifierConcurrency`, …) are stored in `<paseoHome>/mission-control/central-config.json` **on the commander host**, edited over the wire via `mission_control.config.patch`. The `missionControl` section of the daemon's `config.json` is **per-host only** (`enabled`, `hostAlias`, `hostGlyph`) — `evaluationScope` never appears there. (Live misdiagnosis 2026-08-08: "the setting never persisted" was reading `config.json` for a key that lives in `central-config.json`; the wire path had persisted `evaluationScope: "all"` all along.)

- **Tool serving (gotcha — regressed silently once)**: the verifier session's tools (`contact_worker`, `submit_verdict`) are registered in the Paseo host-tool catalog ONLY for verifier-labeled callers (`paseo.mission-control=verifier`). Three hazards made them absent despite the record's 2-entry `toolAllowlist` naming them:
  1. **Create-time label gating** — the catalog is built at launch from `callerLabels` (agent-manager `buildLaunchContext` → `paseoToolCatalogFactory({ callerAgentId, callerLabels })`); a catalog built with only `callerAgentId` falls back to a live-registry lookup that fails pre-registration. The label threading is the fix; never build the verifier's catalog from a bare agent id.
  2. **Commander launch-contract clobber** — `applyCommanderLaunchContract` was once gated on ANY `paseo.mission-control*` label, overlaying the COMMANDER's allowlist/prompt onto verifier sessions and clobbering `[contact_worker, submit_verdict]`. It must be gated on label value `"commander"` exactly.
  3. **Resume/reload drops the launch contract** — `buildConfigOverrides` must carry `systemPromptMode` + `toolAllowlist` (and labels ride the resume options) or a resumed verifier/Commander comes back with the default toolset. Live-verified: a Paseo-spawned verifier on the dev stack calls `contact_worker` and `submit_verdict` successfully end-to-end.
     A verifier must ALWAYS be a Paseo agent spawned by the mission-control verifier dispatcher — never an omp-internal subagent spawned by the Commander (omp subagents never receive the Paseo catalog and show exactly the "Tool contact_worker not found" symptom).
- Spawn context (injected, complete): worker's launch brief, full `report_status` history, attached proofs, user messages tagged to that agent, worker agentId + host. **No transcripts, no timeline tools** — the verifier judges what was asked vs what was evidenced. It never re-does or investigates the work itself.
- **Verifier spawns are gated**: in Ask mode the spawn itself is a proposal card (`kind: "spawn"`, showing host, provider/model, and a brief of what would be audited); approving spawns, denying posts "Verifier spawn denied — needs your review". Auto mode spawns immediately.
- Verdict: done (with one-line summary → verdict card + mark done) or insufficient → contact the worker for proof/clarification. The verdict card carries the verifier's agent id; **clicking a verdict or "Verification failed" card opens the VERIFIER's thread in the Mission Control inspector** (verifiers show their lifecycle on the board until the dispatcher archives them, and stay reachable from their cards), showing the exchange and its pending approval cards.
- **Worker exchange**: verifier tool `contact_worker { message }` → routed through the approval gate → delivered to the worker with a reply marker using the fleet `verifierToWorkerMode` delivery setting (default "interrupt"; "steer" injects without cancelling when the worker is mid-turn on omp). The daemon relays the worker's reply (its next report_status or final turn text) back into the verifier session as a message. **Both directions are gated in Ask mode** — the worker→verifier reply relay is a proposal targeting the verifier itself (delivery cancels a stale hanging verifier turn first). First approval of a verifier↔worker pair can grant **allow-pair** (checkbox on the proposal card): the rest of that exchange auto-approves in both directions.
- Model: omp `modelRoles.verifier` (ship a repo-managed role addition = copy of `task` values). Resolution: `@verifier` → `@task` → host default. Overridable in MC settings.
- Definition: `packages/server/resources/verifier-agent.md` — omp agent definition (instructions: audit proofs against brief, demand missing proofs via contact_worker, never do the work, verdict format). Deployed to `~/.omp/agent/agents/verifier.md` by the existing deploy sync (add to deploy script inventory; document in the file header).

## Approval gate (Ask / Auto)

Every outbound action from mission-control machinery (verifier contacts, status-ask steers, dormant-turn recovery, Commander spawns and sends, verifier spawns, worker→verifier replies) creates a Proposal:

```ts
Proposal = {
  id, createdAt, origin: "verifier" | "commander" | "stall",
  serverId, targetAgentId, message, deliveryMode: "steer" | "interrupt" | "queue",
  reason: string, classification: "normal" | "destructive",
  status: "pending" | "approved" | "denied" | "sent" | "expired" | "undelivered" | "failed",
  kind: "send" | "spawn",          // spawn = create a NEW agent from spawnPlan
  spawnPlan?: { host?, provider, model?, title?, summary, … },  // spawn cards
  spawnedAgentId?, verifierAgentId?, allowPair?,
}
```

- **THE ask-mode rule (user decision, verbatim: "apart from nudge, everything should require my approval in ask mode. Spinning up a new agent as well, everything.")** — in Ask mode EVERY action class waits for Approve/Edit/Deny EXCEPT the status-ask steer. The exemptions are two explicit named predicates in `approvals.ts` — `isForceSendNudge(forceSend)` (status-ask steer) and `isAllowPairExempt(allowPairActive)` (user-granted verifier allow-pair), evaluated separately at the call site — pinned by an enumerated test: the status-ask steer (forceSend, auto-sent) and a user-granted verifier allow-pair are the ONLY auto-sends; everything else — dormant-turn recovery interrupts, Commander `fleet_create_agent` spawns, verifier spawns, verifier→worker contacts, worker→verifier replies, Commander→worker sends (`fleet_send_prompt`) — is pending in Ask mode. Spawn proposals show what would be spawned (host, provider/model, brief summary) so approving is informed.
- **Ask mode (default)**: every proposal is a card in feed + Needs-you bucket with Approve / Edit / Deny. Edit opens the message for tweaking before send. Spawn cards' Edit is not available (approve/deny only).
- **Auto mode**: proposals send immediately and the card records what went out — EXCEPT: `classification: "destructive"` (prompt instructs machinery to classify anything touching prod/deploy/deletion/irreversible ops) → always asks; and presence/stop conflicts (below) → always ask.
- **Presence & user-stop (ask, never block, even in Auto)**: if the target agent has `stoppedBy: "user"` on its last run, or any connected client is viewing it (`focusedAgentId` match with `appVisible`), the proposal downgrades to ask. `focusedAgentId` must be set by BOTH the workspace agent tab AND the Mission Control inspector.
- `stoppedBy: "user"` is recorded when a cancel originates from a client session RPC; machinery-originated cancels record their origin.
- Mode toggle lives in the Mission Control screen header (not settings). RPC-backed, instant.
- User messages always outrank: send to a busy worker delivers per the fleet delivery settings; `fleet_send_prompt` takes `mode: "steer" | "interrupt" | "queue"` and defaults to the central `commanderToWorkerMode` setting (see Delivery modes below).

## Delivery modes (steer / interrupt / queue)

How a send reaches a **busy** agent. Idle agents always just run the prompt; these modes only matter mid-turn.

| Mode        | Semantics                                                                                                                                                                                                                                                     | Used by                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `steer`     | Inject into the live turn without cancelling (native OMP live-steer, `/steer`, instant, non-cancelling). **Non-OMP fallback: interrupt** — a busy provider without a native steer path is interrupted (`replaceRunning: true`) so the message lands promptly. | Additive/non-urgent instructions; status-ask steers (terminal guarantee / `fleet_agent_status` fresh — always native steer, see below) |
| `interrupt` | Cancel the running turn and replace it with the prompt (`replaceRunning: true`).                                                                                                                                                                              | Immediate direction change; dormant-turn recovery; **default** for Commander and Verifier → worker sends                               |
| `queue`     | Wait for idle (bounded, 10 min) before streaming, never cancelling.                                                                                                                                                                                           | Explicitly chosen when the target must not be disturbed and may idle soon                                                              |

- **Non-OMP steer fallback is an interrupt, not queue-until-idle** (bound decision): a steer's value is timely delivery, and queueing behind a possibly-stuck run can sit for tens of minutes. `dispatchLocalPromptMode` reports what actually happened: a steer request delivered via the fallback returns `"steer-interrupt"` (distinct from a native `"steer"` or a requested `"interrupt"`), so callers and logs stay honest.
- **Two central settings, both default `"interrupt"`**: `commanderToWorkerMode` (the Commander's `fleet_send_prompt` default when the tool call omits `mode`; an explicit `mode` from the Commander always wins — it may choose `steer` for additive instructions) and `verifierToWorkerMode` (verifier `contact_worker` and post-verdict proof demands). Both are editable in the MC settings screen, Delivery section.
- **Status-ask steers are NOT affected by these settings** (bound decision): the terminal-guarantee / `fleet_agent_status` fresh steer stays a native `steer`, auto-sent, no approval, in either mode, regardless of `commanderToWorkerMode`/`verifierToWorkerMode`.
- **Composer Default send gains a third mode, "Steer"** (bound decision): the app's send-behavior setting (Settings → General → Default send) is now `Interrupt | Queue | Steer`, with **Interrupt staying the default** — existing users' stored values are untouched. With Steer selected, Enter (or spoken input) while the agent is running delivers via `client.sendAgentMessage(…, { dispatchMode: "steer" })`; the daemon maps that to the same out-of-band `/steer …` path the Commander uses (busy OMP → native live-steer; busy non-OMP or attachments → **interrupt fallback, `replaceRunning: true`** — the same rule as `dispatchLocalPromptMode`; idle agent → plain run). **Command/Ctrl+Enter with Steer selected interrupts** (the escalation from a steer); the settings copy states this. Steer-mode messages are always visible in the chat — they are instructions, not machinery (delivered via the provider's own echo, exactly like the existing `/steer` command).

## Machinery prompts in the agent's own chat (machinery vs instruction)

Bound decision (user): every prompt mission-control machinery delivers into a worker's chat carries an additive classification on its timeline row — `"machinery"` (status asks: the terminal status-ask and `fleet_agent_status` fresh steers) vs `"instruction"` (Commander direction changes, Verifier proof demands, recovery/escalation). The field is optional on the existing `user_message` timeline item (`classification`); **absent = instruction (visible)**, so legacy rows and real user messages are never hidden. The Mission Control feed's `verboseOnly` gating is unchanged and independent.

- **Steers record a row — always.** The native OMP `/steer` runs inside the provider runtime and records NO user row in Paseo's timeline (verified: steers were already invisible in agent chats). `dispatchLocalPromptMode` now appends the prompt as a `user_message` timeline row on a handled steer, with the classification.
- **Instructions must always be visible, no exceptions** (user's words): an `"instruction"` steer (Commander explicitly choosing `mode: "steer"` for additive work, or an approved proposal delivered as steer) renders as a normal user message — the user sees exactly what the agent was told. Interrupt/queue sends already produce visible user rows naturally; the steer path was the gap this closes.
- **Status-ask steers are auditable, never raw**: the status-ask steer (terminal guarantee / `fleet_agent_status` fresh) records a `"machinery"` row (raw text kept on the row for audit) that renders in the agent's chat as a muted one-line placeholder — "Mission Control asked for a status" — **only in Mission Control verbose mode** (the same per-device verbose toggle the MC screen uses, shared via `useMissionControlVerbose`; no second flag). Normal mode renders nothing, matching the pre-change invisibility. The raw steer text is never shown.
- **Machinery rows are the tracker's own prompts, not agent activity**: the stall tracker ignores `"machinery"` rows for the dormant-turn silence clock — a steer must never count as the agent working. `"instruction"` rows count as activity (the agent was told something new).
- Queue/interrupt machinery sends stamp the classification on the provider's echoed user row via a text-keyed expectation (`agentManager.expectPromptClassification`), so every machinery delivery path classifies at the source.

## Commander

- **Single fleet Commander** on the designated commander host (central setting; iammvaibhav-class always-on host). Daemon boot ensures it exists (auto-create with label `paseo.mission-control=commander` if missing and this host is designated). Nothing needed in deploy scripts.
- **Drift auto-recreate**: the Commander record stores a hash of its baked system prompt + tool allowlist at spawn. On daemon boot, hash ≠ current build → archive the stale Commander and spawn fresh (old conversation stays in History). Kills the manual post-deploy archive step (live incident: a pre-v3 Commander lost `fleet_send_prompt`/`send_agent_prompt` after deploy and reported "can't reach Hale").
- **Launch contract survives reloads** (live incident: a Commander resumed with the default coding prompt + unrestricted catalog because its stored record predated contract persistence): `systemPromptMode: "replace"` + the bundled Commander prompt + the tool allowlist are **re-derived from the current build on EVERY session build** — create, reload, resume-from-disk, import — for the commander-labeled agent. The record never needs to carry the contract, so a Commander can never come back unrestricted or with the wrong prompt.
- **Fleet-only tool contract** (user decision): the Commander's allowlist is `fleet_list_agents`, `fleet_create_agent`, `fleet_send_prompt`, `fleet_get_agent_activity`, `fleet_search`, `tag_message` — no host-specific tools (`create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, `list_agents`, `create_workspace`, `list_workspaces`, `history_search` dropped: each capability has a fleet\_\* equivalent or is covered by `fleet_create_agent` placement / `fleet_search` / `fleet_list_agents`). The Commander can never act on only its own host by accident, and with no builtin names in the allowlist the omp provider launches `--no-tools`, dropping omp's `task` subagent tool entirely. The allowlist feeds the drift hash, so a trim changes the hash and triggers boot recreate — intended.
- **Reset Commander**: `mission_control.commander.reset.request/response` — archive current + spawn fresh with a new context pack. Exposed in the thread overflow menu.
- Fast model (routing over injected context needs no deep reasoning): default = host default omp model; central setting can override. **Runtime settings stick**: a user change to the Commander's model/thinking in the composer persists into the stored agent config; machinery dispatches (machinery turns, approval delivery) must never re-pass creation-time settings (live bug: every digest run reset thinking to `low` via `--thinking <stored initial>`).
- **Prompt layering (cache-preserving)**:
  1. System prompt = static only: identity, playbook, safety, tool contract. Lives in repo markdown: `packages/server/src/server/mission-control/commander-prompt.md` (bundled at build; user instructions from settings appended). The orchestrator reminder moves here — never again in message bodies. **Byte-stable across turns** so the prompt cache holds.
  2. The **world snapshot** rides the conversation as its own machinery message, regenerated at delivery and stamped with its generation time (`# Fleet state as of <ISO>`): fleet map + per-host aliases, projects + descriptions, workspaces, roster (one line per agent active in the last 24h: name, title, status bucket, last report headline, age; cap 30), and **per-host invocable provider/model strings** — the exact `provider/model` values `create_agent`/`fleet_create_agent` accept, listed verbatim so the Commander never guesses provider strings (transcript failure: five rejected guesses).
     - **The Models block contains ONLY invocable notation.** omp `modelRoles` render translated into the same form as the model list — `- role "task" → omp/opencode-zen/deepseek-v4-flash-free (effort: high)` — with the `:effort` suffix split out and the owning provider prefixed. The bare internal `provider/model:effort` value is NEVER emitted in a block whose other lines are invocable (live incident: the Commander passed a role value verbatim as `provider` and looped on rejections all turn). One line states the listed strings are exactly what `create_agent`/`fleet_create_agent` accept.
     - **Roles cross-checked against the snapshot**: a role whose model is absent from that host's provider snapshot renders `(not available on this host)` instead of usable (live: the `task`/`default` role referenced a model the host did not have).
     - **`default worker model:` per host**: the omp `task` role in invocable form, so the Commander spawns with a valid string when the user names no model. When the task role's model is missing from the snapshot, the line falls back to the first available model and says so.
     - **Spawn rejections are actionable**: a rejected provider string from `create_agent`/`fleet_create_agent` (schema-validation OR "not configured") returns the host, the rejected value, and capped valid invocable strings for that host (nearest matches + a count), so a single corrected retry is possible from the error text alone. Retry on the SAME host — never silently retarget (see playbook).
  3. **Per-turn injection** (M3): the snapshot is re-injected before EVERY delivered message — user turn or machinery turn — as its own `<paseo-system>` row, and the previous snapshot row is retracted in place (supersede-in-place) so the thread never accretes fleet state. The launch first message is the first snapshot; the injector (CommanderSnapshotInjector, wired into startAgentRun via the AgentManager beforeAgentRun seam) owns dispatch + retraction. Never deltas, never append-only context updates.
- **No digest queue.** The Commander's context never receives "this started, this stopped" event streams — the feed keeps the events, the snapshot is the integrated result. `COMPAT(digest)`: the digest module, its idle-flush, the context delta provider, and the shared ack-drop arming for delivered turns were removed in M3; nothing in the protocol or config carried them, so nothing wire-visible was left behind except log-line names and doc references.
- Exactly ONE `<paseo-system>` envelope per machinery message (snapshot row, machinery turn) — a live bug double-wrapped `<paseo-system> <paseo-system>` in the digest era; the injector wraps the snapshot body once at dispatch.
- **User → Commander delivery is interrupt** (replaceRunning), not steer — your message takes over immediately. The interrupt mechanics (cancel notices, resumed tool calls) are machinery noise hidden in normal mode (see App: verbose mode). Commander → workers uses `commanderToWorkerMode` (default "interrupt"); the Commander may pass an explicit `mode: "steer"` to `fleet_send_prompt` for additive, non-urgent instructions.
- **User-message tagging**: Commander records `relatedAgentIds` for each user message it handles (tool: `tag_message` or structured field in its reply pipeline — implementer's choice, must persist in store). Tagged messages feed verifier spawns. Fleet-wide remarks tag all active.
- `fleet_get_agent_activity { agentId, limit?, host? }`: new tool, same shape as local `get_agent_activity`, proxied over peering with the bare agentId resolved through the fleet id index — kills "can't read its timeline from here".
- Ack suppression (machinery turns): snapshot rows and machinery turns instruct — no prose when nothing needs action. Server drops pure-ack replies (single-token/`ok` heuristic) from the visible thread; log them. Retraction now fires on the machinery turns the daemon itself initiates: the per-turn snapshot's own ack (CommanderSnapshotInjector's composed CommanderAckDrop) and the launch first turn (`armLaunchTurn`). `COMPAT(digest)`: the approvals-delivery ack arming is gone — a delivered proposal's reply (a decision) is never classified.
- **Stop button**: Mission Control header exposes Stop (cancels the Commander's active turn via the existing cancel RPC). Typing "stop" must never be the only way.

## Fleet search (`fleet_search`)

The Commander must resolve "who worked on X?" without spelunking. One tool, tiered inside the daemon, cross-host via peering, results merged:

```ts
fleet_search { query: string, limit?: number, deep?: boolean }
→ { matches: [{ host, agentId, name, title, status, matchedIn: "identity"|"brief"|"reports"|"transcript", snippet }] }
```

1. **Tier 1 — deterministic context** (always): substring + fuzzy over what the daemon already holds — agent names, titles, descriptions, launch briefs, report_status history, workspace/project names + descriptions. Instant.
2. **Tier 2 — full-text transcript scan** (when tier 1 is thin): bounded scan over stored agent timelines (last 30 days, newest first, capped work per host). This is where a PR URL pasted into a prompt gets found.
3. **Tier 3 — History Ask** (only when `deep: true`): falls back to the existing History Ask LLM machinery and returns its structured matches. The Commander asks for `deep` explicitly when tiers 1-2 fail.

Playbook: `fleet_search` is THE lookup path; `history_search` (metadata-only) remains for title-ish queries. `fleet_list_agents` is for rosters, not searching.

`fleet_list_agents` enrichment: each row gains name, title, short description, and the last few report_status headlines (cap 5, oldest→newest so trajectory reads naturally), plus optional last user message per agent. Payload stays bounded (roster caps per current behavior).

## Watchdogs + the terminal-state guarantee

The only automatic status-ask is the **terminal-state guarantee** (spec 06): when a run ends with a terminal transition — finished, failed, or machinery interrupt (never user-stop) — and the agent produced ZERO self-sourced `report_status` calls this run, the daemon sends exactly ONE status-ask steer per finish chain: never repeated, never time-based. If the steer's own run still produces nothing, the record gets a deterministic description fallback (first line of the last assistant message, flagged auto-derived) instead of a second steer. Blocked-on-permission is never nudged (the turn is suspended, not over).

The status-ask steer is machinery, not user-facing: auto-sent in either mode (`forceSend` — the only auto-send beside allow-pair), wrapped in a `<paseo-system>` envelope the timeline renderers hide, the card renders in verbose mode only, and the timeline row classifies `"machinery"` (muted placeholder in verbose; nothing in normal mode). The agent's own `report_status` tool call stays visible. `fleet_agent_status { fresh: true }` is the only mid-run status-ask and fires only on explicit request (waits ≤60s for the report, else returns the stale data with `fresh: false`).

**No wall-clock nudges.** The silence (120s) and cadence (300s) status-ask steers and the escalation path that hung off an unanswered nudge are deleted (spec 06). A silent agent is never periodically asked for a status; a 20-minute-quiet run produces zero steers. What remains is failure recovery, not status:

- **Eligibility — Running only.** Dormant-turn recovery applies solely to agents with a run in progress. Ready-for-review (self-declared complete), Done, user-stopped, and failed agents are never recovered (failed already surfaces in Needs-you; user-stopped is Done). Stall-tracked classes are root agents and Commander workers only: the Commander, verifiers, plain subagents, and internal agents are excluded — verifiers and subagents have legitimate silence (a verifier reads a worker timeline; a subagent answers to its parent), so MC never wedge-recovers them. The Commander keeps only the narrow tool-loop watchdog below.
- **Commander tool-loop watchdog** (the reason a looping Commander was invisible): the Commander is excluded from the stall machinery by design, so N consecutive FAILED calls of the SAME tool within one turn — provider validation/not-configured class errors only ("provider must be provider/model…", "… is not configured") — emit **exactly one Needs-you card** naming the tool and the last error (N = 3). The streak is per-turn (a turn boundary or a successful call of the same tool resets it), and each looping turn gets at most one card. **Card only: the Commander is never recovered or interrupted**, and worker stall behavior is untouched.
- **Reconciliation watchdog**: record `running` but provider runtime dead/exited >2min → self-heal record to error state, emit stalled event, log loudly. (Root-cause of the freeze itself is tracked separately by the user — do not chase it here.)
- **Dormant-turn detector (the hard stop)** (`dormantTurnSeconds`, default 300): a RUNNING agent with NO timeline output AND NO unmatched in-flight tool call for the threshold has a wedged turn — recover by force-cancelling the turn and starting a fresh run via an interrupt-and-send recovery proposal (approval-gated identically; stalled event + loud log regardless). The distinguishing "working" signal is a declared tool call: an unmatched running `tool_call` timeline row (the server-side mirror of omp's `tool_execution_start`/`tool_execution_end`) — an agent inside a 30-minute `hub wait` is WORKING and is never flagged; only "no tool in flight" + "no output" is dormancy. A pending permission is in-flight too (blocked on the user, not wedged). In-flight state is tracked per agent in the mission-control stream handler (`inFlightToolsByAgent`: `tool_call` running adds the callId, completed/failed/canceled removes it, a turn boundary or run end clears the set). One recovery per lapse, shared with the recovery latch, so a wedged loop never stacks recovery cards. **Why this is NOT redundant with the liveness watchdog — the 2026-08-08 incident (agent `3a71c7bb`):** the agent wedged for 26 minutes (10:25:08–10:51:14 UTC) with an unprocessed user message and NOTHING in flight — no model request, no tool call. The aborted-turn evidence row has zero tokens, zero cost, and NO duration/ttft fields, so no inference was ever issued (a hung HTTP request would still record a duration). Upstream root cause (omp, pi-coding-agent): omp's stranded-queue drain (`#drainStrandedQueuedMessages`, agent-session.ts:705) exists for exactly this case but is only reachable on SETTLEMENT — three call sites, no timer or periodic sweep — and a steer that aborts an interruptible tool strands the message while the run is still in flight (`isStreaming` true, `promptInFlightCount > 0`), so no drain path is reachable and the loop parks forever; only an external abort recovers it. The bug is structurally invisible to omp (no hook fires while `isStreaming` stays true) and unrecoverable from inside it — an external observer with the power to cancel is the only possible fix. The provider PROCESS stayed alive and productive the whole time (an in-process sibling agent produced 280 timeline rows in the same window), so the reconciliation watchdog — which keys on process/runtime liveness — cannot ever catch this class of bug; the freeze is PER-AGENT, keyed on the specific agent's own timeline, never host/process liveness. The wait was on a sibling that FINISHED at 10:45:23, and the loop still did not advance — a dormant turn does not self-heal even when the thing it waited for completes. Three nudges injected during the window were recorded "Proposal sent" by the daemon but never reached the session, because omp was dormant and nothing was stepping to consume them.
- **Honest steer delivery (delivery verification)**: `tryRunOutOfBand` returning handled does NOT by itself count as delivered — the incident's three vanished nudges prove a wedged loop can accept a steer and silently drop it while Paseo records "sent". After an out-of-band steer reports handled, the daemon arms a 90s verification window (healthy status-ask→response latency is 5–90s; the wedged agent's pathological tail starts at 173s): any real timeline activity clears it; silence flips the proposal to a terminal **`undelivered`** status (never left "sent"), emits a stalled event, and escalates through the same recovery interrupt.
- **Abrupt kills (daemon restart, provider crash)**: boot reconciliation + the watchdog mark such runs **interrupted** (stop origin `system` — distinct from user-stopped AND from a run that failed on its own error). Interrupted agents land in Needs-you with an "Interrupted" chip and immediately qualify for the recovery proposal (interrupt-and-send "Continue whatever you were working on…") — Ask: card; Auto: sends. After a daemon restart the Commander is boot-ensured, the store is persisted, and healed agents' recovery proposals flow through the same gate: the fleet resumes itself.
- **Boot adoption of surviving runs** (live gap): the stall tracker arms on a `lifecycle → running` transition, so a run that PREDATES the daemon process is invisible to it forever — no dormant-turn coverage, no heal. Boot must scan records with `lastStatus: running` and, when the runtime is **alive**, ADOPT them into tracking (seed from `lastActivityAt` so the dormant-turn clock and dead-runtime heal start from the run's real last activity); when the runtime is **dead**, heal as above. Verified failure: agent `3a71c7bb` ran continuously across a deploy restart and produced zero stall lines under the new pid.
- **Dormant row timestamps** come from the agent's real last activity, never from the rollout marker or daemon boot time (live: every Dormant row showed the same relative time).
- Knobs: `dormantTurnSeconds` and the `stallDetectionEnabled` master switch are what remain; `silenceNudgeSeconds`, `statusNudgeSeconds`, and `escalateSeconds` stay as legacy config keys nothing consumes. The dormant-turn knob's help text documents the floor: healthy agents respond in 5–90s, and the slowest legitimate model call observed in 8242 samples was 178.6s (one 727k-token call took 48s TTFT + 54s duration) — Paseo cannot observe a model request in flight (that state lives inside omp and produces no timeline rows), so values under ~4 min risk false positives.

## Protocol

Per docs/rpc-namespacing.md and docs/protocol-compatibility.md. Additive only; wire schemas pure; regenerate zod-aot validators.

- `mission_control.lifecycle.set.request/response` — mark done / clear / reopen `{ serverId, agentId, action }`.
- `mission_control.proposals.respond.request/response` — approve/deny/edit `{ proposalId, action, editedMessage?, allowPair? }`.
- `mission_control.mode.set.request/response` — ask/auto.
- `mission_control.instructions.open.request/response` — the voice instruction ledger: open `{ text }` row(s) per utterance (`source: "voice"`) → `{ instructions: [{ id, text }] }`; `respondsTo` on cards closes them (see commander-voice.md).
- `mission_control.config.get/patch.request/response` — central settings (stored on commander host).
- `mission_control.commander.reset.request/response` — archive current Commander, spawn fresh with a new context pack.
- `mission_control.events.fetch` — gains cursor paging (`beforeSeq`, `limit`).
- `mission_control.search.request/response` — `{ query, limit?, deep? }` → `{ matches }`; the full tiered search runs inside the owning daemon; the commander host merges local + peer results (mirrors `fleet_list_agents`).
- `mission_control.spawn_labels.resolve.request/response` — `{ cwd?, workspaceId? }` → `{ labels? }`; the Commander host asks a peer to resolve the human-readable workspace/project labels for a spawn proposal card from the peer's own registries and checkout facts (a new-workspace spawn at a bare cwd would otherwise render unnamed). Read-only; same labels shape as `spawnPlan.labels`. Mirrors `mission_control.meta.apply`'s peer hop.
- Push: proposals and lifecycle changes ride the existing `mission_control_event` push as new event kinds: `proposal`, `verdict`, plus `source: "verifier"`.
- Feature flag: `server_info.features.missionControlV3: true`. App gates once.

## Config

Per host (`config.json` → daemon):

- `missionControl.enabled`
- `missionControl.hostAlias` — THIS machine's alias ("work server"). Fleet map assembles aliases from each host's own declaration. No hardcoded machine lists anywhere.

Central (stored on commander host, edited from anywhere via `mission_control.config.*`):

- `commanderHost`, `commanderModel?`, `commanderInstructions`. `commanderHost` matches a daemon's serverId, OS hostname, or `missionControl.hostAlias`. Daemons sharing one machine share an OS hostname, so a hostname value makes ALL of them claim designation (each applies config patches locally instead of forwarding) — co-located daemons must be designated by alias or serverId.
- `verifierModel?`, `verifierConcurrency` (default 3), `evaluationScope: "commander" | "all"`
- `mode: "ask" | "auto"` (default ask), `retentionDays` (default 30), `readyAgeOutDays` (default 3 — ready rows age to done; see Lifecycle)
- `namingTheme`, `hideAgentNames` (default false), `defaultDispatchHost`
- `commanderToWorkerMode` (default `"interrupt"`), `verifierToWorkerMode` (default `"interrupt"`) — `"steer" | "interrupt" | "queue"` delivery for commander/verifier → worker sends (see Delivery modes)
- `stallDetectionEnabled` — master switch for the remaining stall machinery (dormant-turn recovery, dead-runtime watchdog). `silenceNudgeSeconds`, `statusNudgeSeconds`, and `escalateSeconds` remain as legacy keys — the wall-clock status nudges and their escalation are deleted; nothing consumes them.
- `dormantTurnSeconds` (default 300) — dormant-turn detector: seconds a running agent may sit with no output AND no tool in flight before the turn is treated as wedged and recovered (see Watchdogs)

## App

- **Screen**: `[left sidebar (existing collapse)] [Commander thread (collapsible to thin strip)] [Inspector] [board rail (drag-resizable)]`.
  - Board row click AND full feed-card click (entire card is pressable, not just the name) → agent opens in Inspector in place. Repeated clicks swap content. No navigation, no tabs.
  - Inspector = embedded `AgentStreamView` **with composer** (reply in place). Header: agent name/title, host glyph, "Open in workspace →" (the only thing that navigates). Inspector reports `focusedAgentId` via the existing heartbeat. **Inspector width is drag-resizable** (same handle pattern as the board rail), persisted.
  - Compact form factor: Inspector becomes a full-screen push with back; no split.
- **Board**: running sorted by name (stable); needs-you / ready / done / dormant by time desc (dormant orders by the agent's real last activity — newest event, else last user message — never the shared boot/rollout timestamp). Rows: title is the key line, name is the identity chip, one-line last-report. Host shown as a small glyph avatar: deterministic accent color from serverId + host alias initial (or per-host override in host settings: custom 1–2 char initials/emoji + color), tooltip = full name — design-token native.
- **Board row context menu**: right-click (web) / long-press (native) via the menu engine (docs/menus.md): Open in workspace; **Copy reference** (copies `Name — Title — agentId` to the clipboard for pasting into chat); Stop (running rows); Mark done / Clear (bucket-dependent); Archive (non-running rows only — Running shows Stop instead). No kebab.
- **Hover identity card**: hovering a board row (or an agent chip in the thread) shows full title + short description; long-press on native.
- **Badges**: sidebar Mission Control row shows small colored count chips using the same status tokens as the board buckets — needs-you (attention color) and ready-for-review (success color); each renders only when non-zero. No bare uncolored number.
- **Sidebar host glyph (app-wide)**: the left sidebar replaces the host status dot with the SAME glyph chip used on board rows — one identity everywhere. Connection status moves onto the glyph (e.g. dimmed/ring when offline) so no information is lost. Initials + color are user-overridable per host (host settings), defaulting to alias initial + deterministic color.
- **Thread**: cursor paging on scroll-up (no more hardcoded 200-and-done), windowed unloading.
- **Gutter**: the visual left edge of message text and the composer box must match the regular agent chat exactly (agent chat is the reference; padding tokens already match — fix the card-internal indents). Acceptance = side-by-side screenshot against a workspace agent chat.
- **Composer drafts**: MC thread composer and Inspector composer persist drafts via the existing draft store (`useAgentInputDraft`), keyed by commander/inspected agent — text survives navigation, like every workspace tab (live bug: both use raw `useState`).
- **Tool rendering**: per-tool renderers hooked into the existing presentation registry: `fleet_send_prompt` → "→ Steered **Name** (host)" header + collapsed markdown body; `fleet_list_agents` → one-line "Checked fleet roster · N agents", expandable; `create_agent`/`fleet_create_agent` → "Spawned **Name** on host". No raw JSON dumps for known tools.
- **Native chips**: `paseo://` agent links in Commander prose render as inline agent chips (same component as feed cards), not text links.
- **Proposal cards**: Approve / Edit / Deny (+ allow-pair checkbox for verifier exchanges). Pending proposals also surface in Needs-you.
- **Verbose mode = the debug gate** (per-device UI toggle in the MC header overflow, default OFF): normal mode shows your conversation, status/verdict/proposal cards, and pretty-rendered dispatch actions ONLY — Commander tool-call internals, thinking, inbound `<paseo-system>` machinery messages, and interrupt mechanics are hidden. Verbose shows everything, and not just in the thread: system-owned artifacts (the Commander's workspace and agent, verifiers) appear in the sidebar, history, project lists, and board only while verbose is on. One `isSystemOwned` predicate backs all of it (roadmap M2).
- **Thread classification (chat carries decisions)**: normal mode skips `started | finished | milestone | finding | interrupted | diverged | stalled | failed` and state-only verdict cards — they are board/feed-rail only. Proposals, clarifications, answers, and blocked cards stay. Verbose renders every event. (`thread-classification.ts`)
- **Card consistency**: every status update renders as the same uniform visible card — started, finished, failed, milestone, verdict. Nothing status-like is ever collapsed behind a divider. Collapsed-by-default is reserved for proofs and pretty-rendered tool bodies.
- **Started-card enrichment is snapshot-based**: when the agent's first `report_status` lands a title/description, the enrichment is recorded onto the event (a new snapshot write) — never read live at render time; the live-read version of this idea was the original staleness bug. A started card should never read as a bare "agent started" once anything better is known.
- **Keep Mission Control mounted**: navigating away and back must not remount/refetch/re-scroll. The screen stays alive (route kept in memory per docs/expo-router.md constraints — freeze, don't unmount). **Scroll preservation reuses the regular agent chat's mechanism** (AgentStreamView's anchoring), not a bespoke restore pass — zero visible motion on return (live bug: a ~1s up-then-down restore animation). Snappy is the acceptance bar: return to MC is instant and visually still.
- **Stop button** in the header (see Commander section). MC header contains ONLY: Ask/Auto toggle, Stop, overflow menu (verbose mode, Clear view, Reset Commander). **No Commander-host dropdown in the header** — host selection lives in central settings (live drift: a header `SelectField` picker exists; remove it).
- **Clear view**: overflow action sets a per-device clear-point — the thread renders from that moment; older cards stay in the store behind a "show earlier" affordance. Does not touch the Commander. (Reset Commander — the real context clear — is the RPC in the Commander section.)
- **Names**: daemon-held naming map; names are write-once — a theme switch affects newly created agents only and never re-maps existing names (decision reversed 2026-08-08: names identify agents in transcripts and memory, so renaming breaks every past reference); `hideAgentNames` toggle hides chips leaving titles.
- **Agent tab tooltips** (workspace tabs, not just MC): hover shows "Name — Title" when names are enabled, title only when `hideAgentNames` is set.
- **Settings**: new central Mission Control settings screen (fleet policy; NOT inside any host's overview). Host overview keeps only alias + enabled — the alias field copy is "Alias for this machine". **Commander model and Verifier model use the app's `CombinedModelSelector`**, never free-text; Verifier model is labeled as an override (empty = omp `modelRoles.verifier` → `task` role). Ask/Auto toggle is in the MC header, mirrored read-only in settings. A **Delivery** section surfaces `commanderToWorkerMode` and `verifierToWorkerMode` with hints on when steer (additive/non-urgent) vs interrupt (immediate direction change) fits.
- **Proofs**: feed cards and thread render proof sections collapsed by default ("Image proof", "API proof", ...). Image → existing image pipeline; video → new renderer (expo-video native, `<video>` web); api/code → code blocks from excerpt; pr/url → chip. Cross-host media: authenticated daemon file-fetch RPC proxied over peering, size-capped, pruned with retention.
- **Project descriptions**: `description` field on project records + edit sheet textarea; injected into Commander context pack for routing.
- **Thinking expansion (regression fix)**: thought items in ALL agent chats must expand on press. Two live bugs from the render slice: thought items compute `canOpenDetails: false` when the empty-detail heuristic swallows their text, and `"thinking"` was routed to `FleetToolCallDetailBody` which returns `null`. Fix both; add a regression test.

## Naming backfill (one-time, via omp scout — no in-daemon provider calls)

- One bulk omp one-shot per host (default model `@smol`), metadata-driven — never transcripts. Prompt input per agent: current name/title/description **+ first user prompt excerpt (~200 chars) + last report_status headline** — titles derive from what was actually asked, not from the bad title being replaced. Descriptions generated here are capped at 400 chars (`DESCRIPTION_MAX_CHARS`, matching the report_status description rule).
- **Agent titles are replaced, not just filled**: recompute the deterministic derived title from the first prompt (`create-agent-title.ts`); current title matches the derivation → auto-generated → replaceable. Anything else = user-set → untouched. Descriptions/names still fill-if-missing.
- Workspaces: generate old→new rename proposals (max 5 words, descriptive) ONLY for titles equal to derived defaults (branch/dir slugs). **Workspace title proposals get the workspace's agents (titles + descriptions) as context** so the name reflects what's actually worked on there. Present as a proposal card for one-shot user approval; never auto-apply. Set-once going forward: workspace names never auto-change after creation; agents name workspaces they create; titles are frozen after the backfill.
- **Deliverable = markdown report per host** (`--report <path>.md`): old→new tables for agent identity and workspace renames. The user annotates/approves the report; `--apply` consumes only the approved file.

## Logging

Every background mechanism logs structured lines under `module: "mission-control"` with `component`: `snapshot` (snapshot injected/superseded/ack-drop), `machinery` (machinery-turn dispatch + ack-drop — the ack-drop component was renamed from `digest` in M3), `verifier` (spawn, exchange, verdict), `approvals` (proposal created/resolved/sent/expired/undelivered/failed), `stall` (status-ask steer, watchdog-heal), `dormant-turn` (hard-stop recovery), `steer-verify` (delivery verification), `turn-lifecycle` (turn-step transitions with ages), `context` (snapshot built, size), `naming` (assign, backfill). `grep mission-control ~/.paseo/daemon.log` must tell the whole story.

**Turn-step lifecycle retention**: turn-step transitions (run started, request issued, tool started, tool result, turn ended — with ages) log under component `turn-lifecycle` AND mirror to a dedicated retained file `~/.paseo/mission-control-lifecycle.jsonl` — the single-file daemon.log had already rotated past a 30-minute-old incident window (2026-08-08: the wedge was undiagnosable from logs). Retention policy (bounded): the file rotates at 10 MB by renaming to `<name>.1` (overwriting the previous backup), so retained history is capped at ~20 MB — ~25k current + 25k rotated lines at ~400 bytes/line, hours-to-days of history, comfortably past the diagnostic window. Tool rows are `debug` in daemon.log (high volume) but always present in the retained file; run/turn transitions and detector fires are `info`/`error` in both.

## Edge cases (bound decisions)

- Only the Commander itself and non-verifier machinery (monitors, build-hash stamps) are hidden from board buckets, badge counts, and feed self-loops. Verifiers, Commander workers, and subagents are lifecycle-tracked (gated by the `track*` settings; all default on). Board rows never show a "Stopped by you" chip from the live directory stoppedBy — only from a terminal event snapshot, except for event-less agents (no events at all), where the live stop origin is the only record of a user stop.
- Verifier crash/timeout → item stays ready-for-review, retry once, then Needs-you card.
- Proposal expiry: 24h → `expired`, card dims.
- Worker archived while proposal pending → proposal expires.
- Host offline: board shows "host offline" row; queued sends deliver on reconnect (existing peer queue semantics).
- Ack-drop heuristic must never drop a reply containing a question, proposal, or any tool call.
- 10 agents finishing at once: no machinery turns (finished is not needs-you), verifiers capped at 3, no interrupts of the Commander mid-turn. Blocked/stalled events never dispatch a machinery turn unless a decision card attaches (they surface on the board, in badges, and via monitor announce); a verdict that needs routing dispatches one machinery turn — the snapshot rides each delivery, computed at delivery, so nothing queued rots.

## Verification checklist (dev stack; NEVER restart the production daemon on 6767)

1. Worker self-reports via report_status → instant feed card; completed → ready-for-review; verifier spawns, audits, marks done (or demands proof; exchange relay works; allow-pair works).
2. Ask mode: the terminal status-ask auto-sends as a verbose-only machinery card; verifier contacts and dormant-turn recovery produce proposal cards; Approve sends (delivered per the proposal's `deliveryMode` — steer/interrupt/queue); Edit modifies; Deny kills. Auto mode: sends immediately; destructive classification still asks; viewing the target in Inspector forces ask.
3. Board: stable order while multiple agents stream; buckets correct; dormant hidden until toggle; Done + Clear semantics; badges.
4. Inspector: card/row click opens in place, composer replies, focusedAgentId reported, Open-in-workspace navigates.
5. Commander: boot-ensured, static system prompt (no reminder in messages), world snapshot as first message, per-turn snapshot injection (each user message preceded by exactly one current snapshot; the earlier snapshot row retracted), no digest messages, ack turns suppressed, fleet_get_agent_activity works cross-host on dev (single host: local fallback path).
6. Thread: scroll-up pages older events; composer aligned.
7. Tool calls render pretty; agent links render as chips.
8. Proofs: image + code + api render collapsed/expandable; video renders (sample file); cross-host fetch path exercised (dev: same-host).
9. Watchdog: kill a worker's provider process → record self-heals + stalled event.
10. Typecheck, lint, format, build:client, build:server all green.
11. v3.1: Commander thinking survives a machinery turn; no `ok` rows in the thread after snapshot injections; stale Commander auto-recreated on boot after a prompt change; drafts survive navigation; thinking cards expand in a normal workspace chat; inspector resizes; board row right-click menu works; backfill dry-run emits the md report. (The original "theme switch re-names instantly" acceptance is void — names are write-once now.)
