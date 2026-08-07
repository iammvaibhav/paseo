# Mission Control

Fleet monitoring and dispatch. One screen: a deterministic **board** of every agent on every host, a **feed** of milestone cards summarized by the LLM gateway, and a **Commander** agent you chat with that routes work across hosts. This doc is the implementation spec; it becomes the feature doc once shipped.

## Vocabulary (glossary-bound)

| Term            | Meaning                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Mission Control | The screen at `/mission-control`. UI label wins; no synonyms ("fleet page", "dashboard" are wrong).                                    |
| Board           | Right-rail roster: live state of all agents, all hosts. No LLM anywhere in this path.                                                  |
| Feed            | Chronological milestone cards. Change, not state. Silence is the default.                                                              |
| Commander       | The one durable agent you talk to. Label `paseo.mission-control=commander`. A normal daemon agent — model configurable like any agent. |
| Digest          | A batched `<paseo-system>` prompt delivering buffered fleet events to the Commander when it is idle.                                   |

## Architecture

```
agents (all hosts) ──agent_state/agent_stream──▶ MissionControlService (each daemon)
                                                   ├─ detectors (no LLM): started/finished/failed/blocked/stalled
                                                   ├─ summarizer (gateway `extract`): milestone/finding/diverged
                                                   ├─ event store: $PASEO_HOME/mission-control/events.jsonl
                                                   ├─ push: mission_control_event → all clients
                                                   └─ digest queue → Commander (flush on idle, never interrupt)
app ──connects to every host (existing)──▶ board + feed aggregate client-side
commander-host daemon ──peer DaemonClients──▶ remote daemons (fleet tools + remote digests)
```

Three invariants, in priority order:

1. **The board cannot die.** It renders only data the app already receives (`agent_update` per host). No new failure modes.
2. **The feed never interrupts.** All Commander delivery goes through the digest queue; `replaceRunning` is never used for system-originated prompts. User messages keep today's preempt behavior — the user always outranks status.
3. **No LLM in any liveness path.** Summarizer failure degrades to deterministic cards only.

## Protocol (`packages/protocol`)

New file `src/mission-control/types.ts`, wired into `src/messages.ts` (follow `src/webhook/types.ts` precedent). Wire schemas stay pure — no `.transform()`/`.catch()`/`.preprocess()` (see docs/protocol-compatibility.md). Regenerate zod-aot validation per docs/protocol-validation.md.

```ts
export const MissionControlEventKindSchema = z.enum([
  "started",
  "finished",
  "failed",
  "blocked",
  "stalled",
  "milestone",
  "finding",
  "diverged",
]);
// NO "progress" kind. "Still working" is the board's job. Do not add it.

export const MissionControlProofSchema = z.object({
  kind: z.enum(["url", "image", "diff", "command"]),
  url: z.string().optional(),
  path: z.string().optional(),
  label: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  exitCode: z.number().optional(),
});

export const MissionControlEventSchema = z.object({
  id: z.string(), // "mce_" + ulid
  ts: z.string(), // ISO
  agentId: z.string(),
  agentTitle: z.string(),
  kind: MissionControlEventKindSchema,
  source: z.enum(["system", "summarizer", "self", "autopilot"]),
  severity: z.enum(["info", "attention", "blocker"]),
  headline: z.string(), // ≤ 120 chars, plain language
  detail: z.string().optional(),
  proof: z.array(MissionControlProofSchema).optional(),
  supersedesId: z.string().optional(), // coalescing chain
  coalescedCount: z.number().optional(),
});
export type MissionControlEvent = z.infer<typeof MissionControlEventSchema>;
```

RPCs (dotted namespaces per docs/rpc-namespacing.md; requests top-level params, responses under `payload` with `requestId`):

| Message                                | Shape                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `mission_control.events.fetch.request` | `{ sinceTs?: string, limit?: number, requestId }` → response `payload: { events: MissionControlEvent[], requestId }` |
| `mission_control.events.ack.request`   | `{ eventIds: string[], requestId }` → response `payload: { requestId }`                                              |
| `mission_control.peers.list.request`   | `{ requestId }` → response `payload: { peers: MissionControlPeerStatus[], requestId }`                               |
| push `mission_control_event`           | `{ type: "mission_control_event", event: MissionControlEvent }`                                                      |

```ts
export const MissionControlPeerStatusSchema = z.object({
  name: z.string(), // config name, e.g. "macbook"
  url: z.string(),
  state: z.enum(["online", "unreachable"]),
  lastSeenAt: z.string().nullable(), // for "unreachable since 12:03, likely asleep"
});
```

Feature flag: add `missionControl: z.boolean().optional()` to the `features` object inside `ServerInfoStatusPayloadSchema` (`messages.ts:2944` area). Client gates the sidebar entry on it — old daemon → entry hidden, no fallback path.

## Daemon config (`persisted-config.ts` / `daemon-config-store.ts`)

```jsonc
{
  "missionControl": {
    "retentionDays": 30, // feed retention, settable from Settings UI
    "summarizer": {
      "enabled": true,
      "baseUrl": null, // default: process.env.LLM_GATEWAY_URL
      "apiKey": null, // default: process.env.LLM_GATEWAY_KEY
      "model": "extract", // tier alias — benchmarked: 0.8–1.1s, correct discrimination
      "minNewItems": 12, // delta size that triggers a summarizer pass
      "debounceSeconds": 30, // per-agent
    },
    "autopilot": {
      "mode": "off", // off | observe | act — off default, inert
      "model": null, // evaluator tier alias; null = gateway "smart" / omp "@slow"
      "scope": "commander-spawned", // commander-spawned | all
      "maxNudgesPerAgent": 2, // nudge verdict at the cap escalates instead
    },
  },
  "peers": [
    // commander-host daemon only, empty elsewhere
    { "name": "macbook", "url": "tcp://<mac-vpn-ip>:6767", "password": "…" },
    { "name": "blrofc3", "url": "tcp://100.105.100.71:6767", "password": "…" },
    { "name": "iammvaibhav", "url": "tcp://10.7.0.1:6767", "password": "…" },
  ],
}
```

All keys optional with defaults; absent config = feature on with defaults, summarizer silently disabled when no gateway URL resolves.

## Server (`packages/server/src/server/mission-control/`)

Construct in `bootstrap.ts` next to `ScheduleService`; pass `agentManager`, `agentStorage`, config store, logger, broadcast fn.

### `store.ts`

- `events.jsonl` under `$PASEO_HOME/mission-control/` — append-only JSONL, loaded on boot, pruned on boot + daily to `retentionDays` (default 30) and hard cap 5000 rows. Use `writeFileAtomic`/append pattern from `atomic-file.ts`.
- `observations.json` — per-agent `{ lastTimelineSeq, lastSummarizerTs, lastEventByKind: Record<kind, eventId> }`.
- Coalescing: a new unacked event of the same `(agentId, kind)` sets `supersedesId` to the previous one and increments `coalescedCount`; fetch returns only the heads of chains by default.

### `service.ts` — detectors (no LLM)

Subscribe once to `AgentManager` (`AgentManagerEvent`, `agent-manager.ts:211`). Deterministic transitions → events:

| Transition                               | Event      | severity  |
| ---------------------------------------- | ---------- | --------- |
| first `running` for an agent             | `started`  | info      |
| `attentionReason: "finished"`            | `finished` | info      |
| `attentionReason: "error"` / turn_failed | `failed`   | attention |
| pendingPermissions > 0 or question       | `blocked`  | blocker   |
| stall detector fires                     | `stalled`  | attention |

Stall detector: per running agent, track last `agent_stream` timestamp + the kind of the tail timeline item. Thresholds: no in-flight tool call → `stalled` at 5 min; in-flight tool call (long builds/tests are legitimately quiet) → 20 min. One `stalled` event per stretch (coalesced).

Exclusions (both detectors and summarizer): agents labeled `paseo.mission-control=*`, `internal: true` agents, and agents with `paseo.parent-agent-id` (subagents — their parents report for them). Daemon restart: emit one `started`-suppressing grace window (60s) so a restart doesn't fire phantom `stalled`/`started` storms.

### `summarizer.ts` — judgment (gateway `extract`)

Trigger per agent, debounced: ≥ `minNewItems` new timeline rows since `lastTimelineSeq`, or a `finished` transition (outcome headline). Build input:

- **Brief**: all user messages so far (first message + steering) from the stored timeline — this IS the divergence contract; no separate intent record.
- **Delta**: `curateAgentActivity` over rows after `lastTimelineSeq`, capped ~6k chars.

Call `${baseUrl}/chat/completions`, `model: "extract"`, `response_format: {type:"json_object"}`, `max_tokens: 900`, timeout 120s, one retry. Expected shape `{ worth_posting: boolean, kind: "finding"|"fix"|"milestone"|"blocked"|"diverged"|"progress", headline, detail? }`. Mapping: `fix`→`milestone`; `progress` or `worth_posting:false` → drop silently; `blocked`/`diverged` → severity attention. Editorial rules enforced in code, not prompt trust: max one summarizer event per agent per pass; drop headlines that normalize to something already posted for that agent (lowercase, strip non-alphanumerics, exact match); never post while a deterministic event for the same transition is younger than 10s (dedupe).

Never send secrets; the delta is curated activity text only. Summarizer failure = log + skip; deterministic events unaffected.

### `digest.ts` — Commander delivery

Buffer all events (local + peer-forwarded). Flush when: Commander exists, `status === "idle"`, no in-flight run, and buffer non-empty (check on every agent_state change of the Commander + 30s sweep). Flush = one `<paseo-system>` digest listing events with deep links (`paseo://h/{serverId}/agent/{agentId}`), sent through `startAgentRun` with `replaceRunning: false` — **never interrupt**. If dispatch races a user prompt, keep buffering. Skip `finished`/`failed` for agents whose labels mark the Commander as parent (`notifyOnFinish` already covers those). The digest prompt must not trigger attention on the Commander.

### Activity peek (pre-existing bug fix, non-optional)

`get_agent_activity` (`paseo-tools.ts:2998`) calls `ensureAgentLoaded` unconditionally — reading a closed agent resurrects its provider process. Add `peek?: boolean` param (default false, back-compat): when true, read the stored timeline via `AgentStorage`/timeline store without loading. MissionControlService always reads storage directly, never the tool.

### Peering (`packages/server/src/server/peers/`)

`peer-manager.ts`: for each `peers[]` entry, hold a `DaemonClient` (`@getpaseo/client`) with `createNodeWebSocketFactory` (copy CLI: `packages/cli/src/utils/client.ts:250`), password auth, built-in reconnect. State machine: `online` ↔ `unreachable{lastSeenAt}`. Uses:

1. Subscribe to peer `mission_control_event` pushes → forward into the local digest queue (feed stays client-aggregated; forwarding is only for the Commander).
2. Fleet MCP tools for the Commander (`paseo-tools.ts`): `fleet_list_agents` (merge local + peers), `fleet_create_agent({ host, ... })`, `fleet_send_prompt({ host, agentId, ... })` — proxied through the peer client. Unreachable peer → tool error: `Host "macbook" unreachable since 12:03 (likely asleep). Work queued for other hosts is unaffected; retry after it wakes.` Never silently retry.
3. `mission_control.peers.list` RPC for the UI.

Server may depend on `@getpaseo/client` (client depends only on protocol; no cycle; build order already builds client before server).

### Context pack (`packages/server/src/server/mission-control/context.ts`)

The Commander never discovers what the daemon already knows. A deterministic builder assembles its worldview; querying is the failure mode. Sections:

1. **Fleet map** — hosts with user aliases from `missionControl.hostAliases` config (e.g. `blrofc3: "work server"`, `iammvaibhav: "personal server"`), reachability, capability notes, privacy posture (`blrofc3`: work-compliant providers only).
2. **Inventory** — every project and workspace across all hosts with titles and descriptions (local registry + `mission_control.context.fetch.request` RPC served by every daemon, aggregated over peers). ~10 projects / ~30 workspaces; small enough to inline whole.
3. **Models** — providers/models available per host plus omp `modelRoles` defaults (each daemon parses its local `~/.omp/agent/config.yml`; peers report theirs through the same RPC).
4. **Roster** — recent and running agents with name, title, living description (see Identity).
5. **Playbook** — exact tool invocations for each pattern: task on host X (`fleet_create_agent`), new worktree workspace off main/master, new project from a GitHub link, continue vs fork vs fresh agent (fork when context helps but the task differs; same agent for a continuation; fresh when no context needed).
6. **Smart defaults** — user's wording always wins; otherwise: default dispatch host from `missionControl.defaultHost`, reuse a matching existing workspace, dispatch-don't-discuss.

Injected into the Commander's **replaced** system prompt at launch; refreshed by piggybacking a compact delta on digests when the inventory changed. Staleness tolerated between refreshes.

### Commander contract

The Commander is an orchestrator, not a coding agent. Three enforcement layers, strongest first:

1. **Tool restriction (hard)** — spawn with only the Paseo MCP tools it needs (`fleet_*`, `create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity` peek, `list_agents`, workspace/project tools, history search). No bash, no file editing, no task subagents. Use omp's tool-selection surface (`--no-tools` exists; find the selective allowlist in `src/cli/flag-tables.ts:309` area) threaded through the omp provider launch args per-agent.
2. **System prompt replacement (strong)** — omp `--system-prompt` renders `custom-system-prompt.md`, replacing the coding harness entirely (`src/system-prompt.ts:894`). Paseo already carries per-agent `config.systemPrompt` (`agent-sdk-types.ts:578`) but always emits `--append-system-prompt` (`omp/runtime.ts:94-147`); add `systemPromptMode: "append" | "replace"` so the Commander replaces. The replaced prompt = persona + CAN/CANNOT + context pack.
   - CAN: dispatch, report status from context, name agents/workspaces, ask the user.
   - CANNOT: run commands, read or edit files, debug failures (report them and offer to dispatch a debug agent), approve permissions, archive anything, restart daemons.
3. **Per-prompt reminder (soft)** — every digest ends with one fixed line restating the contract, so long sessions cannot drift.

Evidence this is needed: the first live Commander answered "spin up an agent on blrofc3 that replies Ok" with 25 tool calls — CLI spelunking, provider-auth debugging, daemon-log reading on two hosts — because the appended brief sat under omp's full coding prompt.

### Identity: names, titles, descriptions

Every agent gets three fields; all optional on the wire (protocol back-compat):

| Field         | Nature                                                                      | Producer                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Fun stable identifier ("Ripley") assigned at creation, fleet-wide, editable | Daemon naming service: curated pools, theme from `missionControl.naming.theme` (`mixed` default; `indian`, `cartoon`, `scientists`, `astronauts`, `mythology`, `nature`), collision-avoiding per host |
| `title`       | Task summary, kept stable                                                   | Existing pipeline (`create-agent-title.ts`); re-titled only when a milestone summary differs significantly                                                                                            |
| `description` | Living one-liner, refreshed at milestones                                   | Mission Control summarizer pass doubles as the refresher; persists via `agentManager.updateAgentMetadata`                                                                                             |

- Add `name` + `shortDescription` to `StoredAgentRecord` and `AgentSnapshotPayload` (optional fields).
- **Backfill on boot**, idempotent: agents missing a name get one; closed agents missing a description get one generated; untitled workspaces run through `workspace-auto-name.ts`.
- **Identity injection**: the created agent is told its own name/title in its first prompt envelope, so "what's the status of the task involving X" is answerable by the Commander AND the agent knows itself.
- **Compliance**: description/title generation uses the existing `agents.metadataGeneration.providers` fallback chain (`structured-generation-providers.ts`) — per-daemon config keeps blrofc3 on claude/cursor/codex. Mission Control feed summaries stay on the gateway for macbook/iammvaibhav; blrofc3's summarizer backend is `missionControl.summarizer.backend: "gateway" | "omp"` where `omp` shells `omp -p --no-tools --no-session --no-skills --no-rules --model @smol "…"` (~0.5–1s overhead, acceptable at milestone rate).

### History integration

Commander tool `history_search` reusing the History Ask machinery. Contract in the prompt: roster first; on miss, offer History search; go straight to History when the user says so.

## App (`packages/app`)

### Route + chrome

- `src/app/mission-control.tsx` — `HostRouteBootstrapBoundary` + `MissionControlScreen` (copy `app/schedules.tsx`, 10 lines).
- `buildMissionControlRoute()` in `src/utils/host-routes.ts`.
- `src/app/_layout.tsx`: `Stack.Screen name="mission-control"` + `/mission-control` in `shouldShowAppChrome` (~lines 873, 902). **Never** the cold-start destination (docs/expo-router.md).

### Sidebar

Both desktop (`left-sidebar.tsx` ~909) and mobile (~715) stacks: new `SidebarHeaderRow` **directly under New workspace, above History**. `SidebarHeaderRow` has NO badge prop today (verified: props are icon/label/onPress/isActive/testID/nativeID/accessibilityLabel/variant/shortcutKeys) — add optional `badgeCount?: number` rendering a small count pill; badge = `needs_input + failed` agents from `useAggregatedAgents`. Gate the row on `features.missionControl` of at least one connected host.

### Data

`src/data/` replica pattern (`push-router.ts` + `query.ts`): register `mission_control_event` push + `mission_control.events.fetch` per host; new hook `useAggregatedMissionControlEvents()` merges hosts client-side (mirror `use-aggregated-agents.ts` — the feed is cross-host from day one without peering).

### Screen (`src/screens/mission-control-screen.tsx`)

Desktop layout: center thread + right board rail. Compact/mobile: board is a panel/tab, thread is primary (docs/mobile-panels.md patterns).

- **Board rail**: agent-keyed variant of `sidebar-status-list.tsx` grouping by `deriveAgentStateBucket` order `needs_input → failed → running → attention → done`, host badge per row, one-line activity, click → `openAgentFromHistory({serverId, agentId})`. Host offline → explicit "host offline" row (agents must not silently vanish).
- **Thread**: ONE chronological list merging feed cards and Commander conversation (user decision — no two-pane split). Implementation: `MissionControlThread` FlatList over a union of `{kind:"event", event}` and `{kind:"commander", timelineItem}` sorted by ts; Commander items rendered with the same message components `AgentStreamView` uses (embedding precedent: `panels/provider-subagent-panel.tsx`, `composer/draft/workspace-tab.tsx`). Feed cards: icon per kind, headline, agent chip (deep link), proof chips, relative time; blocker severity pinned styling.
- **Scroll**: bottom-anchored; when detached (user scrolled up), freeze and show "N new ↓" pill; auto-follow only at bottom. Reuse the existing bottom-anchor controller; read `skill://chat-scroll-freeze` before touching this.
- **Composer**: existing `Composer`, pinned bottom, sends to the Commander agent on its configured host.
- Unistyles rules apply (`useUnistyles()` forbidden in feed rows — docs/unistyles.md); hover per docs/hover.md.

### Commander launch (`src/mission-control/launch.ts`)

Client-first `createAgent` on the configured Commander host (screen setting, persisted in app storage), labels `{ "paseo.mission-control": "commander" }`, unattended mode, `systemPromptMode: "replace"` with the contract prompt + context pack. **No visible brief message** — the instructions live in the system prompt, not the thread. Model: **last model selected in the Commander** (persisted per host in app storage; when the user changes it via the normal picker, remember it); falls back to orchestration preferences on first run. Screen recreates the Commander if archived.

### Commander invisibility

The `paseo.mission-control=commander` label hides the Commander everywhere except Mission Control: excluded from board buckets and the sidebar badge count client-side; its home-dir workspace hidden from the sidebar (extend the existing home-dir hiding rule); not archivable from any UI surface; never in Running/Done. Do NOT use `internal: true` (kills History).

### Settings

Host settings page (`screens/settings/host-page.tsx` + `use-daemon-config.ts` patchConfig): "Mission Control" card — retention days (default 30), summarizer toggle + backend (`gateway`/`omp`), default dispatch host, host alias fields, naming theme picker, editable Commander instructions (multiline, defaults to the shipped contract). Follow docs/forms.md.

## Milestone self-reporting (hybrid)

The summarizer alone misses the best milestones: it reads transcripts third-hand, its trigger is conservative, and provider-internal subagents are invisible to the daemon entirely. Self-reporting is primary; the summarizer is the backstop.

- **`report_milestone` MCP tool** (all agents): `{ kind: "finding"|"milestone"|"blocked"|"diverged", headline (≤120 chars), detail?, proof? }` → straight into the event store as `source: "self"`, instant, zero LLM cost. Rate-limited per agent (max 1/min, coalescing rules apply unchanged). Excluded agents (mission-control labels) get a polite error. Kill-switch: `missionControl.selfReport.enabled` (default true) also removes the prompt paragraph.
- **Prompt injection**: one paragraph in the daemon-injected append system prompt (reaches every provider with prompt plumbing, including hand-started agents): report once per real milestone — found the cause, fixed it, tests green, blocked, changed approach; never progress updates. Parents report for provider-internal subagents. Omitted for mission-control-labeled agents.
- **Summarizer demotion**: skip the summarizer pass for any agent that self-reported within the last N items (default: since the last pass cursor); it runs only for silent agents. Finished-transition outcome pass stays for everyone.
- **Hardening**: gateway JSON parsing reuses the fence-tolerant extractor from the omp backend; a shape failure logs the raw body (truncated) and does not advance the cursor.

## Autopilot

Evaluate-and-act on worker completion. The Commander routes on a cheap model; judgment runs on a smart one. The evaluator never investigates — it is a verifier (what did the agent do) and a commander (accept / nudge / escalate), nothing else.

- **Trigger**: a worker's `finished` event (scope config: `commander-spawned` default | `all`).
- **Evaluator pass**: ephemeral, per event — no resident agent, no context growth. Input: the worker's brief (its user messages), activity delta since last verdict, self-reported milestones, proof. Backend: same switch as the summarizer (`gateway` | `omp` one-shot) but on the **evaluator model** (`missionControl.autopilot.model`, default a smart tier/opus-class; the Commander's own model stays cheap and separately configurable).
- **Verdict** (structured): `accept` — mark complete, feed card notes it; `nudge` — daemon sends the worker precise follow-up instructions verbatim from the verdict; `escalate` — blocker card + digest to Commander/user with the reason.
- **Boundaries** (the aggressiveness dial): `maxNudgesPerAgent` (default 2, then forced escalate); nudges never expand scope beyond the original brief; never touches permission prompts; `mode: off | observe | act` — `observe` posts verdicts as feed cards without acting, `act` sends nudges automatically. Default is `off` (safety first; rollout starts inert until the operator flips the mode in Settings).
- Config: `missionControl.autopilot: { mode, model, scope, maxNudgesPerAgent }` + settings card controls.

## Build order (waves)

| Wave | Slices (parallel)                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **A** protocol · **B** server service+RPCs+config · **C** app route/sidebar/badge/data/board · **D** app thread/composer/commander/settings · **E** server peek fix+digest queue · **F** peering+fleet tools |
| 2    | integration: `npm run build:client && npm run build:server`, typecheck, lint, fix fallout                                                                                                                    |
| 3    | verification: dev daemon + browser-driven web UI + small live agents (deepseek v4 flash free; gemini 3.6 flash on blrofc3)                                                                                   |

Cross-slice contract = the schemas and names in this doc, verbatim. Slices must not run repo-wide validation mid-flight.

## Verification checklist

1. Dev daemon boots with `MissionControlService`; `server_info.features.missionControl === true`.
2. Sidebar shows Mission Control under New workspace; badge counts needs-you agents.
3. Board lists agents across configured hosts, buckets ordered, click-through works.
4. Start a small agent → `started` card appears; let it work → summarizer posts ≤1 milestone card (or stays silent); finish → `finished` card with outcome headline.
5. Commander answers a message, dispatches a worker, stays responsive; digest arrives only when idle (verify no turn interruption in daemon logs).
6. Kill gateway env → summarizer disabled, deterministic cards still flow.
7. Peer configured → remote agent events reach Commander digests; unplug peer → peers.list shows `unreachable` with lastSeen; fleet tool error mentions "likely asleep".
8. Retention: events older than configured days pruned on boot.

## Edge cases (bound decisions)

- Commander/monitor agents excluded from their own feed (label filter) — no feedback loops.
- Notification dedupe: `blocked` push notifications suppressed when the existing per-agent attention push already fired for the same permission request.
- Daemon restart: 60s grace; single "host restarted" info event instead of phantom storms.
- Digest rows in the thread render as a collapsed one-line divider ("Fleet digest · N events", expandable) — never raw `<paseo-system>` text. Unknown provider history records (e.g. `credential_pin`) and OMP notices render muted or not at all, never as inline prose.
- Thread auto-follows at bottom; the "N new" pill appears only when the user has scrolled up. Pill uses theme tokens.
- Entering Mission Control restores the exact scroll position you left (bottom-anchored if you left at bottom); no reflow jumps while content loads.
- Archived agents: never archive the Commander from the screen (guard in UI); heartbeats are NOT used anywhere in this design.
- 10 agents blocked at once: one coalesced blocker card listing all, not ten cards.
