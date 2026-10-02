# itsaplan + workspace-model rollout — working plan

Working plan for the remaining implementation and the E2E test campaign. Delete this file when the campaign is done; durable decisions live in `docs/adr/0001-worktree-per-dispatch.md` and `docs/adr/0002-itsaplan-two-state-machines.md`.

## Status

**Done, committed or staged on `golden-squirrel`:** house skill library + deploy sync; commander brief doctrine (+ model tiering, PR policy, presupposition rule); base workspaces (server + protocol + sidebar UI, 4/4 browser-verified); base-checkout sync contract (fetch loop, 3s dispatch fetch, `origin/<default>` cut — E2E-proven against a stale local main); verifier config gate (off by default); per-project PR opt-in (config → snapshot → prompt); agent profiles in the Commander snapshot; itsaplan bridge core (webhook ingress, todo→Commander dispatch prompt, In Progress/Ready-to-review/needs-you projections, project auto-create + backfill, reconcile sweep; 40 tests green).

**Fixed today during E2E bring-up:** itsaplan ignores client-supplied webhook secrets — the bridge now reads back the generated `whsec_*` per project, stores it in the mapping, and verifies against all known secrets; projects rooted inside `paseoHome` (the Commander's reserved home) are never synced to itsaplan.

**Done this session (not yet committed):** needs-you loop (question comment + ticket reply + convergence, independently 57/57 then 77/77 after wave 2); Plannotator `review --git` routing for working_diff clicks (session-manager 4/4, open-file 16/16); All-tickets board inside `/tmp/itsaplan` (`GET /issues`, `/tickets`); ticketize (`fleet_ticketize_agent` / `itsaplan_ticketize`, now on COMMANDER_TOOL_ALLOWLIST); auto-chain label + Done-release of dependents; @commander mention-run drain (`/agent-runs/claim`, `triggerOnMention: true`). Independently verified: `npx vitest run src/server/itsaplan` 77/77; commander-boot allowlist pin + itsaplan 124/124.

**Still remaining:** S1–S14 E2E campaign on the live stack; repo-wide `lint`/`format`/`typecheck`/`build:server` then one commit; optional §7 (PR-policy toggle UI, base-workspace flicker). The `/tmp/itsaplan` All-tickets work is **not** in this Paseo worktree — it lives in the E2E itsaplan checkout and needs its own fork commit/push. The GlobalBoard worker recreated the itsaplan DB; `/tmp/itsaplan-e2e/credentials.json` API key is stale against the live :3000.

## Session handoff (2026-08-25, model switch)

- Branch `golden-squirrel`, worktree `/home/ubuntu/.paseo/worktrees/0gg9u7hf/golden-squirrel`. Two commits pushed nowhere: `14f37e8f0` (skills/ADRs/prompt/deploy-sync) and `9d8078bff` (upstream merge). The ENTIRE implementation wave sits UNCOMMITTED on top (server+protocol+app+itsaplan, ~50 files) — intentionally, per "one commit at the end". Repo-wide gates were green before the chat-runner slice; re-run `pnpm run lint && pnpm run format && pnpm run typecheck` (and `pnpm run build:server`) before committing.
- This worktree resolves `@getpaseo/*` via local symlink farms at `packages/node_modules/@getpaseo` and `plugin-examples/node_modules/@getpaseo` (git-ignored) because the shared source-checkout node_modules predates the upstream merge. Do not remove them; rebuild `-w @getpaseo/protocol` after protocol edits.
- Live E2E stack (hub-managed, project-scoped): `itsaplan-db` :5432, `itsaplan-api` :3000, `itsaplan-web` :3001, `itsaplan-worker`, `ui-daemon` :6969 (`PASEO_HOME=/tmp/paseo-ui-home`). itsaplan checkout: `/tmp/itsaplan`. Credentials: `/tmp/itsaplan-e2e/credentials.json` (human user id `oOhiRRtPsFeccmvk5LM9UwYYI9CB1PZd`). Seed scripts in-repo (delete before commit): `packages/server/src/server/ui-smoke-seed.script.ts`, `e2e-itsaplan-seed.script.ts`.
- HARD RULES: never touch ports 6767/6768 or `~/.paseo`; the shell env leaks `PASEO_HOME=/home/ubuntu/.paseo` — set it explicitly on every spawned process; keep ≥1.5G disk free (the 6767 daemon crashed on ENOSPC earlier today and auto-recovered).
- Deliverable contract: one commit on this branch, end-to-end tested, then ask the user to deploy via `./scripts/deploy.sh`.

**Live E2E stack (hub processes):** `itsaplan-db` (postgres:17-alpine, :5432), `itsaplan-api` (:3000), `itsaplan-web` (:3001), `itsaplan-worker`, `ui-daemon` (Paseo, :6969, `PASEO_HOME=/tmp/paseo-ui-home`). Admin user `vaibhav` (id `oOhiRRtPsFeccmvk5LM9UwYYI9CB1PZd`); secrets in `/tmp/itsaplan-e2e/credentials.json`. Commander booted on claude/claude-opus-5. Never touch ports 6767/6768; every spawned process sets `PASEO_HOME` explicitly.

## Remaining implementation

### 1. Needs-you loop: question surfacing + reply + convergence

The forward flip alone is half a loop. The full loop, all of it projected from agent state (the single truth owner):

- **Question as a comment.** On needs_you, the bridge posts the agent's actual pending question (blocked-report headline/detail or pending clarify text) as a ticket comment, then flips the assignee to the human. The question is readable where it will be answered.
- **Ticket reply path.** Subscribe `comment.created` (extend `ITSAPLAN_WEBHOOK_EVENTS`; re-register/patch existing webhooks on boot when the event set differs). A comment authored by `humanUserId` on a ticket whose labeled agent is still in needs_you at delivery time → steer the comment text into the waiting agent. The comment itself is the record; nothing is duplicated.
- **Convergence on resolution (both surfaces, one record).** When the agent's bucket leaves needs_you — whatever caused it — the bridge posts one comment: "Resumed — answered via ticket comment" or "Resumed — answered directly in Paseo", and flips the assignee back (Commander bot identity once registered; unassigned until then). Answering in the app and answering on the ticket cannot diverge because neither surface owns the state; the agent does.
- **Late replies.** A ticket comment arriving after the agent already resumed is not steered; the convergence comment above already explains why.
- Tests: question comment posted once per needs_you entry; steer delivered exactly once and only while waiting; non-human comments ignored; direct-answer convergence comment; late-reply inertness.

### 2. Global Ticket Board — inside itsaplan (fork)

Decision (user): the one-board-for-all-tickets view lives in itsaplan itself; Mission Control stays exactly as it is. itsaplan has no cross-project view anywhere (views are hard project-scoped; the inbox is the only cross-project surface and it aggregates notifications), so this means a fork:

- `vaibhav/itsaplan` fork, same maintenance pattern as the paseo fork (custom branch, periodic upstream merges). The E2E stack's /tmp/itsaplan clone becomes the working checkout.
- Add a global "All tickets" view: board grouped by column (by `stateType` across projects), each card carrying a project chip; same filters/layouts machinery the per-project views use where reusable.
- Candidate for an upstream PR — it is a generally useful feature, and upstreaming shrinks the fork.
- Paseo-side work: none.

### 3. Plannotator — integrate, never rebuild

Plannotator already has walk-me-through and PR review. The only integration gap: clicking a diff opens the side panel today; it should open Plannotator. One change — a diff-open routing preference (alongside the existing `openInSidePane` preference family) that routes diff opens to an embedded Plannotator session (`docs/plannotator.md` spawn machinery). Everything else is Plannotator's own surface, reached because we stop routing around it.

### 4. Commander as a ticket participant (chat runner follow-ups)

You tag the bot, the bot answers there:

- `@commander` mention on a ticket → the Commander replies as a comment under its own bot identity (mention-run claiming; the in-flight runner slice reports whether this shares the chat claim loop).
- 1:1 chat panel with the Commander in itsaplan's UI (the runner slice's core).
- Bridge comments ("Dispatched…", proofs, needs-you questions) authored as the bot instead of as the human API key, where itsaplan authorizes the agent key for those endpoints.

### 5. Ticketize verb

"Ticketize this agent": Commander doctrine + a small bridge helper — creates an itsaplan ticket from a running agent's brief/description, labels the agent `itsaplan.issue=<id>`, posts the deep-link comment. Ticket lands per current agent state (running → In Progress).

### 6. auto-chain label

Verify what the bridge does today when a blocking ticket reaches Done (dependents re-evaluated?); then implement the `auto-chain` opt-in: a source ticket carrying the label fires its dependents at Ready-to-review instead of Done.

### 7. Small / optional

- PR-policy toggle in project settings UI (today: central-config only).
- Transient base-workspace flicker before feature-flag settle (UIVerifier caveat) — investigate ordering of `server_info.features` vs project payloads in the client.

## E2E test campaign (sequential, one browser, shared stack)

Each scenario: PASS/FAIL + screenshot + API/log evidence. Runner agents execute in order; a scenario's tickets are its own (never reuse another scenario's).

| #   | Scenario                                                                                                                                                                                                                                                    | Expected evidence                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| S1  | Paseo project add → itsaplan project auto-created, webhook registered with readback secret; itsaplan-native project stays non-dispatching                                                                                                                   | REST project + webhook JSON; mapping file contains `webhookSecret` |
| S2  | Ticket Backlog→Todo in itsaplan UI → Commander machinery prompt → worker spawned with `itsaplan.issue` label in the right repo → ticket In Progress + deep-link comment                                                                                     | daemon.log, agent labels, ticket timeline screenshot               |
| S3  | Worker `report_status completed` with proofs → Ready-to-review column lazily created, ticket moved, proofs comment                                                                                                                                          | ticket screenshot + columns REST                                   |
| S4  | Worker needs input → agent's question posted as a ticket comment, assignee flips to vaibhav, inbox row appears                                                                                                                                              | ticket timeline + inbox screenshots                                |
| S5  | Needs-you loop (after item 1): (a) vaibhav answers via ticket comment → agent steered, "Resumed — answered via ticket comment" + assignee back; (b) vaibhav answers directly in Paseo → "Resumed — answered directly in Paseo" comment converges the ticket | agent transcript + ticket timeline, both branches                  |
| S6  | B `blocks`-linked to A, both Todo → B held; A→Done → B dispatches                                                                                                                                                                                           | delivery log + second agent exists                                 |
| S7  | Backlog ticket never dispatches; webhook deliveries all 2xx after the secret fix                                                                                                                                                                            | itsaplan deliveries REST                                           |
| S8  | Reconcile: manually drag a projected ticket to a wrong column → 60s sweep re-projects it                                                                                                                                                                    | before/after column via REST                                       |
| S9  | Chat (after runner lands): 1:1 chat with Commander in itsaplan UI → real routed reply                                                                                                                                                                       | chat screenshot                                                    |
| S10 | `@commander` mention on a ticket → agent_run claimed → reply comment                                                                                                                                                                                        | ticket timeline                                                    |
| S11 | Global board (after item 2, itsaplan fork): "All tickets" view shows every project's tickets grouped by column with project chips                                                                                                                           | itsaplan UI screenshot                                             |
| S12 | Plannotator (after item 3): clicking a diff opens Plannotator instead of the side panel; walk-me-through and PR review reachable from there (Plannotator-native)                                                                                            | app screenshots                                                    |
| S13 | auto-chain label: labeled source fires dependent at Ready-to-review; unlabeled fires at Done                                                                                                                                                                | delivery log timing                                                |
| S14 | Base-workspace UI regression re-run (S10 of the old plan) after all changes                                                                                                                                                                                 | 4 checks re-verified                                               |

## Constraints

Disk ≥1.5G free before builds; 6767/6768 untouchable; explicit `PASEO_HOME` everywhere; targeted tests only until final gates; every scenario's processes via hub with stable names.
