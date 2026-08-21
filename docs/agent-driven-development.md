# Agent-driven development

Agent-driven development is a division of labor between models. The orchestrator is an expensive model that does the thinking — decomposition, product judgment, trust decisions, auditing evidence — and delegates every mechanical task to cheap subagents (deepseek-v4-flash via the omp `task` tool, for example). The orchestrator stays in control and never grinds through mechanical work itself. The pattern that ran through the whole Mission Control project: implement in slices → a verifier subagent proves each slice with a proof contract → the orchestrator audits the evidence and fixes what fails. See [docs/mission-control.md](mission-control.md) for how this takes shape in the fleet.

## Roles

| Role              | Does                                                                                                                    | Never does                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Orchestrator      | Thinks: decomposes the work, judges the product, decides what to trust, audits evidence. Runs the gates once per phase. | Grinds through mechanical work itself.           |
| Worker subagent   | Implements a closed brief: target files, exact change, acceptance.                                                      | Explores open-endedly; runs gates or formatters. |
| Verifier subagent | Proves the work against a proof contract and returns evidence.                                                          | Implements, investigates, or re-runs the work.   |
| Scout subagent    | Read-only recon; returns compressed findings.                                                                           | Edits anything.                                  |

## Briefs

Subagents share no conversation context — every brief is self-contained. A brief has four parts:

- **Target** — the files and symbols the slice touches, plus explicit non-goals.
- **Change** — the exact work: add, remove, rename; the APIs and patterns to use.
- **Acceptance** — the observable result that makes the slice done. This is what the verifier audits against, so write it as something checkable.
- **Context** — the decisions the slice needs: formats, schemas, interfaces.

Workers get closed briefs and stay in them. Open-ended exploration and gate runs are the orchestrator's job, not the worker's.

## Proof contracts

Verification returns evidence the orchestrator can audit, never a summary:

- Screenshots at agreed paths (`/tmp/mc-verify*/`)
- Daemon-log receipts — the exact grep lines
- JSONL rows
- Exit codes

The orchestrator audits the evidence rather than re-doing the verification.

Unit tests alone are not proof. One Mission Control bug — verifier-tool wiring — passed its tests twice while broken live. Wiring bugs need live-fixture proof: a real daemon, a real browser, real rows in a store.

## The dev stack

The dev stack is checkout-local and never touches production.

|        | Dev daemon                                             | Production daemon    |
| ------ | ------------------------------------------------------ | -------------------- |
| Port   | 6768                                                   | 6767                 |
| Home   | `.dev/paseo-home` (checkout-local)                     | `~/.paseo`           |
| Web UI | Metro on `http://localhost:8081` (password vaibhav123) | Packaged desktop app |

Never restart the 6767 daemon without permission. It manages all agents, and restarting it kills the orchestrating agent's own process.

Run the dev daemon and Metro as supervised background processes (hub-managed: `mc-dev-daemon`, `mc-dev-app`) so they can be bounced together with the dev home env: `PASEO_HOME=/Users/vaibhav/paseo/.dev/paseo-home`.

Metro needs cache clears after big app changes:

```bash
rm -rf node_modules/.cache/metro packages/app/node_modules/.cache
```

Full setup lives in [docs/development.md](development.md).

## Test fixtures

Spawn test agents with cheap models only — never a big model for verification:

```bash
env -u PASEO_AGENT_ID PASEO_HOME=/Users/vaibhav/paseo/.dev/paseo-home \
  npm run cli --silent -- run --provider omp --model google-antigravity/gemini-3.6-flash \
  'You are a test fixture: <task>'
```

`env -u PASEO_AGENT_ID` keeps the caller's own agent id out of the spawn.

Name fixtures for what they test — watchdog-fixture, stall sleepers, "Reply OK" probes. Archive them after the test.

For UI input, Paseo's `browser_*` tab tools proved unreliable for RN-web; use `xd://browser` (puppeteer-backed headless Chromium) against `http://localhost:8081`. Delegate browser verification to verifier subagents with a proof contract — they drive the browser and return screenshots plus daemon-log receipts, and the orchestrator audits the proofs.

Fixtures that proved the system:

- Stall ladder — spawn a sleeper → silence nudge at 120s → escalate card at 300s → approve via client script → agent resurrects and finishes
- Watchdog — find the fixture's omp child pid (lsof on its session handle), `kill -9` → ~2.5 min → self-heal to error + recovery proposal → approve → resurrect
- Paging — seed >200 events, verify server-side cursor pagination (no overlap)
- Verifier loop — worker → ready-for-review → verifier spawns → contact_worker → approve → worker replies → re-audit → verdict
- Boot adoption — proved post-deploy on production: a run predating the daemon got its first stall nudge under the new pid

## The forensic layer

Grep the dev state files to verify backend behavior:

- `.dev/paseo-home/daemon.log` — stall lines (`component:"stall"`), approvals, watchdog heal, digest flush/ack_drop
- `.dev/paseo-home/mission-control/events.jsonl` — the feed store; jq filters by agentId/kind confirm cards
- `.dev/paseo-home/mission-control/proposals.jsonl`, `review-state.json`, `central-config.json`
- `.dev/paseo-home/agents/*/<id>.json` — agent records: status, labels, config, persistence handle
- omp session files (`~/.omp/agent/sessions/...`) — what the agent actually did

## Client RPC scripts

The eval sandbox hangs on WebSocket handshakes. For approving proposals, calling RPCs, or patching central config, write a real node script using `DaemonClient` from `@getpaseo/client` plus `ws`, with `clientId` and `ws://127.0.0.1:6768/ws` and the dev password. Write it as `.tmp.mjs` in `scripts/`, run with `node --import tsx`, and delete it after.

## Traps

- **Config-edit-then-bounce.** The daemon reads config at boot and writes its cached value back on later patches. Change config by jq-writing `.dev/paseo-home/config.json`, then bounce the dev daemon. Central config has the same trap — a dev-fleet setting once went to the wrong fleet this way.
- **Worktree baseline.** Prove pre-existing test failures by re-running the identical tests against HEAD in a throwaway git worktree — never assume.
- **PASEO_AGENT_ID leak.** Without `env -u PASEO_AGENT_ID`, the caller's agent id flows into spawned fixtures and contaminates what you're testing.

## Phase discipline

The orchestrator runs the gates once per phase — format, typecheck, lint, build — never per subagent, and workers never run them at all:

```bash
npm run format
npm run typecheck
npm run lint
npm run build:server
npm run build:client
```

Run only the tests you changed: `npx vitest run <file> --bail=1`. A broad run must be piped to a file and read afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1`. Full suites go to CI. The rules live in [docs/testing.md](testing.md) and the evidence bar in [docs/qa.md](qa.md).
