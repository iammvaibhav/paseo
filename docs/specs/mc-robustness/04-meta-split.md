# 04 — fleet_meta split

`fleet_meta`'s 11-action `metaPlan` overloads `targetId`/`destination`
(`destination` = `wks_*` for move_agent but a filesystem path for
create_project). Split into 11 tools with flat, fully-typed schemas. All keep
the same approval gate (destructive always asks). Internally each builds the
same `metaPlan` proposal payload — zero protocol change; app proposal cards
render unchanged; peer apply path (`mission_control.meta.apply`) unchanged.

| Tool                       | Schema                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `fleet_rename_project`     | `{projectId: prj_*, title, host?}`                                              |
| `fleet_rename_workspace`   | `{workspaceId: wks_*, title, host?}`                                            |
| `fleet_rename_agent_title` | `{agentId: uuid, title, host?}`                                                 |
| `fleet_archive_project`    | `{projectId, host?}`                                                            |
| `fleet_archive_workspace`  | `{workspaceId, host?}`                                                          |
| `fleet_archive_agent`      | `{agentId, host?}`                                                              |
| `fleet_create_project`     | `{host, path: absolute, title?}` (host required — new path must land somewhere) |
| `fleet_move_agent`         | `{agentId, workspaceId: wks_*, host?}`                                          |
| `fleet_promote_workspace`  | `{workspaceId, host?}`                                                          |
| `fleet_adopt_agent`        | `{agentId, host?}`                                                              |
| `fleet_release_agent`      | `{agentId, host?}`                                                              |

- Bare ids resolve through the fleet id index (02); `host` optional hint
  except create_project.
- Call-time validation: id family shape + existence via index; helpful errors
  with candidates (03).
- `respondsTo?` on all.
- Output: `{ok, status: "pending"|"sent", proposalId?, guidance?}` — same as
  today's fleet_meta.

Cutover: remove `fleet_meta` from `COMMANDER_TOOL_ALLOWLIST`
(`commander-contract.ts:53-68`) and voice declarations in the same change.
Keep the MCP-exposed `fleet_meta` tool itself as a
`// COMPAT(fleet-meta-alias): remove after 2026-10-01` alias for external
callers, delegating to the same internals.

Voice declares **all 11** (parity with Commander). The burn-in bench (08)
includes a meta case (rename + move by spoken name); prune voice declarations
only if the bench shows selection errors.
