# 03 — Tool contract

## Dual-channel voice results

`scripts/commander-voice/server.js` (`handleToolCalls`, ~365-391) today sends
`functionResponse.response = { result: "<digest string>" }`. Change to:

```json
{
  "spoken": "<digest — what the model says>",
  "data": {
    /* compact typed rows, ids verbatim */
  }
}
```

Errors stay `{ "error": "<one-line reason with candidates>" }`.

Digest shapers in `scripts/commander-voice/lib/daemon.js` become projections:
keep producing `spoken`, additionally emit `data`:

| Tool                               | `data`                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| fleet_list_agents                  | `{agents:[{id, shortId, name, title, description, host, workspaceId, projectId, bucket, lastReport}]}` |
| fleet_list_inventory               | `{hosts:[{host, reachable, projects:[{id, title, workspaces:[{id, title, cwd, kind}]}]}]}`             |
| fleet_search                       | `{matches:[{agentId, host, name, title, snippet}]}`                                                    |
| fleet_recall                       | `{matches:[{text, agentId?, workspaceId?, sessionId?}]}`                                               |
| fleet_context                      | run records with agentId/workspaceId/projectId/serverId verbatim                                       |
| pending_updates / announce buffer  | entries keep `proposalId`, `agentId`, `kind` (daemon.js:269-275 currently strips them)                 |
| fleet_create_agent                 | `{proposalId}` or `{agentId, workspaceId}`                                                             |
| fleet_agent_status / fleet_monitor | see below                                                                                              |

Prompt rule (05): speak `spoken`; take every id from `data`; never speak an id.

## Roster tool — fleet_list_agents

- Rows gain `workspaceId`, `projectId`, `serverId`, `name`, `description`,
  server-computed `bucket` (01). Additive optional fields on
  `AgentListItemPayloadSchema` (`packages/protocol/src/messages.ts:1085-1103`);
  restore what `agent-projections.ts:257-281` drops.
- New optional `bucket` input filter, closed enum
  `needs_you|running|ready|done|idle`.
- `statuses` stays lifecycle-only `initializing|idle|running|error|closed`,
  fully enumerated in every declaration.
- New optional `query` for fuzzy agent-name resolution (same matcher style as
  inventory).

## Resolver — fleet_list_inventory(query)

Output always carries `prj_*`, `wks_*`, `cwd` per workspace (Commander side
already does — `context.ts:109-142`; voice via `data`). Never emit a path as
an id. Declaration: "resolve any spoken project/workspace name before acting;
act only on returned ids."

## Mutations — fail fast, dedupe

`fleet_create_agent` (`paseo-tools.ts:4519-4628`): validate at call time,
before building the proposal — `workspaceId` must be a live `wks_*` on the
resolved host (reject listing candidates: `workspace not found; this project
has: wks_a0fd… 'Experiments'`); `cwd` must be absolute; peer reachability
checked. Reuse `validateSpawnCwd` / workspace resolution currently only at
approval (`spawn-executor.ts:120-158`, `create.ts:411-430`); approval-time
checks stay as the second line.

Dedupe: identical mutation (same tool + normalized args) while the previous is
pending/in-flight → return the existing proposal id with
`guidance: "already pending"`. Applies to fleet_create_agent,
fleet_send_prompt, meta tools. Window: until the prior proposal resolves.

`fleet_send_prompt`: `agentId` must be UUID-shaped; reject titles/`mcp_` ids at
call time with guidance.

## Error contract (every tool)

Every rejection must let the model self-correct in one step: name the
offending field, the expected id family/enum, and live candidates when known.
Required examples (verbatim in tests):

- unknown workspace → list that project's `wks_*` ids + titles
- bad enum → list the full enum
- id-shaped-but-unknown agent → nearest matches + "call fleet_list_agents(query)"
- duplicate mutation → existing `proposalId`
- host-hint mismatch → the actual host

No bare "invalid input".

## New tool — fleet_agent_status

```
fleet_agent_status { agentId, fresh?, host? }
```

One call answers "how is X doing": record identity (name, title, description),
canonical bucket, lastStatus, running-turn info, last report_status
headline/detail/ts, workspaceId/projectId/host. `fresh: true` → steer the
agent with a status-ask (user-invisible envelope, see 06), wait bounded (60s)
for the report event, include it; on timeout return the stale data with
`fresh: false` and a note. This is the only mid-run status mechanism and fires
only on explicit request.

## New tool — fleet_monitor

```
fleet_monitor { action: "start"|"stop"|"status", scope: "fleet"|"agent",
                agentId?, host? }
```

- Session-scoped subscriptions (voice session id or Commander turn context);
  fleet-wide and any number of per-agent watches coexist; independent
  start/stop; `status` lists active subscriptions with ids.
- Passive listeners on the existing `mission_control_event` broadcast — zero
  polling, never blocks conversation. Voice announcements inject as system
  turns between utterances; while the user is mid-turn they queue in the
  announce buffer (id-carrying) and drain at the next boundary.
- Announce policy:

| Event                                                 | Announce                                 |
| ----------------------------------------------------- | ---------------------------------------- |
| proposal / clarification                              | always (independent of monitor)          |
| blocked, error/failed                                 | monitored scope → one line               |
| finished (→ ready)                                    | monitored scope → title + final headline |
| started / tool calls / token stream / working reports | never                                    |
| mid-run milestone reports                             | P3, parked                               |

## Declaration hygiene

- Voice `post_answer` declares `agentId` + `fields` + `respondsTo`
  (executor already forwards — `tools.js:317-321` vs `paseo-tools.ts:5472`).
- `clarify` declares `allowFreeText`.
- Every enum fully enumerated; no "running, idle, …" prose ellipses.
- Voice and Commander declarations are generated from or verified against the
  same source of truth; a drift test asserts declaration parity per tool.
