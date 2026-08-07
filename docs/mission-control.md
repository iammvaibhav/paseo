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
  source: z.enum(["system", "summarizer"]),
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

Copy the History Ask contract (`history-ask/launch.ts`): client-first `createAgent` on the **configured Commander host** (screen setting, persisted in app storage; default: the host the user picks first run), labels `{ "paseo.mission-control": "commander" }`, unattended mode, provider/model from orchestration preferences — user can change model later via the normal agent model picker (it is a normal agent). Screen recreates it if archived. Brief in `src/mission-control/brief.ts`:

- You are the Commander. You do not implement work yourself; dispatch via `create_agent`/`fleet_create_agent` with `notifyOnFinish`, closed briefs, and proof conventions (UI → screenshot; service → proxy URL; code → PR + CI status).
- Route: host by project placement / capability (Mac for iOS/desktop) / load; new isolated task → worktree workspace.
- Reference agents ONLY as `[title](paseo://h/{serverId}/agent/{agentId})` markdown links.
- Speak when you add judgment (blocked, diverged, done-with-proof, decision needed). Never narrate what the board shows. Never answer permission prompts — surface them.
- Answer immediately, delegate, reply again when results arrive (digests).

### Settings

Host settings page (`screens/settings/host-page.tsx` + `use-daemon-config.ts` patchConfig): "Mission Control" card — retention days (numeric, default 30), summarizer toggle. Follow docs/forms.md.

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
- Archived agents: never archive the Commander from the screen (guard in UI); heartbeats are NOT used anywhere in this design.
- 10 agents blocked at once: one coalesced blocker card listing all, not ten cards.
