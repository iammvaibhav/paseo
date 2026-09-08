# Verification

Verification proves a change against an isolated Paseo stack before landing code or reporting done. Every pull request and worker dispatch must produce verifiable evidence matching the change shape.

Three files split the knowledge: this doc owns the architecture and the decision matrix; `.agents/skills/verification` is what a worker loads; the root `COMMANDER.md` is what the Commander reads when it dispatches for this project (tiers, proofs to demand, live-environment rule). The Commander's system prompt (`packages/server/src/server/mission-control/commander-prompt.md`) is fleet-wide and stays free of Paseo-specific proof shapes; it defers to a project's instructions.

## The ladder

Cheapest first:

1. **Daemon RPC / CLI assertion (`daemon`).** Assert over WebSocket RPCs (`@getpaseo/client`), loopback HTTP endpoints, or CLI commands. Fast (~100ms per check), deterministic.
2. **Browser UI drive (`ui`).** Drive headless Chromium via Playwright against the real web UI. Use when verifying DOM state, navigation, form inputs, or component interactions.
3. **Cross-host fleet (`fleet`).** Start two peered daemons (`hosts: 2`) to assert multi-host coordination, event forwarding, agent lifecycle across peers, and central config sync.

Video recording and narration are orthogonal to tier: set `video: true` in check metadata or run with `--video` or `--proof` to capture browser interactions, burn in step captions and offline TTS narration, and assemble `proof.mp4` with before/after stills.

If a change is verifiable at the daemon layer, verify it there. Reserve browser driving and video proofs for UI surfaces.

## The mock fleet

Bring up an isolated, throwaway stack:

```bash
node scripts/verify/stack.mjs up [--peer] [--reachable] [--no-password] [--no-itsaplan] [--no-commander] [--no-code-server]
```

What `up` provisions by default:

- **Isolated `PASEO_HOME`.** Scratch state lives under `.dev/verify/<runId>/hosts/<name>`.
- **Ephemeral ports.** Starts via `packages/server/dist/scripts/supervisor-entrypoint.js` with `PASEO_LISTEN=127.0.0.1:0` (or VPN IP with `--reachable`). The OS selects an unused port. Runs never collide with port 6767 (production), 6768 (dev), or other agents' parallel stacks.
- **Daemon password.** A random 24-hex string per run (`stack.password`). Authentication is enabled: loopback and external connections require bearer authentication, granting full owner permissions.
- **Commander boot designation.** Configured on the `commander` host via `central-config.json` (`commanderHost: "commander"`). The model is read from `~/.omp/agent/config.yml` under `modelRoles.task` with the trailing `:tier` stripped (e.g. `google-antigravity/gemini-3.8-flash:high` becomes `omp/google-antigravity/gemini-3.8-flash`; fallback `omp/google-antigravity/gemini-3.8-flash`). Both `commanderModel` and `verifierModel` use this model.
- **itsaplan bridge.** Connected to the local itsaplan service (`http://127.0.0.1:3000`). Admin apiKey and webhookSecret are read from `~/.paseo/mission-control/central-config.json` at `up` time and written only into the mock stack's private `central-config.json` (`0700` run directory; never printed or logged).
- **Skills home (`PASEO_SKILLS_HOME`).** Set to `<runDir>/home`. Mock daemons receive `PASEO_SKILLS_HOME=<skillsHome>` so orchestration-skills sync writes there instead of your real `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`.
- **Fixture repo (`fixtureRepo`).** `<runDir>/fixture`, a real `git init` repository with one commit and remote `origin https://github.com/paseo-verify/fixture.git` (no network required). Its Paseo project key is `remote:github.com/paseo-verify/fixture`, identical across every run, worktree, and host.
- **Durable proofs directory (`proofDir`).** `~/.paseo/verify-proofs/<worktreeBasename>/<runId>/`, created at `up`. Holds final video, screenshots, and result metadata that survive worktree cleaning or archiving.
- **Web UI.** Serves the prebuilt web UI bundle (`packages/server/dist/server/web-ui`).
- **code-server (`codeServer`).** Discovered, never spawned: `up` parses `bind-addr` from the shared `~/.config/code-server/config.yaml` and probes it concurrently with the daemon health wait, so it never adds to boot time. `stack.codeServer` is `{ url, bindAddr, shared: true, healthy }`, or `null` when code-server is not configured on this host. `--no-code-server` forces it `null`. When healthy, `run.mjs` seeds the Playwright daemon registry's host profile with `browserEditorUrl: stack.codeServer.url` and prints the URL for pasting into Settings on the Mac.

Flags to disable provisions:

- `--no-password`: Sets `auth: "none"` and `password: null`. Use when verifying unauthenticated loopback behavior, testing legacy clients, or testing without bearer token auth.
- `--no-itsaplan`: Sets `itsaplan: null` and disables bridge initialization. Use when running in environments without itsaplan running at `127.0.0.1:3000`, when running offline, or when testing agent operations that do not touch issue sync.
- `--no-commander`: Sets `commander: { enabled: false }` and omits Commander designation from `central-config.json`. Use when testing pure agent RPCs or running checks without the overhead of booting an agent on Commander startup.
- `--no-code-server`: Sets `codeServer: null`. Use when the host has no code-server installed or a check must not depend on it.

Stack details are written to `.dev/verify/<runId>/stack.json`:

```json
{
  "runId": "v-1a2b3c4d",
  "createdAt": "2026-09-08T09:00:00.000Z",
  "worktree": "/abs/worktree",
  "runDir": "/abs/worktree/.dev/verify/v-1a2b3c4d",
  "artifactsDir": "/abs/worktree/artifacts/verify/v-1a2b3c4d",
  "proofDir": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d",
  "webUiDistDir": "/abs/path/to/web-ui",
  "password": "0123456789abcdef01234567",
  "commanderModel": "omp/google-antigravity/gemini-3.8-flash",
  "commander": { "enabled": true },
  "reachable": null,
  "fixtureRepo": "/abs/worktree/.dev/verify/v-1a2b3c4d/fixture",
  "itsaplan": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:3000",
    "paseoProjectKey": "remote:github.com/paseo-verify/fixture",
    "commanderUsername": "verify-v-1a2b3c4d"
  },
  "codeServer": {
    "url": "http://10.7.0.1:8765",
    "bindAddr": "10.7.0.1:8765",
    "shared": true,
    "healthy": true
  },
  "hosts": [
    {
      "name": "commander",
      "role": "commander",
      "home": "/abs/.../hosts/commander",
      "port": 41234,
      "httpUrl": "http://127.0.0.1:41234",
      "wsUrl": "ws://127.0.0.1:41234/ws",
      "pid": 1234,
      "logFile": "/abs/.../hosts/commander/daemon.log",
      "bootMs": 1980
    }
  ],
  "peered": false
}
```

Stop the stack when done:

```bash
node scripts/verify/stack.mjs down <runId>
```

## The itsaplan sharing contract

The real itsaplan bridge code runs unmodified. Because every non-internal Paseo project on the sync host gets an itsaplan project (`itsaplan/projects.ts` `ensureItsaplanProjectMapping` on project upsert) and itsaplan has no project-delete route, mock fleets must all map to one itsaplan project: the fixture repo.

- **Project key:** The fixture repo at `<runDir>/fixture` is initialized with `git remote add origin https://github.com/paseo-verify/fixture.git`. Its project key is `remote:github.com/paseo-verify/fixture`. The first test fleet creates the project via bridge `createProject`; subsequent fleets adopt the existing project via the bridge's 409 conflict handler (`getProject`), which matches the `paseoProjectKey` stamped in the description.
- **Per-run resources:** Each run creates one webhook (whose callback URL contains the mock daemon's ephemeral port) and one Commander bot user named `verify-<runId>` (configured via `itsaplan.commanderUsername`; default is `commander`).
- **Issue namespacing:** Checks that create issues in itsaplan must prefix issue titles with `[<runId>]` (e.g. `[v-1a2b3c4d] Test ticket`).
- **Teardown on `down`:** `node scripts/verify/stack.mjs down <runId>` cleans up itsaplan resources created for that run:
  1. Deletes the run's webhook via `DELETE /webhooks/:id`.
  2. Deletes the run's AI agent via the project-scoped agent deletion route (`/projects/:key/agents/:id` in itsaplan).
  3. Bulk-archives all issues titled with this run ID via `POST /projects/:key/issues/bulk/archive`.
- **Sweep:** `node scripts/verify/stack.mjs sweep` reaps orphaned resources: any `verify-*` AI agent, any webhook targeting a dead port, and any `[v-` issue older than 1 day.
- **Internal workspaces:** Workspaces created under `ctx.host().home` reside inside `PASEO_HOME`. The bridge identifies these via `isPaseoInternalProject` and skips syncing them to itsaplan. This is why standard checks create internal workspaces without affecting itsaplan; only workspaces explicitly created under `fixtureRepo` reach itsaplan.
- **Shared, never spawned:** itsaplan and code-server are both per-host, project- or folder-scoped, and heavy; a mock reuses the host's instance and scopes what it touches rather than spawning its own. itsaplan scopes via the fixture repo's project key; code-server scopes via `?folder=<path>` on the one always-on instance (`paseo-code-server.service`), never a daemon it starts or stops.

## Reachable stacks

When testing against real external devices (such as opening the mock web UI on a MacBook), pass `--reachable` to `stack.mjs up` or `run.mjs`:

```bash
node scripts/verify/stack.mjs up --reachable
# or
node scripts/verify/run.mjs <check> --up --reachable
```

- **VPN IP detection:** Daemons bind `PASEO_LISTEN=<vpnIp>:0` where `vpnIp` is determined by the `PASEO_VERIFY_REACHABLE_HOST` environment variable if set, otherwise the first non-loopback IPv4 address on a network interface matching `wg*` (WireGuard VPN). If no interface matches, `up` fails with an error explaining that a WireGuard interface was not found. `httpUrl` and `wsUrl` on hosts use that IP.
- **Why not `0.0.0.0`:** On a cloud host, binding `0.0.0.0` exposes daemon ports to all public interfaces and internet port scanners. Binding the WireGuard IP restricts network traffic to the private, encrypted mesh shared with developer machines.
- **Password entry in Web UI:** The connection hint the daemon injects into `index.html` carries only `listen` and `useTls` (`InitialDaemonConnectionHintSchema`, `packages/app/src/runtime/host-runtime.ts`), and `#offer=` links are relay-only. With a password set the automatic connect is rejected and the app falls back to the add-host form. `node scripts/verify/stack.mjs connect <runId>` (printed by `up` and by `run.mjs --keep`) emits a devtools snippet that writes the stored host profile (serverId, endpoint, password, VS Code Web URL) into the browser's daemon registry and reloads. It merges by serverId, so pasting it for a new run replaces the previous mock entry and leaves other hosts alone. The alternative is the add-host form with the printed password.
- **VS Code Web URL:** `browserEditorUrl` on a stored host profile is a client-side field, set once by the user (Settings -> host -> VS Code Web URL), not daemon config. When `stack.codeServer.healthy`, `run.mjs` seeds it automatically into the Playwright browser's own daemon registry and also prints the URL; on a Mac opening a `--reachable` mock, paste that URL into the same Settings field once so the desktop app's "Open -> VS Code Web" works against the mock.
- **Why not the service proxy:** The Paseo service proxy ([docs/service-proxy.md](service-proxy.md)) exposes workspace scripts (e.g. custom web servers) through subdomains and public tunnels. It is not designed for daemon management or web UI endpoints, and introduces unnecessary DNS and tunnel overhead.

## Durable proofs

Proofs generated during verification runs are stored outside the worktree under:

```
~/.paseo/verify-proofs/<worktreeBasename>/<runId>/
```

- **Survives clean and archive:** In prior versions, proof artifacts lived under `<worktree>/artifacts/verify/<runId>/`. A `git clean -fdx` or worktree cleanup erased recorded video proofs and screenshots before review. Storing proofs in `~/.paseo/verify-proofs/` ensures media and `result.json` survive worktree deletion, clean, and branch switching.
- **Retention:** `node scripts/verify/stack.mjs sweep` prunes proof directories older than 14 days.
- **Structure:** Contains `proof.mp4`, `before.png`, `after.png`, and `result.json`.

## Red-green verification

Verification follows a strict red-first discipline: write the check first, see it fail on existing code to prove reproduction, then fix the code and see it pass.

- **`--expect fail` (RED):**
  ```bash
  node scripts/verify/run.mjs <check-name> --up --expect fail
  ```
  Exits 0 if and only if the check failed. If the check passes unexpectedly, it exits 1. `result.json` records `expectation: "fail"` and `expectationMet: true|false`.
  Verify that the check failed for the expected reason (e.g. the specific assertion failure or missing RPC response), not an incidental syntax error. Save this red `result.json` as reproduction proof.
- **`--expect pass` (GREEN):**
  ```bash
  node scripts/verify/run.mjs <check-name> --up
  ```
  Default behavior. Exits 0 only when all steps pass. For UI-tier checks, append `--proof` to record video and stills.

## Run-all suite

Run the full verification suite across all committed checks:

```bash
node scripts/verify/run.mjs --all [--tier daemon|ui|fleet] [--proof] [--json]
```

- **Execution model:** Discovers all `scripts/verify/checks/*.mjs`. Groups checks by host requirement (`hosts: 1` vs `hosts: 2`). Brings up one stack per group, executes each check in that group sequentially against the shared stack, and tears the stack down on completion.
- **Self-namespacing rule:** Because checks in a group share a single stack, every check must be self-namespacing. Checks must use unique workspace paths, distinct issue titles (`[<runId>] ...`), and unique agent names so that sequential runs do not collide or depend on state left by a previous check.
- **When to run:** Run `--all` after merging changes from upstream branches and before deploying or landing changes.

## Browser tools vs Playwright

Two distinct browser mechanisms exist in the environment:

- **Playwright (inside check scripts):**
  - Runs headless Chromium directly on the host machine running the daemon.
  - The default and only assertion mechanism for automated verification.
  - Deterministic, fast, runs headlessly in CI or cloud containers, captures before/after stills, and records video for `proof.mp4`.
- **Paseo `browser_*` tools:**
  - Execute on the user's MacBook Electron app and open browser tabs in their local workspace.
  - Used only as a visible "see it live" surface when the user's Mac is connected, pointing to the reachable stack URL (`ctx.reachableUrl()`).
  - When the MacBook is disconnected or closed, calls return `browser_no_host`. This is expected; do not retry and do not fail the task.
  - The only way to observe Electron-guest-specific behavior (e.g. desktop wrapper integrations, webview-to-native IPC, protocol handlers).

## Positioning vs `packages/app/e2e`

- **`packages/app/e2e`:** Contains ~180 Metro / Detox / Playwright specs taking 15-30 minutes. It is the deep component regression suite covering React Native web/mobile rendering edge cases, gesture handlers, and theme styling across platforms.
- **`scripts/verify`:** The fast operational verification tier. Checks run in seconds (~3-6s), bringing up real daemons and exercising end-to-end WebSocket RPCs, multi-host peering, and critical UI user journeys. It must not duplicate component specs or granular styling tests.

## Two-daemon verification

When a change touches cross-host or daemon-to-daemon behavior, start two peered daemons:

```bash
node scripts/verify/stack.mjs up --peer
```

The stack configures `commander` (role `commander`) and `peer-b` (role `peer`). Peering links carry the daemon password (`PeerConfigSchema.password`).

Five cross-host assertions to cover:

1. **Cross-host spawn.** An agent spawned on `peer-b` appears in the commander's fleet list tagged to `peer-b`.
2. **Event forwarding.** A terminal event on `peer-b` forwards to the commander without waiting for the 60s reconcile sweep.
3. **Routing.** Bare `agentId` routing on the commander resolves the owning peer host.
4. **Central config sync.** `central-config.json` changes sync on connect from commander to peer.
5. **Meta mutation.** Cross-host meta mutations (e.g. `fleet_rename_project`, `fleet_archive_workspace`) executed on commander land on `peer-b`.

### Cross-host check example

`scripts/verify/checks/fleet-cross-host.mjs` (tier `fleet`, `hosts: 2`) is the worked example for daemon-to-daemon changes. It configures two hosts, connects clients to both, exercises cross-host agent creation and event routing, and asserts state synchronization across the fleet.

See [docs/fleet-state-sync.md](fleet-state-sync.md) for the host-locality bug class.

## The check script

Check scripts live in `scripts/verify/checks/<name>.mjs`.

Write the check script before or alongside the change from knowledge of the code contracts. Never discover verification by clicking through the UI after editing. Every check is committed and rerunnable on demand.

Check skeleton:

```javascript
export const meta = {
  name: "daemon-agent-lifecycle",
  tier: "daemon", // "daemon" | "ui" | "fleet"
  hosts: 1, // 1, or 2 when the check needs a peer -> runner passes --peer to stack.mjs up
  video: false, // --video / --proof forces recording on regardless
  description: "One line: what change this check defends.",
};

export const steps = [
  {
    id: "health",
    label: "Daemon answers health endpoint",
    narrate: "Daemon is healthy and answering loopback requests.",
    async run(ctx) {
      const res = await fetch(`${ctx.host().httpUrl}/api/health`);
      ctx.expect(res.status === 200, "health endpoint returned 200");
      return "health 200 ok";
    },
  },
  {
    id: "action",
    label: "Perform behavior",
    narrate: "Behavior executed successfully.",
    async run(ctx) {
      const client = ctx.host().client;
      // Perform daemon RPC or browser actions...
      return "action completed";
    },
  },
];
```

### Step context (`ctx`)

Each step receives `ctx`:

- `ctx.stack` — Parsed `stack.json` object.
- `ctx.host(name?)` — Host info `{ httpUrl, wsUrl, home, logFile, client }` where `client` is a connected, authenticated `DaemonClient` (`appVersion: "0.1.70"`). Defaults to `"commander"` / `stack.hosts[0]`. In multi-host checks (`hosts: 2`), access the peer with `ctx.host("peer-b")`.
- `ctx.page` — Playwright `Page` instance (available in `ui` tier or when video recording is enabled; `null` otherwise).
- `ctx.shot(label)` — Captures a PNG screenshot to `<proofDir>/shots/` (or `<artifactsDir>/shots/`) and returns its absolute path. Labels `"before"` and `"after"` populate `result.shots.before` and `result.shots.after` in `result.json`. Step failures automatically capture a `"failure"` shot when `page` is available.
- `ctx.expect(condition, message)` — Throws an error if `condition` is falsy, failing the step.
- `ctx.log(msg)` — Prints formatted log output unless `--json` is set.
- `ctx.artifactsDir` — Absolute path to `<worktree>/artifacts/verify/<runId>`.
- `ctx.readDaemonLog(hostName?)` — Reads and returns the daemon log file for the specified host.
- `ctx.fixtureRepo` — Absolute path to `<runDir>/fixture`, a git repo keyed `remote:github.com/paseo-verify/fixture` for itsaplan-mapped tests.
- `ctx.password` — Per-run daemon password (`string | null`), or `null` when booted with `--no-password`.
- `ctx.reachableUrl(hostName?)` — Returns the reachable HTTP URL for `hostName` (default `"commander"`), or loopback HTTP URL if `--reachable` was not used.

Step return value: returning a string (or an object with a `detail` string) sets `step.detail` in `result.json`.

## Running checks

```bash
# Standalone run (brings up stack, runs check, tears down)
node scripts/verify/run.mjs <check-name> --up

# Run against an existing active stack
node scripts/verify/run.mjs <check-name> --stack <runId>

# Red run: exit 0 iff check fails (reproduction)
node scripts/verify/run.mjs <check-name> --up --expect fail

# Green run: exit 0 iff check passes (default)
node scripts/verify/run.mjs <check-name> --up --expect pass

# Record raw browser video to <artifactsDir>/raw.webm
node scripts/verify/run.mjs <check-name> --up --video

# Full proof: record video, generate TTS narration, assemble proof.mp4, copy to durable proofDir
node scripts/verify/run.mjs <check-name> --up --proof

# Keep stack running after check completion for manual inspection
node scripts/verify/run.mjs <check-name> --up --keep

# Reachable stack on WireGuard VPN IP (for MacBook inspection)
node scripts/verify/run.mjs <check-name> --up --reachable

# Run without daemon password authentication
node scripts/verify/run.mjs <check-name> --up --no-password

# Run without itsaplan bridge configuration
node scripts/verify/run.mjs <check-name> --up --no-itsaplan

# Run without Commander boot designation
node scripts/verify/run.mjs <check-name> --up --no-commander

# Run full suite sequentially across discovered checks
node scripts/verify/run.mjs --all [--tier daemon|ui|fleet] [--proof] [--json]

# Output structured JSON result to stdout
node scripts/verify/run.mjs <check-name> --json
```

`--proof` is the one-command proof path: it implies `--video`, runs offline TTS narration, assembles `proof.mp4` with burned-in step captions into `<proofDir>/proof.mp4`, and populates `proofs[]` in `result.json`. A video assembly error never fails the check; the reason is recorded in `result.proofError`.

The runner writes `<artifactsDir>/result.json` and copies it to `<proofDir>/result.json`:

```json
{
  "name": "daemon-agent-lifecycle",
  "tier": "daemon",
  "startedAt": "2026-09-08T09:00:00.000Z",
  "durationMs": 4210,
  "passed": true,
  "expectation": "pass",
  "expectationMet": true,
  "stack": { "...": "stack.json content" },
  "webUi": [
    {
      "name": "commander",
      "url": "http://127.0.0.1:41234"
    }
  ],
  "steps": [
    {
      "id": "health",
      "label": "Daemon answers health endpoint",
      "narrate": "Daemon is healthy and answering loopback requests.",
      "kind": "daemon",
      "status": "pass",
      "startMs": 0,
      "endMs": 120,
      "detail": "health 200 ok",
      "error": null,
      "shots": []
    }
  ],
  "shots": {
    "before": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/before.png",
    "after": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/after.png"
  },
  "video": {
    "raw": "/abs/.../raw.webm",
    "width": 1280,
    "height": 720
  },
  "proof": {
    "mp4": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/proof.mp4",
    "bytes": 280124,
    "durationSec": 11.7
  },
  "proofs": [
    {
      "kind": "video",
      "path": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/proof.mp4",
      "label": "Proof: daemon-agent-lifecycle"
    },
    {
      "kind": "image",
      "path": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/after.png",
      "label": "After: daemon-agent-lifecycle"
    }
  ],
  "reproduce": [
    "node scripts/verify/run.mjs daemon-agent-lifecycle --up --keep",
    "node scripts/verify/stack.mjs ls",
    "node scripts/verify/stack.mjs down <runId-printed-by-ls>"
  ]
}
```

Step `startMs` and `endMs` align to video recording start for subtitle synchronization.

## Proofs and reporting

Attach proofs when reporting completion via `report_status`:

```json
{
  "status": "completed",
  "kind": "milestone",
  "description": "Verified status card lifecycle against isolated daemon stack.",
  "proofs": [
    {
      "kind": "video",
      "path": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/proof.mp4",
      "label": "Proof: Status card lifecycle"
    },
    {
      "kind": "image",
      "path": "/home/ubuntu/.paseo/verify-proofs/28nopbkr/v-1a2b3c4d/after.png",
      "label": "After: Status card in feed"
    },
    {
      "kind": "command",
      "command": "node scripts/verify/run.mjs status-card-lifecycle --up --expect fail",
      "output": "Step 'card-render' failed as expected: status card not found in DOM",
      "label": "Reproduction: Red check failure"
    }
  ]
}
```

### Media limits and delivery

`packages/server/src/server/mission-control/media.ts` enforces limits on proofs fetched over `mission_control.media.fetch`:

- **Path.** Must be an absolute path on disk.
- **Size.** Maximum 10 MB (`MEDIA_FETCH_MAX_BYTES`).
- **Video formats.** `.mp4`, `.webm`, `.mov`, `.m4v`. Videos render inline via `<video controls>` in the Mission Control chat feed (`proof-video.web.tsx`).
- **Image formats.** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`.

### Video generation

`scripts/verify/video.py` compiles the video proof:

```bash
uv run --with moviepy python scripts/verify/video.py \
  --result artifacts/verify/<runId>/result.json \
  --out artifacts/verify/<runId>/proof.mp4 \
  --narrate-dir .dev/verify/<runId>/narration \
  --max-mb 9
```

The script burns step captions into the video matching `result.json` step timings and mixes offline TTS narration generated via sherpa-onnx Kokoro (`~/.paseo/models/local-speech/kokoro-en-v0_19`).

### Review commands

In self-reports and PR summaries, provide the commands for humans to reproduce the verification:

- Reproduce check: `node scripts/verify/run.mjs <check-name> --up --keep` (with `--reachable` if the run used it)
- List active stacks: `node scripts/verify/stack.mjs ls`
- Tear down stack: `node scripts/verify/stack.mjs down <runId>`
- Web UI URL: `http://<ip>:<port>` and the random daemon password

## Cleanup

- **State.** `.dev/verify/<runId>/` is gitignored and removed when the workspace is archived via `paseo.json` `worktree.teardown`.
- **Durable proofs.** `~/.paseo/verify-proofs/<worktreeBasename>/<runId>/` survives worktree clean and archive. Pruned after 14 days by `sweep`.
- **Teardown.** `node scripts/verify/stack.mjs down <runId>` kills the stack's process tree and deletes run-specific webhooks, agents, and issues in itsaplan. `node scripts/verify/stack.mjs down --all` tears down all stacks in the worktree.
- **Sweep.** `node scripts/verify/stack.mjs sweep` reaps orphaned test stacks, dead webhooks, stale `verify-*` agents, issues older than 1 day, and proof directories older than 14 days.

Do not rely on daemon terminal exit for cleanup. The Paseo daemon terminal kills only direct child processes (`packages/server/src/terminal/terminal.ts:1470-1530`). Child daemons and Chromium browsers are orphaned unless reaped with process-group signals (`kill(-pid, 'SIGTERM')` via `setsid`/`start_new_session`), which `stack.mjs` handles.

## Gotchas

- **`PASEO_PASSWORD` leak.** Exported in agent sessions on this host. If passed to the daemon, it enables bearer auth with that environment password instead of the per-run random password. Strip it on launch: `env -u PASEO_PASSWORD`.
- **`PASEO_AGENT_ID` and `PASEO_AGENT_CWD` leak.** Exported by agent harnesses. If leaked, they contaminate agent tracking. Strip them: `env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD`.
- **Background downloads and tunnels.** Default daemon config triggers speech-model downloads and quick tunnels at boot. Disable them: `PASEO_VOICE_MODE_ENABLED=0 PASEO_DICTATION_ENABLED=0 PASEO_TUNNEL_AUTOSTART=0 PASEO_RELAY_ENABLED=0 PASEO_SERVICE_PROXY_ENABLED=0 PASEO_LOG_LEVEL=warn`.
- **Commander designation.** Local daemons share an OS hostname. In two-daemon mode, designate the Commander by `missionControl.hostAlias` in `central-config.json` (e.g. `commander`), never by hostname or `"local"`, or both daemons claim Commander (`commander-boot.ts:139-152`).
- **Web UI bundle provenance.** The prebuilt web UI bundle (`/data/paseo/packages/server/dist/server/web-ui`) comes from the shared source checkout. It contains the source checkout's app code, not your worktree's app changes. It is accurate for daemon, server, and protocol work. For worktree app-UI changes, build the bundle in your worktree or test with `npm run dev:app`.

## Decision matrix

| Change shape                                                   | Required tier        | Required proof                                                                                            |
| -------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| Docs-only / comments                                           | None                 | Git diff                                                                                                  |
| Pure unit logic (`packages/shared`, isolated utilities)        | `daemon`             | Targeted unit test output (`vitest`) or lightweight daemon RPC check                                      |
| Daemon RPC / protocol / API / data model                       | `daemon`             | Red check (`--expect fail`), green check (`--up`), `result.json`, daemon log excerpt                      |
| Mission Control / Commander / verifier logic                   | `daemon` or `fleet`  | Red check (`--expect fail`), green check (`--up`), `result.json`, itsaplan webhook/agent/issue receipts   |
| Web UI component / navigation / layout / DOM interactions      | `ui`                 | Red check (`--expect fail`), green check (`--up --proof`), video proof (`proof.mp4`), before/after stills |
| Cross-host sync / peering / event routing / multi-daemon state | `fleet` (`hosts: 2`) | Red check (`--expect fail`), green check (`--up`), `result.json`, verified state logs from both hosts     |
| Electron desktop wrapper / native guest integrations           | `ui`                 | Playwright check on server + `browser_*` screenshot on connected MacBook                                  |

## Timing targets

| Operation                              | Target   | Measured       |
| -------------------------------------- | -------- | -------------- |
| Single stack `up` to `/api/health` 200 | <= 3.5s  | To be measured |
| Two-daemon peered stack `up`           | <= 5.0s  | To be measured |
| `run.mjs sanity --up` (wall time)      | <= 6.0s  | To be measured |
| Full test suite (`run.mjs --all`)      | <= 45.0s | To be measured |
