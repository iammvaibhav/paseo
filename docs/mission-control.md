# Mission Control

Fleet monitoring and dispatch. One screen: a deterministic **board** of every agent on every host, a **feed** of self-reported status cards, a **Commander** agent you chat with that routes work, and ephemeral **Verifier** agents that audit finished work by its evidence. This doc is the implementation spec and the arbiter when two slices disagree.

No LLM gateway anywhere in this feature. Everything is omp. Agents report their own status via a tool; nothing reads transcripts to guess.

## Vocabulary (glossary-bound)

| Term             | Meaning                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Board            | Right rail: every agent, every host, grouped by bucket. Plain data, no AI, cannot die.                                                 |
| Feed             | Status cards interleaved with your Commander conversation in one thread.                                                               |
| Commander        | The single durable fleet agent you chat with. Fast model. Routes, dispatches, steers. Never implements, never verifies.                |
| Verifier         | Ephemeral omp agent spawned per ready-for-review item. Audits proofs against the brief. Marks done. Dies.                              |
| Inspector        | Embedded agent view inside Mission Control (right half). Clicking a board row or feed card opens the agent here, never navigates away. |
| Ask mode         | Every outbound action (steer, nudge, proof demand) becomes a proposal card requiring Approve/Edit/Deny. Default.                       |
| Auto mode        | Proposals send immediately; card logs what went out. Destructive actions and user-presence conflicts still ask.                        |
| Ready for review | Agent finished a run (or self-reported completed) and awaits a verifier/user verdict.                                                  |
| Done             | Reviewed and confirmed complete. Bookkeeping only — never archives the agent.                                                          |
| Dormant          | Pre-rollout or long-idle agents. Hidden by default; visible via the "All unarchived" toggle.                                           |
| report_status    | The MCP tool every agent gets: self-reported status, title, description, milestones, proofs.                                           |

## Architecture

```
worker agents --report_status tool--> event store --instant push--> app (board + feed)
                                        |                |
                                        |                +--> digest queue --idle flush--> Commander
                                        |
                                        +--ready-for-review--> verifier dispatcher --spawn--> Verifier (ephemeral)
                                                                       |
stall detector --silent too long--> steer status-ask (via approval gate)
watchdog --dead session, running record--> self-heal + stalled event

ALL outbound sends (Commander steers, Verifier contacts, stall nudges) --> approval gate --> proposal card --> send
```

The board and feed never wait on any LLM. Events hit the store and push to clients instantly. The digest queue only gates when the Commander's model reads them.

## Status reporting (`report_status`)

Replaces `report_milestone` (clean cutover: tool renamed, schema extended, prompt injection updated; delete the old name everywhere).

```ts
ReportStatusInput = {
  status: "working" | "completed" | "inconclusive" | "blocked",
  headline: string,        // <=120 chars, plain language
  detail?: string,         // 1-2 sentences
  kind?: "finding" | "fix" | "milestone" | "decision" | "progress",
  title?: string,          // ONLY when the agent decides its title changed (it receives the old one)
  description?: string,    // living short description, same rule
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
- `completed` means conclusively done — everything asked, finished. Any doubt, cut short, still in discussion: report `inconclusive`, never `completed`.
- Claims of completion should carry proofs. The worker owns proving; verifiers will demand proof otherwise.
- Prefer hub-wait over `sleep`/timeout polling loops (also added to Commander playbook and worker brief templates).

`status: "completed"` (or a finished run) moves the agent to ready-for-review. `title`/`description` updates flow through the identity path (board, tabs, everywhere — same names everywhere, no diffs).

## Lifecycle

Buckets: **Needs you** (blocked / failed / awaiting input / pending proposals) → **Running** → **Ready for review** → **Done**.

- Ready for review accrues only from rollout onward (finish events after this ships). Existing idle agents become **Dormant**: hidden by default, shown under the "All unarchived" toggle. A dormant agent that runs again enters the lifecycle normally.
- **User-stopped ≠ Needs you**: an agent whose last run has `stoppedBy: "user"` lands in **Done** with a distinct "Stopped by you" chip (clearable like any done row) — the user performed the stop, nothing needs them (live bug: user-stopped Hale rendered in Needs-you). Any other stop (error, crash, machinery) keeps the current attention path → Needs-you. The stop origin must reach the app (additive snapshot field if not already on the wire).
- Done is set by a Verifier verdict or the user. Semantics: bookkeeping only. Agent record untouched (idle, alive, forkable). Card links from pruned/archived agents degrade to the history view.
- **Clear** (per-row and clear-all in the Done section): persisted acknowledgment; removes from Done display. Reopen: any new run or prompt puts the agent back in Running.
- Board default view: last 30 days. Toggle: all unarchived agents regardless of age.
- Retention prunes cards only. Mission Control never archives agents.

Store: `reviewState: "none" | "ready" | "done" | "cleared"` + `doneAt/clearedAt/verdict {by: "verifier"|"user", summary, at}` per agent, persisted in the mission-control store (same JSONL + snapshot pattern as events).

## Verifier

Ephemeral. One per ready-for-review item, spawned in that item's context. Concurrency cap 3 per host (config). Hidden from board buckets and workspace activity badges (same exclusion mechanism as History Ask agents). Scope setting kept: verify commander-spawned only, or all agents.

- Spawn context (injected, complete): worker's launch brief, full `report_status` history, attached proofs, user messages tagged to that agent, worker agentId + host. **No transcripts, no timeline tools** — the verifier judges what was asked vs what was evidenced. It never re-does or investigates the work itself.
- Verdict: done (with one-line summary → verdict card + mark done) or insufficient → contact the worker for proof/clarification.
- **Worker exchange**: verifier tool `contact_worker { message }` → routed through the approval gate → delivered as steer to the worker with a reply marker. The daemon relays the worker's reply (its next report_status or final turn text) back into the verifier session as a message. Both directions are gated in Ask mode. First approval of a verifier↔worker pair can grant **allow-pair** (checkbox on the proposal card): the rest of that exchange auto-approves.
- Model: omp `modelRoles.verifier` (ship a repo-managed role addition = copy of `task` values). Resolution: `@verifier` → `@task` → host default. Overridable in MC settings.
- Definition: `packages/server/resources/verifier-agent.md` — omp agent definition (instructions: audit proofs against brief, demand missing proofs via contact_worker, never do the work, verdict format). Deployed to `~/.omp/agent/agents/verifier.md` by the existing deploy sync (add to deploy script inventory; document in the file header).

## Approval gate (Ask / Auto)

Every outbound send from mission-control machinery (Commander steer via its tools stays as-is — this gates _autonomous_ machinery: verifier contacts, stall nudges, commander digest-initiated steers) creates a Proposal:

```ts
Proposal = {
  id, createdAt, origin: "verifier" | "commander" | "stall",
  serverId, targetAgentId, message, deliveryMode: "steer" | "interrupt",
  reason: string, classification: "normal" | "destructive",
  status: "pending" | "approved" | "denied" | "sent" | "expired",
  allowPair?: boolean,
}
```

- **Ask mode (default)**: every proposal is a card in feed + Needs-you bucket with Approve / Edit / Deny. Edit opens the message for tweaking before send.
- **Auto mode**: proposals send immediately and the card records what went out — EXCEPT: `classification: "destructive"` (prompt instructs machinery to classify anything touching prod/deploy/deletion/irreversible ops) → always asks; and presence/stop conflicts (below) → always ask.
- **Presence & user-stop (ask, never block, even in Auto)**: if the target agent has `stoppedBy: "user"` on its last run, or any connected client is viewing it (`focusedAgentId` match with `appVisible`), the proposal downgrades to ask. `focusedAgentId` must be set by BOTH the workspace agent tab AND the Mission Control inspector.
- `stoppedBy: "user"` is recorded when a cancel originates from a client session RPC; machinery-originated cancels record their origin.
- Mode toggle lives in the Mission Control screen header (not settings). RPC-backed, instant.
- User messages always outrank: send to a busy worker delivers as steer by default; `fleet_send_prompt` gains `mode: "steer" | "interrupt" | "queue"` (default steer).

## Commander

- **Single fleet Commander** on the designated commander host (central setting; iammvaibhav-class always-on host). Daemon boot ensures it exists (auto-create with label `paseo.mission-control=commander` if missing and this host is designated). Nothing needed in deploy scripts.
- **Drift auto-recreate**: the Commander record stores a hash of its baked system prompt + tool allowlist at spawn. On daemon boot, hash ≠ current build → archive the stale Commander and spawn fresh (old conversation stays in History). Kills the manual post-deploy archive step (live incident: a pre-v3 Commander lost `fleet_send_prompt`/`send_agent_prompt` after deploy and reported "can't reach Hale").
- **Reset Commander**: `mission_control.commander.reset.request/response` — archive current + spawn fresh with a new context pack. Exposed in the thread overflow menu.
- Fast model (routing over injected context needs no deep reasoning): default = host default omp model; central setting can override. **Runtime settings stick**: a user change to the Commander's model/thinking in the composer persists into the stored agent config; machinery dispatches (digest flush, approval delivery) must never re-pass creation-time settings (live bug: every digest run reset thinking to `low` via `--thinking <stored initial>`).
- **Prompt layering (cache-preserving)**:
  1. System prompt = static only: identity, playbook, safety, tool contract. Lives in repo markdown: `packages/server/src/server/mission-control/commander-prompt.md` (bundled at build; user instructions from settings appended). The orchestrator reminder moves here — never again in message bodies.
  2. First conversation message = context pack snapshot: fleet map + per-host aliases, projects + descriptions, workspaces, roster (one line per live agent: name, title, status, last report headline, age; running + review only; cap 30), and **per-host invocable provider/model strings** — the exact `provider/model` values `create_agent`/`fleet_create_agent` accept, listed verbatim so the Commander never guesses provider strings (transcript failure: five rejected guesses). Refreshed via context updates when models change.
  3. Deltas ride digests (append-only, cache-friendly). After omp compaction or session restart, next digest carries a fresh snapshot.
- Digest queue unchanged (idle flush, user outranks). Digest content: full report_status lines. Exactly ONE `<paseo-system>` envelope per digest/context-update message (a live bug double-wraps: `<paseo-system> <paseo-system> Context update:` — fix at the composer).
- **User → Commander delivery is interrupt** (replaceRunning), not steer — your message takes over immediately. The interrupt mechanics (cancel notices, resumed tool calls) are machinery noise hidden in normal mode (see App: verbose mode). Commander → workers stays steer-default.
- **User-message tagging**: Commander records `relatedAgentIds` for each user message it handles (tool: `tag_message` or structured field in its reply pipeline — implementer's choice, must persist in store). Tagged messages feed verifier spawns. Fleet-wide remarks tag all active.
- `fleet_get_agent_activity { host, agentId, limit? }`: new tool, same shape as local `get_agent_activity`, proxied over peering — kills "can't read its timeline from here".
- Ack suppression: digests instruct — no prose when nothing needs action. Server drops pure-ack replies (single-token/`ok` heuristic) from the visible thread; log them. Retraction must fire on EVERY machinery dispatch path, including the async approvals delivery (live bug: post-async, `ok` replies persisted in the thread).
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

## Stall detection v2 + watchdog

Data-derived thresholds (from 60-session analysis: inference gap p99 = 83s; hub-wait p90 = 19min):

- **Eligibility — Running only.** Nudge/escalation apply solely to agents with a run in progress. Ready-for-review (self-declared complete), Done, user-stopped, and failed agents are never nudged or recovered (failed already surfaces in Needs-you; user-stopped is Done). Commander/Verifier/internal agents excluded.
- **Two nudge triggers, one nudge action.** Both produce the same status-ask **steer, sent directly — no approval in either mode** (a steer never disrupts the turn; recorded as an auto-sent proposal, never pending):
  - **Nudges are machinery, not user-facing.** A status-ask steer needs no approval and never disrupts the turn, so its card renders in **verbose mode only**; the audit trail (auto-sent proposal + log) is kept. Only the hard escalation below — an interrupt, approval-gated in Ask — surfaces as a normal-mode card. (Live: nudge cards in the normal feed read as nagging when the agent is answering them.)
  - **Silence trigger** (`silenceNudgeSeconds`, default 120): NO timeline output at all — no tool calls, no text — while mid-run. Early warning for a wedged turn. No wait-exception: a steer lands mid-hub-wait harmlessly, and repeat-noise is handled by backoff, not exemptions.
  - **Cadence trigger** (`statusNudgeSeconds`, default 300): no `report_status`, even though timeline rows may be flowing. Prompt: "You've been quiet for a while. Post a one-line report_status summarizing where you are, then continue."
  - Shared discipline: a `report_status` resets BOTH timers AND both backoff counters; timeline activity resets only the silence timer; at most one nudge per sweep.
  - **Consecutive-lapse backoff** (built-in, not a setting): each successive UNANSWERED nudge in the same run doubles that trigger's effective interval (120 → 240 → 480…, capped at 30min); a landed `report_status` (compliance) returns the trigger to its configured base interval; a user prompt or run end also resets. Widening keeps a long hub wait from producing a card every 2 minutes; a compliant agent is never punished with a wider cadence (live: the 2x-after-every-nudge behavior read as broken — 6+ minutes with no second nudge after an answer).
- **Escalation = recovery**: after ANY nudge, if the agent produces NO response at all (no report_status AND no new timeline rows) within `escalateSeconds` (default 300), create a **recovery proposal** with `deliveryMode: "interrupt"`: "Continue whatever you were working on and post a one-line report_status." An interrupt starts a fresh run, so this also recovers agents whose provider process died mid-run. Ask mode: approval card in Needs-you; Auto mode: sends automatically; presence/user-stop still force ask. A stalled event is emitted either way — this is what gives the Commander autonomy to recover stuck agents.
- **No hard sleeps**: agents must run long commands detached + poll, or use hub wait — never synchronous sleeps. A steer lands during a hub wait, so a healthy waiting agent answers the nudge and never escalates; response-based escalation supersedes the old wait-aware thresholds.
- **Reconciliation watchdog**: record `running` but provider runtime dead/exited >2min → self-heal record to error state, emit stalled event, log loudly. (Root-cause of the freeze itself is tracked separately by the user — do not chase it here.)
- **Abrupt kills (daemon restart, provider crash)**: boot reconciliation + the watchdog mark such runs **interrupted** (stop origin `system` — distinct from user-stopped AND from a run that failed on its own error). Interrupted agents land in Needs-you with an "Interrupted" chip and immediately qualify for the recovery proposal (interrupt-and-send "Continue whatever you were working on…") — Ask: card; Auto: sends. After a daemon restart the Commander is boot-ensured, the store is persisted, and healed agents' recovery proposals flow through the same gate: the fleet resumes itself.
- **Boot adoption of surviving runs** (live gap): the stall tracker arms on a `lifecycle → running` transition, so a run that PREDATES the daemon process is invisible to it forever — no nudge, no escalation. Boot must scan records with `lastStatus: running` and, when the runtime is **alive**, ADOPT them into tracking (seed timers from `lastActivityAt`); when the runtime is **dead**, heal as above. Verified failure: agent `3a71c7bb` ran continuously across a deploy restart and produced zero stall lines under the new pid.
- **Dormant row timestamps** come from the agent's real last activity, never from the rollout marker or daemon boot time (live: every Dormant row showed the same relative time).
- All three knobs (`silenceNudgeSeconds`, `statusNudgeSeconds`, `escalateSeconds`) are user-editable in central Mission Control settings.

## Protocol

Per docs/rpc-namespacing.md and docs/protocol-compatibility.md. Additive only; wire schemas pure; regenerate zod-aot validators.

- `mission_control.lifecycle.set.request/response` — mark done / clear / reopen `{ serverId, agentId, action }`.
- `mission_control.proposals.respond.request/response` — approve/deny/edit `{ proposalId, action, editedMessage?, allowPair? }`.
- `mission_control.mode.set.request/response` — ask/auto.
- `mission_control.config.get/patch.request/response` — central settings (stored on commander host).
- `mission_control.commander.reset.request/response` — archive current Commander, spawn fresh with a new context pack.
- `mission_control.events.fetch` — gains cursor paging (`beforeSeq`, `limit`).
- `mission_control.search.request/response` — `{ query, limit?, deep? }` → `{ matches }`; the full tiered search runs inside the owning daemon; the commander host merges local + peer results (mirrors `fleet_list_agents`).
- Push: proposals and lifecycle changes ride the existing `mission_control_event` push as new event kinds: `proposal`, `verdict`, plus `source: "verifier"`.
- Feature flag: `server_info.features.missionControlV3: true`. App gates once.

## Config

Per host (`config.json` → daemon):

- `missionControl.enabled`
- `missionControl.hostAlias` — THIS machine's alias ("work server"). Fleet map assembles aliases from each host's own declaration. No hardcoded machine lists anywhere.

Central (stored on commander host, edited from anywhere via `mission_control.config.*`):

- `commanderHost`, `commanderModel?`, `commanderInstructions`
- `verifierModel?`, `verifierConcurrency` (default 3), `evaluationScope: "commander" | "all"`
- `mode: "ask" | "auto"` (default ask), `retentionDays` (default 30)
- `namingTheme`, `hideAgentNames` (default false), `defaultDispatchHost`
- Stall thresholds (`nudgeSeconds` 300 — seconds without a status update before the agent is asked for one; `escalateSeconds` 300 — seconds of total timeline silence before escalating as stalled)

## App

- **Screen**: `[left sidebar (existing collapse)] [Commander thread (collapsible to thin strip)] [Inspector] [board rail (drag-resizable)]`.
  - Board row click AND full feed-card click (entire card is pressable, not just the name) → agent opens in Inspector in place. Repeated clicks swap content. No navigation, no tabs.
  - Inspector = embedded `AgentStreamView` **with composer** (reply in place). Header: agent name/title, host glyph, "Open in workspace →" (the only thing that navigates). Inspector reports `focusedAgentId` via the existing heartbeat. **Inspector width is drag-resizable** (same handle pattern as the board rail), persisted.
  - Compact form factor: Inspector becomes a full-screen push with back; no split.
- **Board**: running sorted by name (stable); review/done by time desc. Rows: title is the key line, name is the identity chip, one-line last-report. Host shown as a small glyph avatar: deterministic accent color from serverId + host alias initial (or per-host override in host settings: custom 1–2 char initials/emoji + color), tooltip = full name — design-token native.
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
- **Verbose mode** (per-device UI toggle in the MC header overflow, default OFF): normal mode shows your conversation, status/verdict/proposal cards, and pretty-rendered dispatch actions ONLY — Commander tool-call internals, thinking, inbound `<paseo-system>` digest/context messages, and interrupt mechanics are hidden. Verbose shows everything (the debug view). Digest inbound messages are pure machinery duplicating the cards — normal mode never renders them.
- **Card consistency**: every status update renders as the same uniform visible card — started, finished, failed, milestone, verdict. Nothing status-like is ever collapsed behind a divider. Collapsed-by-default is reserved for proofs and pretty-rendered tool bodies. (Live bug: fleet-digest system rows render as a collapsed "finished or failed with an error" divider while other statuses are cards — that row class disappears with digest hiding above.)
- **Started-card enrichment**: the started card renders live agent identity — once the agent's first report_status lands a title/description, the SAME card shows it (reactive join on agent identity, no new event row). A started card should never read as a bare "agent started" once anything better is known.
- **Keep Mission Control mounted**: navigating away and back must not remount/refetch/re-scroll. The screen stays alive (route kept in memory per docs/expo-router.md constraints — freeze, don't unmount). **Scroll preservation reuses the regular agent chat's mechanism** (AgentStreamView's anchoring), not a bespoke restore pass — zero visible motion on return (live bug: a ~1s up-then-down restore animation). Snappy is the acceptance bar: return to MC is instant and visually still.
- **Stop button** in the header (see Commander section). MC header contains ONLY: Ask/Auto toggle, Stop, overflow menu (verbose mode, Clear view, Reset Commander). **No Commander-host dropdown in the header** — host selection lives in central settings (live drift: a header `SelectField` picker exists; remove it).
- **Clear view**: overflow action sets a per-device clear-point — the thread renders from that moment; older cards stay in the store behind a "show earlier" affordance. Does not touch the Commander. (Reset Commander — the real context clear — is the RPC in the Commander section.)
- **Names**: daemon-held naming map; **theme switch re-maps all auto-assigned names server-side immediately and broadcasts `agent_update`** (live bug: config patch only persists — no re-map, no broadcast, UI never changes); `hideAgentNames` toggle hides chips leaving titles.
- **Agent tab tooltips** (workspace tabs, not just MC): hover shows "Name — Title" when names are enabled, title only when `hideAgentNames` is set.
- **Settings**: new central Mission Control settings screen (fleet policy; NOT inside any host's overview). Host overview keeps only alias + enabled — the alias field copy is "Alias for this machine". **Commander model and Verifier model use the app's `CombinedModelSelector`**, never free-text; Verifier model is labeled as an override (empty = omp `modelRoles.verifier` → `task` role). Ask/Auto toggle is in the MC header, mirrored read-only in settings.
- **Proofs**: feed cards and thread render proof sections collapsed by default ("Image proof", "API proof", ...). Image → existing image pipeline; video → new renderer (expo-video native, `<video>` web); api/code → code blocks from excerpt; pr/url → chip. Cross-host media: authenticated daemon file-fetch RPC proxied over peering, size-capped, pruned with retention.
- **Project descriptions**: `description` field on project records + edit sheet textarea; injected into Commander context pack for routing.
- **Thinking expansion (regression fix)**: thought items in ALL agent chats must expand on press. Two live bugs from the render slice: thought items compute `canOpenDetails: false` when the empty-detail heuristic swallows their text, and `"thinking"` was routed to `FleetToolCallDetailBody` which returns `null`. Fix both; add a regression test.

## Naming backfill (one-time, via omp scout — no in-daemon provider calls)

- One bulk omp one-shot per host (default model `@smol`), metadata-driven — never transcripts. Prompt input per agent: current name/title/description **+ first user prompt excerpt (~200 chars) + last report_status headline** — titles derive from what was actually asked, not from the bad title being replaced.
- **Agent titles are replaced, not just filled**: recompute the deterministic derived title from the first prompt (`create-agent-title.ts`); current title matches the derivation → auto-generated → replaceable. Anything else = user-set → untouched. Descriptions/names still fill-if-missing.
- Workspaces: generate old→new rename proposals (max 5 words, descriptive) ONLY for titles equal to derived defaults (branch/dir slugs). **Workspace title proposals get the workspace's agents (titles + descriptions) as context** so the name reflects what's actually worked on there. Present as a proposal card for one-shot user approval; never auto-apply. Set-once going forward: workspace names never auto-change after creation; agents name workspaces they create; titles are the living layer.
- **Deliverable = markdown report per host** (`--report <path>.md`): old→new tables for agent identity and workspace renames. The user annotates/approves the report; `--apply` consumes only the approved file.

## Logging

Every background mechanism logs structured lines under `module: "mission-control"` with `component`: `digest` (queue depth, flush, ack-drop), `verifier` (spawn, exchange, verdict), `approvals` (proposal created/resolved/sent/expired), `stall` (nudge/escalate/watchdog-heal), `context` (snapshot injected, size), `naming` (re-map, backfill). `grep mission-control ~/.paseo/daemon.log` must tell the whole story.

## Edge cases (bound decisions)

- Commander/Verifier excluded from all board buckets, badge counts, and feed self-loops (label filter).
- Verifier crash/timeout → item stays ready-for-review, retry once, then Needs-you card.
- Proposal expiry: 24h → `expired`, card dims.
- Worker archived while proposal pending → proposal expires.
- Host offline: board shows "host offline" row; queued sends deliver on reconnect (existing peer queue semantics).
- Ack-drop heuristic must never drop a reply containing a question, proposal, or any tool call.
- 10 agents finishing at once: one digest, verifiers capped at 3, no interrupts of the Commander mid-turn.

## Verification checklist (dev stack; NEVER restart the production daemon on 6767)

1. Worker self-reports via report_status → instant feed card; completed → ready-for-review; verifier spawns, audits, marks done (or demands proof; exchange relay works; allow-pair works).
2. Ask mode: stall nudge and verifier contact produce proposal cards; Approve sends steer; Edit modifies; Deny kills. Auto mode: sends immediately; destructive classification still asks; viewing the target in Inspector forces ask.
3. Board: stable order while multiple agents stream; buckets correct; dormant hidden until toggle; Done + Clear semantics; badges.
4. Inspector: card/row click opens in place, composer replies, focusedAgentId reported, Open-in-workspace navigates.
5. Commander: boot-ensured, static system prompt (no reminder in messages), context pack as first message, digest deltas, ack turns suppressed, fleet_get_agent_activity works cross-host on dev (single host: local fallback path).
6. Thread: scroll-up pages older events; composer aligned.
7. Tool calls render pretty; agent links render as chips.
8. Proofs: image + code + api render collapsed/expandable; video renders (sample file); cross-host fetch path exercised (dev: same-host).
9. Watchdog: kill a worker's provider process → record self-heals + stalled event.
10. Typecheck, lint, format, build:client, build:server all green.
11. v3.1: theme switch re-names instantly in UI; Commander thinking survives a digest flush; no `ok` rows in the thread after digests; stale Commander auto-recreated on boot after a prompt change; drafts survive navigation; thinking cards expand in a normal workspace chat; inspector resizes; board row right-click menu works; backfill dry-run emits the md report.
