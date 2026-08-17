# 02 — Fleet id index (commander host)

## Principle

Ids are fleet-wide. The commander host peers with every other host, so it
maintains the lookup `id → host` and never hops to another machine to resolve
an id. Tools accept bare ids; `host` is an optional hint.

## Index

New module `packages/server/src/server/mission-control/fleet-id-index.ts`:

- Maintained on the commander host (the daemon whose
  `centralConfig.commanderHost` names itself; every daemon may maintain one —
  it is cheap — but the commander host is the authoritative consumer).
- Sources, in order of freshness:
  1. Local registries (agents, workspace/project registry) — live.
  2. Peer inventory/roster snapshots already fetched for the world snapshot
     and `fleet_list_inventory`/`fleet_list_agents` (reuse those code paths;
     do not add a new polling loop). Cache entries carry the peer name +
     fetchedAt.
- API:

```ts
resolveFleetId(id: string): Promise<
  | { kind: "agent" | "workspace" | "project" | "proposal"; host: string }
  | { kind: "unknown"; guidance: string }>;
```

- Miss handling: refresh the peer caches once, retry, then return `unknown`
  with guidance that lists reachable hosts and names unreachable ones:
  `"agent 2b89… not found on any reachable host (blrofc3 unreachable — it may
live there). Call fleet_list_agents to resolve."`

## Tool signature changes (paseo-tools.ts)

Every id-taking fleet tool accepts the bare id; `host` optional:

- `fleet_send_prompt { agentId, prompt, mode?, respondsTo?, host? }`
- `fleet_get_agent_activity { agentId, limit?, host? }`
- `fleet_agent_status { agentId, fresh?, host? }` (new, see 03)
- `fleet_monitor { action, scope, agentId?, host? }` (new, see 03)
- All 11 meta tools (04)
- `fleet_context` already takes bare ids — route via index too.

Resolution order: explicit `host` if given (validate the id actually lives
there; mismatch → helpful error naming the actual host), else index.

`fleet_create_agent`: `workspaceId` present → host derived from the workspace
via the index (`host` may be omitted). No placement → `host` required (a new
worktree must land somewhere). Exactly these two shapes; declaration text says
so.

Declarations (Commander + voice, identical): describe ids as fleet-wide, e.g.
`agentId: agent UUID from fleet_list_agents/fleet_search data — fleet-wide,
no host needed`.

## Non-goals

- No new polling/replication protocol. The index is a cache over data the
  commander host already pulls.
- No uniqueness enforcement changes; `wks_`/`prj_`/UUID are already
  collision-free in practice. On a genuine duplicate across hosts (should not
  happen), prefer local, log a warning.

## Tests

- Unit: resolution order (local beats cache), miss → refresh → unknown
  guidance text, host-hint mismatch error.
- Integration (see 08): 3-daemon fleet — resolve an agent living on peer B by
  bare id from commander host A; send prompt without host; meta rename by
  bare id; unreachable-peer guidance when B is stopped.
