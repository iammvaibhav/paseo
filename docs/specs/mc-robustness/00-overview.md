# Mission Control robustness — overview

Spec set for the Mission Control / Commander / Voice robustness overhaul. Every
implementation slice references these files. Numbers pin cross-slice contracts;
do not change a contract without updating every spec that names it.

## The invariant

A model may only pass values it received verbatim — from a tool result or from
the user. Therefore:

1. Every tool result carries the typed ids of every entity it names.
2. Every input schema enumerates its full vocabulary (closed enums, id
   families named with their source tool).
3. Every mutation validates its references at call time.
4. Every repeated mutation is deduplicated.
5. Every rejection lets the model self-correct in one step (see error
   contract, 03).

## Id families (contract vocabulary)

| Noun      | Family               | Scope          |
| --------- | -------------------- | -------------- |
| Host      | peer name or `local` | fleet          |
| Project   | `prj_` + 16 hex      | fleet-unique   |
| Workspace | `wks_` + 16 hex      | fleet-unique   |
| Agent     | UUID                 | fleet-unique   |
| Proposal  | `mcp_` + ULID        | commander host |

Ids are fleet-wide. Tools address entities by bare id; `host` is an optional
hint, never a required routing key (see 02).

## Locked decisions

| Decision                        | Value                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| Voice id flow                   | Dual channel `{spoken, data}`; ids never spoken                                           |
| Name→id resolution              | `fleet_list_inventory(query)` is the resolver; no new tool                                |
| fleet_meta                      | Full split into 11 per-action tools (04)                                                  |
| Voice/Commander parity          | Identical catalog, schemas, id semantics; voice declares all tools                        |
| Monitoring                      | `fleet_monitor`, opt-in per session, fleet + per-agent scopes, non-blocking               |
| Ready aging                     | Auto → Done after 3 days (config `readyAgeOutDays`)                                       |
| Blocked/stalled routing         | Board + announce; chat only when a decision card attaches                                 |
| Status nudges                   | Terminal-state guarantee only; zero automatic mid-run nudges; nudge prompt user-invisible |
| Title                           | Written once, then frozen; only `fleet_rename_agent_title` changes it                     |
| Description                     | Living; expected on every report_status                                                   |
| Voice instruction ledger        | P0                                                                                        |
| Direct-mode default             | Only after burn-in bench green 5 consecutive runs                                         |
| Mid-run milestone announcements | P3, parked (prompt-only reporting is unreliable; must be hook-driven)                     |

## Spec files

| File                   | Owns                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| 01-lifecycle-bucket.md | Canonical bucket, daemon state machine, aging, audit                                               |
| 02-fleet-id-index.md   | Commander-host id→host index, bare-id tool signatures                                              |
| 03-tool-contract.md    | Dual channel, roster/resolver output, fail-fast, dedupe, errors, fleet_agent_status, fleet_monitor |
| 04-meta-split.md       | The 11 meta tools                                                                                  |
| 05-voice.md            | Voice node dual channel, instruction ledger, system prompt                                         |
| 06-identity-status.md  | Title/description guarantees, terminal-state report hook                                           |
| 07-chat-routing.md     | Machinery-turn gate, thread classification, board UI changes                                       |
| 08-testing.md          | 3-daemon fleet integration harness, voice scenario tests, UI sanity                                |

## Rules for implementers

- Protocol stays backward-compatible: new wire fields optional; never narrow,
  never remove, never require. Wire schemas pure (no transform/catch).
- Every temporary shim carries `// COMPAT(name): added in vX, remove after <date>`.
- Do not run project-wide suites; run only the specific test files you add or
  change (`npx vitest run <file> --bail=1`). Final gates (format, lint, full
  typecheck) run once at integration, not per slice.
- Never `npm install` in a worktree.
- Rebuild owning stacks (`npm run build:client` / `npm run build:server`)
  before diagnosing cross-package type errors.
