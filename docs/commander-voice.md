# Commander Voice

A voice front-end for the Commander: you talk, it dispatches, the fleet works. Built on the Gemini Live API (bidirectional audio streaming with server-side tool calling), starting from the `gemini-live-speech` prototype on iammvaibhav (`~/experiments/gemini-live-speech`: a Node WS proxy bridging browser audio to Gemini Live, with server-side tool executors). [docs/commander.md](commander.md) owns what the Commander is; this doc owns the voice layer in front of it.

## Design position

Voice is a **spoken client of the same fleet contract as Commander**, not a second product surface. It never invents tools, never bypasses the approval gate, and never owns a parallel durable dialogue. The Commander thread is the system of record; voice is how you talk to the fleet.

Two modes (Mission Control setting, default **relay**):

- **relay** — voice answers questions with the same **read** tools Commander has; every **mutating** intent goes to Commander via `commander_dispatch`.
- **direct** — voice may call the full Commander tool surface itself (still approval-gated for mutations); every call is mirrored into the Commander thread.

Both modes are **tool-first**: no world snapshot, no compact host pack, no roster injection. The Live session context is system prompt + conversation turns + tool results. That is deliberate. Commander injects a snapshot so a text model can place work without a tool round-trip; Live tool calls are fast enough that voice should **look things up** instead of carrying a stale worldview. Voice resolves spoken names through the catalog (`fleet_list_inventory`) before any action tool; a name is never assumed to be a host.

Non-blocking for mutations in relay: `commander_dispatch` returns immediately ("on it"); results arrive later only when they matter under the announce policy. Direct mode may await its own tool results inside the Live turn.

## Architecture

```mermaid
flowchart LR
    Mic["Browser page<br/>(mic + speaker)"] <-->|"audio WS"| Proxy["Voice node (Node)<br/>Gemini Live proxy + tool executors"]
    Proxy <-->|"Live API WS"| Gemini["Gemini Live"]
    Proxy <-->|"@getpaseo/client WS"| Daemon["Daemon (commander host)"]
    Daemon --> Cmd["Commander thread"]
    Daemon -->|"mission_control_event push"| Proxy
```

The voice node runs on the commander host next to the daemon. It holds the Gemini API key and the daemon password; the browser page holds nothing.

## Tool surfaces

### Shared read tools (both modes — same as Commander)

Imported from the Commander contract / tool catalog. Do not hand-maintain a voice-only list. Every fleet tool executes through the daemon's tool catalog (`mission_control.tools.execute` → `createPaseoToolCatalog().executeTool`), the **same code path the Commander uses** — voice shapes the catalog's result for speech and never reimplements a roster, timeline, search, recall, or gated action.

| Tool                       | Purpose                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fleet_list_inventory`     | Hosts + projects + workspaces with an optional fuzzy query (project/workspace title or id, cwd, host name/alias) and optional host filter. THE resolve-first tool: a spoken name is never assumed to be a host — resolve it here, then act.                                                                                                |
| `fleet_list_agents`        | Roster across hosts. Voice speaks the digest: server-computed bucket counts per host — needs-you, running, ready, done, idle — led by "Across N hosts: X running, Y needs you, Z idle. Idle is not needs-you." Buckets come from `data.bucket`, never derived from statuses.                                                               |
| `fleet_list_models`        | Invocable provider/model strings + the default worker model for one host. Use before spawning so voice never asks the user for a provider or model.                                                                                                                                                                                        |
| `fleet_get_agent_activity` | Curated **timeline summary** for one agent on a host — recent projected messages from stored activity. **Read-only.** Does **not** poke the live agent or ask it for a fresh report; it is not a “nudge”.                                                                                                                                  |
| `fleet_agent_status`       | One-call "how is X doing": identity (name, title, description), canonical bucket, last report. `fresh: true` steers the agent to post a fresh `report_status` — a user-invisible machinery envelope, waits ≤60s, returns the stale data with `fresh: false` on timeout. The only mid-run status mechanism; fires only on explicit request. |
| `fleet_monitor`            | Session-scoped watches (`start`/`stop`/`status`, `fleet` or per-agent). Terminal events for the watched scope announce as spoken turns between utterances; while you are mid-turn they queue in the announce buffer and drain at the next boundary. Never poll.                                                                            |
| `fleet_search`             | Find agents by what they worked on.                                                                                                                                                                                                                                                                                                        |
| `fleet_recall`             | Semantic recall over fleet memory.                                                                                                                                                                                                                                                                                                         |
| `fleet_context`            | Run records / workspace·project rollups.                                                                                                                                                                                                                                                                                                   |
| `tag_message`              | Attribute the current user turn to agents (audits).                                                                                                                                                                                                                                                                                        |

Buckets are server truth: `fleet_list_agents` rows carry `data.bucket` (`needs_you | running | ready | done | idle`), and the digest counts those — it never derives buckets from statuses or `requiresAttention`. "Needs me" is the needs-you bucket — **never idle**. Host-local status tools are banned; `fleet_agent_status` is the one-call per-agent status.

**Read vs fresh status:**

| Want                                           | Mechanism                                                                                                                                               | Voice relay                                                                    | Voice direct                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Latest **already recorded** status / timeline  | `fleet_list_inventory` (resolve) → `fleet_agent_status` / `fleet_list_agents` + `fleet_get_agent_activity`                                              | Yes (read tools)                                                               | Yes                                                            |
| **Fresh** status from a live agent             | `fleet_agent_status { fresh: true }` — status-ask steer in a user-invisible machinery envelope, ≤60s wait, no approval                                  | Yes — the status-ask is auto-sent machinery, never gated                       | Yes                                                            |
| Actually **tell** the agent something          | `fleet_send_prompt` (gated steer/interrupt)                                                                                                             | **Not declared.** Use `commander_dispatch` so Commander owns the send proposal | Yes — call `fleet_send_prompt` (approval-gated like Commander) |
| Automatic status-ask while an agent is stalled | None. Wall-clock nudges are deleted; the only automatic status-ask is the terminal-state guarantee — run end, once per finish chain, machinery envelope | Daemon, not a voice tool                                                       | Daemon, not a voice tool                                       |

There is no separate `nudge` tool. A fresh status is `fleet_agent_status { fresh: true }` (the status-ask steer — auto-sent, invisible). Telling an agent to do something is `fleet_send_prompt`. After a fresh status-ask, the fresh content appears when the agent reports or when you re-ask — voice stays quiet until then unless the user asked to wait on that agent.

**Generic vs specific updates:**

- “Any updates?” / “what happened while I was away?” → `pending_updates()` only (session buffer).
- “What is Archimedes doing?” (passive) → read tools only (`fleet_agent_status` or `fleet_list_agents` + activity).
- “Get me a fresh status from Pia” → `fleet_agent_status { fresh: true }` (status-ask steer, never gated).
- Never answer a named-agent question from the silent buffer alone.

### Relay tool set (only these are declared)

The Live session **does not declare** mutating tools. The model cannot call what it cannot see.

| Tool                                                   | Purpose                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Shared read tools (table above)                        | Answer fleet questions without Commander.                                                    |
| `commander_dispatch(message)`                          | Any work that changes the fleet or needs placement — plain-language intent to the Commander. |
| `proposal_respond(proposalId, action, editedMessage?)` | Approve / deny / edit a pending proposal.                                                    |
| `pending_updates()`                                    | Drain the silent session buffer — only when the user asks for generic updates.               |

Relay prompt says: use reads for questions; use `commander_dispatch` for anything else. No “never call X” list — those tools are absent.

### Direct tool set

Full Commander allowlist **plus** `proposal_respond` and `pending_updates`. Mutating tools stay approval-gated. `commander_dispatch` is unused (voice is the brain). The allowlist is the same 25-tool catalog as Commander — including the 11 meta tools, `fleet_agent_status`, and `fleet_monitor`; a drift test asserts declaration parity per tool.

### Why this parity

- Same read tools → same answers whether you type to Commander or speak to voice.
- Both execute the fleet tools through the daemon's catalog (`mission_control.tools.execute`) → **one implementation** of every fleet tool; voice only shapes catalog results for speech.
- Relay mutations only via Commander → one placement doctrine, one approval surface.
- Direct reuses the same contract package → when tools change, both modes change.

### Dual channel ({spoken, data})

Every voice tool result is `{ spoken, data }` (spec 03): `spoken` is the digest the model reads aloud; `data` carries the compact typed rows with ids verbatim. The model speaks `spoken` and takes every id from `data` — ids are never spoken. The announce/pending_updates buffer keeps `proposalId`, `agentId`, and `kind`; they are never stripped. Errors are `{ error }` — a one-line reason with candidates, so the model can retry from the message alone. `server.js` sends the tool result as the Live `functionResponse.response`.

## Context model (what is in the Live session)

### In context

| Piece                                                                                                  | When                                                                                          |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **System prompt** (mode-specific; see below)                                                           | Session setup; stable for the session                                                         |
| **User conversation** (heard + spoken turns)                                                           | Continuous; Gemini Live history + our resume reinjection of last few turns if the handle dies |
| **Tool results** for calls this session made                                                           | Live API tool-response channel                                                                |
| **Injected announcements** for proposals that need a verbal decision + monitored-scope terminal events | Rare; see announce policy                                                                     |

### Never in context

- World snapshot / fleet map / project·workspace inventory
- Full roster or “running counts per host” pack
- Model catalogs
- Mission Control card stream
- Random finished/started/milestone events

If the model needs a host, project, workspace, agent, or status, it **calls a tool**. Guessing from memory of an old turn is wrong; the prompt forbids it. Names resolve via `fleet_list_inventory` first (project → workspace → agent → host); `fleet_list_models` is never the first lookup for a name.

### Resume after Gemini disconnect

Prefer Gemini `sessionResumption` (full Live history restored). If that fails, reinject **only**:

1. last N conversation turns (heard/spoken), and
2. any still-pending proposal one-liners the user has not answered.

No worldview pack on resume either.

## Announce policy (quiet by default)

Voice is **not** Mission Control chat. The feed shows every card; voice does not. Announcements come from `fleet_monitor` subscriptions (session-scoped) plus the decision events every session gets; they inject as spoken turns between utterances and queue in the announce buffer while you are mid-turn (the buffer keeps `proposalId`/`agentId`/`kind`).

Announced:

1. **Proposals and clarifications** — always, independent of any monitor (a decision needs you). One-line summary, then wait for approve/deny/edit. Destructive proposals require an explicit "yes, approve".
2. **blocked, error/failed, finished** — one line when the event is in a monitored scope; finished reads the title + final headline.
3. **You asked for generic updates** — `pending_updates()` drains the session buffer as a short spoken digest.

Never announced:

- agent started / tool calls / token stream / working reports
- mid-run milestone reports — P3, parked (must be hook-driven, not prompt-reported)
- Commander cards they did not ask about, background fleet noise

### Generic vs specific update routing

| User said                                                    | Tool path                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| “Any updates?” / “What’s new?”                               | `pending_updates` only                                                                                                |
| “How is Archimedes?” / “What are the stackmod agents doing?” | `fleet_list_inventory` (resolve) → `fleet_list_agents` / `fleet_search` → `fleet_get_agent_activity` (not the buffer) |
| “Did my spawn finish?” (session work, no name)               | Prefer `pending_updates`; if empty, specific tools                                                                    |

### What enters the silent buffer

Only events tied to this voice session's work or its `fleet_monitor` scope:

- outcomes of agents this session spawned, steered, or is watching (`fleet_monitor`)
- answers to questions this session asked (correlated)
- proposals that still need a decision (also eligible for inject when they need speech)

Everything else is **dropped**, not buffered. “Any updates?” is never fleet-wide gossip.

`pending_updates` is pull-only. The proxy never injects buffer contents unprompted.

## Modes: relay vs direct (setting)

Mission Control central config (and voice-node env for the standalone page): `voiceMode: "relay" | "direct"`, default `relay`. Changing the setting applies to new voice sessions; an open session keeps the mode it started with until End.

|                            | **relay**                                                                  | **direct**                                                          |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Declared tools             | Reads + `commander_dispatch` + `proposal_respond` + `pending_updates` only | Full Commander allowlist + `proposal_respond` + `pending_updates`   |
| Mutations                  | `commander_dispatch` → Commander                                           | Voice calls gated tools itself                                      |
| Answers to fleet questions | Voice read tools + spoken reply                                            | Voice tools + `post_answer` mirrored                                |
| Placement doctrine         | Commander prompt                                                           | Voice direct prompt (spoken subset)                                 |
| Latency shape              | Reads: live tools. Mutations: “on it” then later buffer                    | Reads + mutations in the Live turn (mutations may wait on approval) |
| Failure domain             | Commander can be busy; voice still answers reads                           | Voice owns the whole turn                                           |

### Shared contract (stay in sync)

| Shared piece                        | Owner                                        | Consumers                                                                               |
| ----------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tool names, schemas, allowlist hash | Commander contract / tool catalog            | Commander; voice relay (read slice only); voice direct (full)                           |
| Placement doctrine                  | `commander-prompt.md`                        | Commander full; voice direct spoken subset                                              |
| Approval gate                       | Daemon proposal RPCs                         | Both modes for every mutation                                                           |
| Event store + feed cards            | Mission Control events                       | UI always; voice only under announce policy                                             |
| Instruction ledger                  | Daemon (`mission_control.instructions.open`) | Commander always; voice every session (one row per utterance; `respondsTo` closes rows) |

When the allowlist or doctrine changes, regenerate voice tool declarations from the same package. Hand-copied lists are a bug.

### Instruction ledger (P0)

Every voice utterance is ledger-tracked like a Commander instruction. The voice node calls `mission_control.instructions.open` on each final user-utterance transcription; the daemon opens row(s) `#N` with `source: "voice"` and returns `{ instructions: [{ id, text }] }` — one row per utterance, no intent splitting. Open rows inject into the next model turn and into `pending_updates` output ("Open: #12 spawn worker in paseo — #13 status of Keen Heisenberg"). Every mutation and answer cites `respondsTo` with an open id; the row closes when its card lands. Unclosed rows resurface every turn — nothing silently drops. Prompt rule 10: do not end the turn with a row from this utterance open without a card or an explicit "blocked on you".

### Source of truth and mirror (Commander gets the voice conversation)

```mermaid
flowchart TB
    subgraph truth [System of record]
        CmdThread["Commander thread<br/>dialogue + cards"]
        Events["MC event store"]
    end
    Voice["Voice session<br/>Gemini Live"]
    Voice -->|"every heard user turn"| CmdThread
    Voice -->|"every spoken reply (summary)"| CmdThread
    Voice -->|"relay mutations: commander_dispatch"| CmdThread
    Voice -->|"reads: fleet_* tools"| DaemonTools["Daemon fleet RPCs"]
    Voice -->|"direct: gated tools + card mirror"| CmdThread
    CmdThread --> Events
    Events -->|"proposal needs decision → inject"| Voice
    Events -->|"session- or monitor-scoped outcomes → silent buffer"| Voice
    Events -->|"unrelated fleet noise → drop"| Drop["dropped"]
```

1. **Commander thread is durable truth** for dialogue and cards.
2. **Voice is ephemeral** except session JSONL forensics.
3. **Full voice dialogue is mirrored into the Commander thread** so text Commander always has what you said and what voice answered — not only tool calls:
   - each **heard** user utterance → a user message on the Commander thread with `voiceMirrorKind`
   - each **spoken** assistant reply → an assistant message with the same kind (spoken summary, not audio)
   - **direct** tool side-effects already produce proposal/answer/clarify cards; those are the structured half of the same log
4. **Relay** mutations still go through `commander_dispatch` (instruction ledger + Commander cards). Pure Q&A still mirrors so the model thread is complete when you switch back to typing.
5. **UI hide for pure Q&A:** rows with `voiceMirrorKind: "qa"` are hidden unless Mission Control verbose is on. Rows with `voiceMirrorKind: "dispatch"` stay visible. The model thread always keeps both.

Without (3), typing after a long voice session would leave Commander blind to what you already decided by mouth. That is unacceptable.

## Advanced session options (voice, thinking, VAD)

Per-session Live knobs, visible in the app's voice panel **only in Mission Control verbose mode** (the same per-device debug flag as the feed). Values apply to the next voice session; an open session keeps the options it started with. Env defaults on the voice node: `VOICE_NAME`, `GEMINI_THINKING_LEVEL`, `GEMINI_VAD_START_SENSITIVITY` / `GEMINI_VAD_END_SENSITIVITY` / `GEMINI_VAD_SILENCE_MS`.

| Option   | Live setup field                                 | Values (verified 2026-08 on `gemini-3.1-flash-live-preview`)                                                                                                                                                                       |
| -------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice    | `generationConfig.speechConfig`                  | `Puck` (default), `Charon`, `Kore`, `Zephyr`, `Fenrir`, `Aoede`, `Leda`, `Orus`, `Nova`. `Asteria` is rejected (close 1007).                                                                                                       |
| Thinking | `generationConfig.thinkingConfig.thinkingLevel`  | `minimal` (model default) / `low` / `medium` / `high`. Higher = more reasoning, longer to first token, billed thinking tokens.                                                                                                     |
| VAD      | `realtimeInputConfig.automaticActivityDetection` | `startOfSpeechSensitivity` (`START_SENSITIVITY_HIGH`/`_LOW`), `endOfSpeechSensitivity` (`END_SENSITIVITY_HIGH`/`_LOW`), `silenceDurationMs` (1–5000). Wire enum constants only — the API rejects `"HIGH"`/`"LOW"` with close 1007. |

The client sends these in the `init` frame (`voiceName`, `thinkingLevel`, `vad`); the node validates against the lists above and drops anything invalid (see `scripts/commander-voice/lib/session-options.js`). The Gemini Live model comparison note applies: async (`NON_BLOCKING`) function calling is a Gemini 2.5 Flash Live feature — on 3.1 the setup accepts the field but calling stays synchronous, and the model can emit duplicate tool calls before the first response arrives (observed in `test/nonblocking-test.mjs`), so mutating call dedupe is a node-side concern.

## System prompts

Two prompts, both short, spoken-first. They are **not** a paste of `commander-prompt.md`. Commander is card-grammar + snapshot-trust; voice is tool-first + quiet.

### Shared voice rules (both modes)

One shared discipline block (the 10 rules, spec 05 — identical in commander-prompt.md) plus the minimal mode framing:

```
You are Mission Control Voice — spoken interface to the Paseo fleet.

Context you have: this system prompt, the live conversation, and results of tools you call.
You do NOT have a fleet map, roster, or project list in context. Never invent hosts, projects,
workspaces, agent names, or status. If you need a fact, call a tool.

Speak short, plain sentences. No markdown, no bullet lists, no raw ids, no tool narration
("I'm calling fleet_list_inventory"). Just the answer.

The "Open: #12 …" line injected with your turns is the open-instructions list — the daemon
opens one row per user utterance and closes a row when a card cites its id (respondsTo).

Discipline (every turn):
1. Facts come from tools, never memory. Ids, statuses, placements must be
   looked up in this session.
2. Copy, never construct: every id you pass must appear verbatim in a prior
   tool result's data. Titles and names are never ids. Missing id → call the
   tool that returns it first.
3. Enums: use only values listed in the schema. A rejection listing valid
   values → retry with exactly one of them or omit the argument. Never guess.
4. Resolve, then act: spoken names go to fleet_list_inventory /
   fleet_list_agents(query) first; act on the returned id.
5. Spawn: named project/workspace → pass the resolved wks_*. Named none →
   omit placement; the daemon places. Ask only when candidates tie.
6. One mutating call per intent. Wait for its result (proposal id or error).
   Never re-issue while one is pending.
7. Buckets are server truth (data.bucket). Never infer them from statuses.
8. Speak spoken; take ids from data; never speak an id.
9. Tool error → tell the user the one-line reason. Never pretend it worked.
10. Every mutation and answer cites respondsTo from the open-instructions
    list. Do not finish with an open row uncarded.
```

### Relay additions

```
Mode: relay.

Your tools are the read tools plus commander_dispatch, proposal_respond, and pending_updates.
Use read tools for any fleet question.
For any work that changes the fleet — spawn, steer, rename, archive, move, schedule —
call commander_dispatch with the user's intent in plain language. Resolve names first with
fleet_list_inventory and pass the matched project, workspace, or host along so Commander does
not have to re-resolve. Acknowledge with a short "on it" and stop. Do not wait for the
Commander turn. Results arrive later; surface them when the user asks for generic updates
(pending_updates) or when a proposal needs their decision.
Never ask the user which provider or model to use: Commander owns placement and the host's
default worker model. Dispatch the intent as-is when the user named none.
```

(No deny-list: mutating tools are simply not in the tool surface.)

### Direct additions

```
Mode: direct.

You hold the same fleet tools as the Commander. Placement doctrine (spoken form):
1. Explicit user host/workspace/agent wins.
2. Mutating work → matched project, new worktree workspace; never two mutators on one tree.
3. Read-only work → project root or the workspace the change concerns.
4. Follow-up on existing work → same workspace as the change.
5. No project → experiments on that host, or propose a new project if substantial.
6. One agent per unit of work.

Never ask the user for a provider or model. When the user names a project or workspace,
resolve it with fleet_list_inventory first, then create the agent with the matched ids and
cwd. Before a spawn, call fleet_list_models for the resolved host and pass its default worker
model as fleet_create_agent's provider; only when the user named a model, pass exactly that
(host defaults to 'local' unless the user named a host).

Mutating tools are approval-gated. Call them; do not pretend they already ran.
When you need a decision only the user can make, call clarify.
When you answer a fleet question for the record, call post_answer then speak the same content briefly.

Every mutation and answer card cites respondsTo from the open-instructions list — the row
closes the moment the card lands.
```

### How this differs from Commander

|                            | **Commander (text)**                                                     | **Voice (Live)**                                                                         |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| System prompt              | Full `commander-prompt.md` — cards, ledger, placement, proof conventions | Short spoken rules + mode slice                                                          |
| World state                | Full snapshot every turn (and after compaction)                          | **None** — tools only                                                                    |
| Output grammar             | Only proposal / clarify / post_answer cards in normal mode               | Spoken sentences; direct also emits cards via tools                                      |
| Chattiness                 | Feed shows all cards                                                     | Silent except ask / proposal decision / monitor announcements / explicit generic updates |
| Mutations                  | Gated tools on the Commander agent                                       | Relay: dispatch only. Direct: same gated tools on voice, mirrored                        |
| Dialogue continuity        | Thread is the chat                                                       | Every voice turn is **mirrored into the Commander thread**                               |
| Subagents                  | Structurally impossible (`--no-tools` + allowlist)                       | Same: only declared Live tools                                                           |
| Trust model                | Snapshot is fresher than memory                                          | Tool result is fresher than conversation memory                                          |
| `fleet_get_agent_activity` | Curated timeline read                                                    | Same — not a live agent ping                                                             |

## Experiment plan

1. ~~Backend session JSONL + Gemini resume~~ (landed).
2. ~~Replace voice-only `fleet_status` with shared **read** tool declarations; dual-mode tool surfaces + prompts~~ (landed).
3. ~~Tighten announce filter: session-correlated buffer; `pending_updates` pull-only; specific agent questions use read tools~~ (landed).
4. ~~Mirror every heard user turn and spoken reply into the Commander thread; hide pure Q&A in UI unless verbose~~ (landed).
5. ~~Mission Control setting `voiceMode: relay | direct` (default relay)~~ (landed).
6. Evaluate on real sessions: answer correctness vs Commander text, mutation latency, quietness, mirror fidelity (can you continue by typing after a long voice session?).
7. ~~Deeper direct executors for `fleet_recall` / `fleet_context` / `tag_message` when client APIs exist; peer-host activity proxy without Commander~~ (landed: `mission_control.recall` / `context.records` / `tag_message` / `peer.timeline` session RPCs).
8. ~~One catalog path for fleet tools: Voice `fleet_*` (reads and direct-mode mutators) execute `mission_control.tools.execute` → `createPaseoToolCatalog().executeTool`, the same code path as Commander; the voice-local roster/timeline fetches and the session RPCs from (7) are removed~~ (landed: M12).

Do not delete relay until direct has proven approval safety and the Commander chat still reads as one coherent log.

## Current implementation note

Dual-mode is implemented in-tree:

- Voice node: mode-aware tools/prompts (`scripts/commander-voice/`), `VOICE_MODE` env + central `voiceMode` after connect.
- Daemon: `mission_control.voice.mirror` appends Commander timeline without a model turn; `voiceMode` on central config.
- App: Settings → Mission Control → Voice tool mode; Commander chat hides `voiceMirrorKind: "qa"` unless verbose.

Deploy/restart the voice node and daemon to pick this up on a live host. Production may still run an older voice binary until redeployed.

## Testing

No microphone needed. Four harness layers:

1. **Logic tests (text mode)**: the Live API accepts text turns in the same session protocol. A headless WS client drives the proxy with text intents and asserts tool-call sequences and daemon effects (proposal created on the dev daemon, `proposal_respond` fired, worker record appears). Deterministic, runs against `.dev/paseo-home`. The dual-channel and monitor contracts also have node unit tests (`test/dual-channel.test.mjs`, `test/monitor.test.mjs` — `node --test`).
2. **E2E audio proof**: synthesize spoken commands with fish.audio TTS (`FISH_AUDIO_API_KEY` in `~/.zshrc` on iammvaibhav), stream the PCM into the Live session as mic audio, capture the audio replies, and assert the daemon effects. This proves the actual modality once per milestone; logic tests carry the regression load.
3. **Scenario suite** (spec 08): real Gemini Live with generated audio against a fleet daemon; spawned agents are deepseek v4 flash, resolved from the daemon's provider snapshot at test time. Each scenario asserts on session JSONL + daemon state, not speech: needs-me counts match `data.bucket`; status by name resolves → `fleet_agent_status` → answer carries title + last report with no ids spoken; spawn into a named workspace; spawn with no placement; duplicate emission dedupes to one proposal; invalid-enum recovery; multi-intent utterances open ledger rows and close all by cards; monitor announce injects between turns (non-blocking); meta rename by spoken name.
4. **Burn-in bench**: the scenario suite runs green 5 consecutive times before direct-mode can flip to the default (spec 08 pass bar).

All run against the dev daemon per [docs/agent-driven-development.md](agent-driven-development.md) — never against 6767.

## Observability (Session JSONL Logs)

Forensic session logs live at `$PASEO_HOME/commander-voice/sessions/<sessionId>.jsonl` (default `~/.paseo/commander-voice/sessions/`). A `latest.jsonl` symlink points to the most recent session file. Override the log directory using the `VOICE_SESSION_LOG_DIR` environment variable.

### Event types

Each JSON line contains `ts`, `sessionId`, and `event`:

| Event                  | Fields                                    | Meaning                                                   |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `session.start`        | `model`, `voiceName`                      | Voice session initialized                                 |
| `session.end`          | `reason`                                  | Session closed (`client_disconnected`, etc.)              |
| `client.connect`       | —                                         | Browser WebSocket connected                               |
| `client.close`         | —                                         | Browser WebSocket closed                                  |
| `gemini.setup`         | `model`, `voiceName`                      | Sent setup message to Gemini WSS                          |
| `gemini.setupComplete` | —                                         | Gemini confirmed setup ready                              |
| `gemini.goAway`        | `code`, `reason`, `timeLeft`              | Gemini sent disconnect notice                             |
| `gemini.close`         | `code`, `reason`                          | Gemini WebSocket closed                                   |
| `gemini.error`         | `error`                                   | Gemini WebSocket error                                    |
| `tool.call`            | `name`, `args`, `callId`                  | Model requested tool execution                            |
| `tool.result`          | `name`, `callId`, `ok`, `summary`/`error` | Tool execution completed (summary truncated at 500 chars) |
| `resume.attempt`       | `attempt`, `handle`                       | Reconnect attempt using resumption handle                 |
| `resume.success`       | `handle`                                  | Reconnect succeeded                                       |
| `resume.fail`          | `reason`                                  | Reconnect failed, falling back to fresh session           |

### How to debug a bad status answer or tool failure

1. Open the latest log file: `tail -f ~/.paseo/commander-voice/sessions/latest.jsonl`.
2. Find the `tool.call` event by name (for example, `fleet_list_agents` or `commander_dispatch`). Note the `callId`.
3. Locate the corresponding `tool.result` event matching that `callId`.
4. Inspect `ok` and `summary` (or `error`). If `ok` is false, check `error`.
5. For disconnection issues, locate `gemini.goAway`, `gemini.close`, or `gemini.error` events to determine disconnect code and reason.

## Session Resume (Gemini Live Auto-Reconnect)

Gemini Live sessions auto-reconnect when disconnected while the browser client remains open.

- **Resumption handle:** `setup` includes `sessionResumption`. Gemini updates the handle via `sessionResumptionUpdate.newHandle`.
- **Sliding window compression:** `contextWindowCompression` prevents session expiration during long turns (>15 minutes).
- **GoAway handling:** When Gemini sends `goAway`, the proxy logs disconnect details and prepares reconnect state before socket drop.
- **Reconnect flow:** If disconnected, the proxy attempts reconnect with backoff using the last handle (up to 5 attempts). If resumption fails, it starts a fresh session and re-injects only recent conversation turns plus pending proposal one-liners (no worldview pack).

## V1 scope and later

V1 is a standalone web app in the `experiments` project (promotion candidate, per the doctrine): the existing proxy + page, rewired from demo tools to the fleet tool surface, with the announce policy and the daemon client. Later, the same proxy backs a mic button in the Mission Control screen; the app already speaks the daemon protocol, so integration is UI work, not architecture work. The dual-mode contract above is the next architecture step after observability and Live session resume.
