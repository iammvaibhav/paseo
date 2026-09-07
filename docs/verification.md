# Verification

Verification proves a change against an isolated Paseo stack before landing or reporting done. Every pull request and worker dispatch must produce verifiable evidence matching the change shape.

## The ladder

Cheapest first:

1. **Daemon RPC / CLI assertion (`daemon`).** Assert over WebSocket RPCs (`@getpaseo/client`), loopback HTTP endpoints, or CLI commands. Fast (~100ms per check), deterministic.
2. **Browser UI drive (`ui`).** Drive headless Chromium via Playwright against the real web UI. Use when verifying DOM state, navigation, form inputs, or component interactions.
3. **Cross-host fleet (`fleet`).** Start two peered daemons (`hosts: 2`) to assert multi-host coordination, event forwarding, agent lifecycle across peers, and central config sync.

Video recording and narration are orthogonal to tier: set `video: true` in check metadata or run with `--video` or `--proof` to capture browser interactions, burn in step captions and offline TTS narration, and assemble `proof.mp4` with before/after stills.

If a change is verifiable at the daemon layer, verify it there. Reserve browser driving and video proofs for UI surfaces.

## The environment

Bring up an isolated, throwaway stack:

```bash
node scripts/verify/stack.mjs up [--peer]
```

Each run gets:

- **Isolated `PASEO_HOME`.** Scratch state lives under `.dev/verify/<runId>/hosts/<name>`.
- **Ephemeral port.** Starts via `packages/server/dist/scripts/supervisor-entrypoint.js` with `PASEO_LISTEN=127.0.0.1:0`. The OS selects an unused port. Runs never collide with port 6767 (production), 6768 (dev), or other agents' parallel stacks.
- **Loopback auth.** `auth: "none"`. With `PASEO_PASSWORD` unset and a fresh `PASEO_HOME`, loopback requests receive full owner permissions with no pairing ceremony.
- **Web UI.** Serves the prebuilt web UI bundle, injecting `window.__PASEO_INITIAL_DAEMON_CONNECTION__` into `index.html` at request time.
- **Performance.** Single daemon reaches `/api/health` 200 in ~2.5s. Two peered daemons reach healthy peering in 3.77s. Daemon-tier check runs in 6.2s wall time including boot and teardown. UI-tier check with video runs in 5.68s against a live stack. Four parallel daemons in one worktree take 4.4-4.8s each with zero port contention. Boot cost is Node module loading, which `NODE_COMPILE_CACHE=.dev/verify/.node-compile-cache` speeds once warm (1.97s warm vs 2.31s cold for a bare daemon).

Stack details are written to `.dev/verify/<runId>/stack.json`:

```json
{
  "runId": "v-1a2b3c4d",
  "createdAt": "2026-08-31T09:00:00.000Z",
  "worktree": "/abs/worktree",
  "runDir": "/abs/worktree/.dev/verify/v-1a2b3c4d",
  "artifactsDir": "/abs/worktree/artifacts/verify/v-1a2b3c4d",
  "webUiDistDir": "/abs/path/to/web-ui",
  "auth": "none",
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

## Gotchas

- **`PASEO_PASSWORD` leak.** Exported in agent sessions on this host. If passed to the daemon, it enables bearer auth and breaks unauthenticated browser and loopback connections. Strip it on launch: `env -u PASEO_PASSWORD`.
- **`PASEO_AGENT_ID` and `PASEO_AGENT_CWD` leak.** Exported by agent harnesses. If leaked, they contaminate agent tracking. Strip them: `env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD`.
- **Background downloads and tunnels.** Default daemon config triggers speech-model downloads and quick tunnels at boot. Disable them: `PASEO_VOICE_MODE_ENABLED=0 PASEO_DICTATION_ENABLED=0 PASEO_TUNNEL_AUTOSTART=0 PASEO_RELAY_ENABLED=0 PASEO_SERVICE_PROXY_ENABLED=0 PASEO_LOG_LEVEL=warn`.
- **Commander designation.** Local daemons share an OS hostname. In two-daemon mode, designate the Commander by `missionControl.hostAlias` in `central-config.json` (e.g. `commander`), never by hostname or `"local"`, or both daemons claim Commander (`commander-boot.ts:139-152`).
- **Web UI bundle provenance.** The prebuilt web UI bundle (`/data/paseo/packages/server/dist/server/web-ui`) comes from the shared source checkout. It contains the source checkout's app code, not your worktree's app changes. It is accurate for daemon, server, and protocol work. For worktree app-UI changes, build the bundle in your worktree or test with `npm run dev:app`.

## Two-daemon verification

When a change touches cross-host or daemon-to-daemon behavior, start two peered daemons:

```bash
node scripts/verify/stack.mjs up --peer
```

The stack configures `commander` (role `commander`) and `peer-b` (role `peer`).

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
- `ctx.host(name?)` — Host info `{ httpUrl, wsUrl, home, logFile, client }` where `client` is a connected `DaemonClient` (`appVersion: "0.1.70"`, `fetchAgents()` initialized). Defaults to `"commander"` / `stack.hosts[0]`. In multi-host checks (`hosts: 2`), access the peer with `ctx.host("peer-b")`.
- `ctx.page` — Playwright `Page` instance (available in `ui` tier or when video recording is enabled; `null` otherwise).
- `ctx.shot(label)` — Captures a PNG screenshot to `<artifactsDir>/shots/` and returns its absolute path. Labels `"before"` and `"after"` populate `result.shots.before` and `result.shots.after` in `result.json`. Step failures automatically capture a `"failure"` shot when `page` is available.
- `ctx.expect(condition, message)` — Throws an error if `condition` is falsy, failing the step.
- `ctx.log(msg)` — Prints formatted log output unless `--json` is set.
- `ctx.artifactsDir` — Absolute path to `<worktree>/artifacts/verify/<runId>`.
- `ctx.readDaemonLog(hostName?)` — Reads and returns the daemon log file for the specified host.

Step return value: returning a string (or an object with a `detail` string) sets `step.detail` in `result.json`.

### Running checks

```bash
# Standalone run (brings up stack, runs check, tears down)
node scripts/verify/run.mjs <check-name>

# Run against an existing active stack
node scripts/verify/run.mjs <check-name> --stack <runId>

# Record raw browser video to <artifactsDir>/raw.webm
node scripts/verify/run.mjs <check-name> --video

# Full proof: record video, generate TTS narration, assemble proof.mp4
node scripts/verify/run.mjs <check-name> --proof

# Keep stack running after check completion for manual inspection
node scripts/verify/run.mjs <check-name> --up --keep

# Output structured JSON result to stdout
node scripts/verify/run.mjs <check-name> --json
```

`--proof` is the one-command proof path: it implies `--video`, runs offline TTS narration, and assembles `proof.mp4` with burned-in step captions and narration into `artifacts/verify/<runId>/proof.mp4`. A video assembly error never fails the check; the reason is recorded in `result.proofError`.

The runner writes `<artifactsDir>/result.json`:

```json
{
  "name": "daemon-agent-lifecycle",
  "tier": "daemon",
  "startedAt": "2026-08-31T09:00:00.000Z",
  "durationMs": 4210,
  "passed": true,
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
    "before": "/abs/.../before.png",
    "after": "/abs/.../after.png"
  },
  "video": {
    "raw": "/abs/.../raw.webm",
    "width": 1280,
    "height": 720
  },
  "proof": {
    "mp4": "/abs/.../proof.mp4",
    "bytes": 280124,
    "durationSec": 11.7
  },
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
      "path": "/abs/worktree/artifacts/verify/v-1a2b3c4d/proof.mp4",
      "label": "Proof: Status card lifecycle"
    },
    {
      "kind": "image",
      "path": "/abs/worktree/artifacts/verify/v-1a2b3c4d/after.png",
      "label": "After: Status card in feed"
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

- Reproduce check: `node scripts/verify/run.mjs <check-name> --up --keep`
- List active stacks: `node scripts/verify/stack.mjs ls`
- Tear down stack: `node scripts/verify/stack.mjs down <runId>`
- Web UI URL: `http://127.0.0.1:<port>`

Proof files live under `artifacts/verify/<runId>/`. Proof files must outlive the throwaway stack. Mission Control retention prunes feed cards, never files on disk.

## Cleanup

- **State.** `.dev/verify/<runId>/` is gitignored and removed when the workspace is archived via `paseo.json` `worktree.teardown`.
- **Artifacts.** `artifacts/verify/<runId>/` is gitignored and preserved for review.
- **Teardown.** `node scripts/verify/stack.mjs down <runId>` kills the stack's process tree. `node scripts/verify/stack.mjs down --all` tears down all stacks in the worktree. `node scripts/verify/stack.mjs sweep` reaps orphaned test stacks.

Do not rely on daemon terminal exit for cleanup. The Paseo daemon terminal kills only direct child processes (`packages/server/src/terminal/terminal.ts:1470-1530`). Child daemons and Chromium browsers are orphaned unless reaped with process-group signals (`kill(-pid, 'SIGTERM')` via `setsid`/`start_new_session`), which `stack.mjs` handles.

## Decision matrix

| Change shape | Required tier | Required proof |
…
| Docs-only | None | Git diff |

[Showing lines 1-300 of 307. Use :301 to continue]