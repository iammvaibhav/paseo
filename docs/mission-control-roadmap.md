# Mission Control roadmap

The path from today's implementation to the design in [docs/commander.md](commander.md). Milestones are ordered; tasks within a milestone are parallelizable unless marked. Every milestone ends with the gates green (`npm run format`, `npm run typecheck`, `npm run lint`, `build:server`/`build:client`, targeted vitest) and dev-daemon proof per [docs/agent-driven-development.md](agent-driven-development.md). Production deploys only on explicit approval.

Status legend: `[ ]` not started · `[x]` done · `[~]` in progress.

## M0 — Triage the live incident

The 2026-08-08 failure: the deployed Commander session lacked the `fleet_*` tool catalog ("Tool fleet_create_agent not found") despite a current build-hash label, and the UI said "Spawned agent on local".

- [ ] Reproduce the missing-catalog failure on the dev stack; root-cause why a freshly recreated Commander (fb86a174, created 12:47Z at current HEAD) had no fleet tools at 17:00Z. Suspects: catalog built before labels available, un-restarted daemon serving a stale build, session rebuild path missed on some resume variant.
- [ ] Never render "local" as a host: every spawn/send surface (thread tool badges, feed cards, proposal cards) names the resolved host alias. "local" is only meaningful daemon-side.
- [ ] Failed tool calls in the Commander thread render an expandable payload (what was attempted, on which host) — the incident's spawn was uninspectable.

## M1 — Correctness hardening (staleness + coupling)

Production rules (now in [docs/mission-control.md](mission-control.md#production-rules)): snapshot-at-emit, no live-reads on recorded cards, no shared predicates across unrelated rules, machinery never rewrites user-visible timestamps, client caches reset on reconnect. The audit found these violations:

Live-reads on recorded cards:

- [ ] `proposal-card.tsx:265` — proposal title prefers `liveAgent?.title` over `event.agentTitle`. Render the snapshot; live reads only for the name chip.
- [ ] `feed-card.tsx:300` — agent chip falls back to `liveAgent?.title` when `name` is missing; fall back to `event.agentTitle`.
- [ ] `thread.tsx:434-438` — tool-call badges map agentId → live `agent.title`; snapshot the target identity into the dispatch payload/event.
- [ ] `board.tsx:340,645,655` — Done/Ready/Dormant rows render live `title`/`shortDescription`/`stoppedBy`; snapshot into the lifecycle fold at bucket transition.

Shared predicates:

- [ ] `store.ts:438` + `service.ts:905` — split the self-report rate-limit escape from `wouldCoalesce` into its own predicate (`canBypassSelfReportRateLimit`).
- [ ] `approvals.ts:172` — split `isAskModeAutoSendExempt` into separate `forceSend` (stall nudge) and `allowPairActive` (verifier pair) checks; keep the enumerated test.
- [ ] `naming-backfill.ts:376` — `isSystemWorkspaceName` serves three unrelated decisions (provisioning overwrite, orphan cleanup, backfill exclusion); give each its own predicate.

Machinery-rewritten timestamps:

- [ ] `lifecycle.ts:304` — board age for `done`/`ready` buckets reads `agent.lastActivityAt` (rewritten at restore); use `lastEventAt`/verdict time; live activity only for `running`.
- [ ] `context.ts:254` — roster age falls back to `record.updatedAt` (boot-rewritten); use `lastUserMessageAt` or drop the age.

Client caches on reconnect:

- [ ] `proof-media.ts:35` — module-global media cache never invalidates; scope to host connection or clear on reconnect.
- [ ] `use-aggregated-mission-control-events.ts:133` — `olderEvents` state survives daemon reconnect; reset on offline→online transition.
- [ ] `use-mission-control-lifecycle.ts:59` — `prevRowsRef` deep-equal memo can mask reconnect changes; re-key on reconnect.

Naming immutability:

- [ ] Remove `remapAllNames` (`naming.ts:834`) and its trigger on `namingTheme` patch (`service.ts:100`). Theme changes affect new assignments only. Update the spec bullet in mission-control.md (it currently mandates the re-map — that decision is reversed).
- [ ] Boot backfill (`naming.ts:794`) stays, but assigns only to never-named records — it must never rewrite an existing name.
- [ ] Lock `setAgentName` (`agent-manager.ts:2124`) against renaming an auto-named agent; names are write-once. Titles remain editable.
- [ ] Collision-resistant generation: qualifier + name combinatorial pool (target ≥ 5k combinations per theme) with per-host uniqueness check; keep Roman-numeral suffix as the overflow of last resort.

## M2 — System footprint + the verbose debug gate

- [ ] Move the Commander home to a reserved path (`~/.paseo/commander`) so no user project can claim its cwd (the live collision: a user project at `~` surfaced the Commander). Migration: boot detects the old home-dir workspace and recreates cleanly.
- [ ] One `isSystemOwned` predicate (Commander agent + workspace, verifiers, machinery artifacts), shared by server filters and app surfaces.
- [ ] Verbose OFF hides system-owned everything: sidebar, project lists, history, board buckets, badges, search results. Verbose ON shows all of it, everywhere. No surface implements its own variant of the filter.
- [ ] Workspace-archive UX: an archived agent opened from Mission Control shows an archived banner; "Open in workspace" degrades gracefully (today it dead-ends on a missing-workspace redirect). Cascade itself already exists (`workspace-archive-service.ts:440` archives contained agents).

## M3 — Runtime model: per-turn snapshot

The biggest change. See [docs/commander.md](commander.md#runtime-model-durable-thread-stateless-turns).

- [ ] World-snapshot builder: hot set (hosts+aliases, project/workspace index with descriptions, last-24h agents by bucket, invocable models, routing defaults), stamped with generation time. Reuses the context-pack assembly in `context.ts`, minus the delta machinery.
- [ ] Inject the snapshot per turn (user turns and machinery turns), keeping the system prompt byte-stable for prompt-cache hits.
- [ ] Delete the digest queue → Commander path (`digest.ts` idle-flush into the thread, ack-drop machinery, delta context provider). The feed keeps its events; the Commander stops receiving them as chat.
- [ ] Machinery turns: stall escalations, verdicts, and Auto-mode reactions become triggered turns carrying event + fresh snapshot.
- [ ] Rolling dialogue summary once the thread exceeds a threshold; world state is never summarized (it regenerates).
- [ ] Delete `CommanderAckDrop` and the retraction tracker — with no digest chatter there is nothing to retract.

## M4 — Card grammar

- [ ] Gate every mutating Commander tool through `approvals.createProposal` (today: only `fleet_create_agent` + `fleet_send_prompt`). Auto mode auto-approves; destructive always asks.
- [ ] Proposal card v2: host chip, project new/existing, workspace new/existing, agent new/existing, model, brief. Raw payload behind verbose expansion. Edit → feedback → superseding re-proposal (flow exists; make it the norm for all proposal kinds).
- [ ] Clarification card: options + free-text, rendered from a structured Commander output (a `clarify` tool), so disambiguation is never prose.
- [ ] Answer card: structured fleet answers (agent status: name, host, state, last report, proofs) using feed-card components. Free text stays for unstructured answers.
- [ ] Normal mode renders only cards + answers; narration/thinking/tool internals stay verbose-only (mostly done; close the gaps found in M0).

## M5 — Placement doctrine + meta tools

- [ ] Doctrine in the Commander contract verbatim (the six rules in commander.md), including the `experiments` convention (`~/experiments`, create if missing — exists on iammvaibhav today, not on blrofc3).
- [ ] New daemon RPC: move agent between workspaces (does not exist today). Wire protocol per docs/rpc-namespacing.md.
- [ ] `fleet_meta` tool: rename/archive project·workspace·agent, create project, move agent, promote experiment→project (create project + move workspace/worktree + move agents). All gated.
- [ ] Promotion flow proven end-to-end on the dev stack: experiments workspace → own project, records and worktree intact.

## M6 — Context architecture

- [ ] Run records: assembled deterministically at run end / ready-for-review from brief + report_status history + verdict + proofs. Persisted per agent in the mission-control store.
- [ ] Workspace and project rollups derived from run records; workspace rollup injected into new agents' briefs in that workspace.
- [ ] Paseo fleet memory bank in Hindsight (host, project, workspace, agent tags); write run records on completion. Degrade to unavailable when the Hindsight host is unreachable.
- [ ] `fleet_recall` + `fleet_context` Commander tools; recall consulted for placement matching and "which agent was that".
- [ ] Spawn-brief enrichment: dispatch briefs carry relevant run records/rollups.

## M7 — Commander Voice

See [docs/commander-voice.md](commander-voice.md). Depends on M0 (working Commander) and benefits from M4 cards; can start once M0 lands.

- [ ] Rewire the `gemini-live-speech` proxy into the voice node: four-tool surface (`fleet_status`, `commander_dispatch`, `proposal_respond`, `pending_updates`), `@getpaseo/client` wiring, announce-policy event filter + update buffer.
- [ ] Voice system prompt: relay persona, announce policy, destructive-approval explicit-confirmation rule.
- [ ] Logic harness: headless text-mode driver against the dev daemon asserting tool sequences and daemon effects.
- [ ] E2E audio proof: fish.audio TTS command → Live session → spoken proposal → verbal approval → worker spawned on the dev daemon; captured audio + daemon receipts.

## M8 — Specced, not scheduled

Specs live in commander.md; build on demand:

- One-shot deferred runs ("in three hours") as `maxRuns: 1` schedules behind a dedicated tool.
- Schedules + webhooks CRUD as Commander tools.
- Parallel Commander turns for independent queries (state is externalized; needs thread-append arbitration and per-turn proposal attribution).
- Cross-host answer cards for multi-host questions (fan-out snapshot merge).
