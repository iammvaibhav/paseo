---
name: verification
description: Fast parallel verification standard for Paseo. Bring up isolated dev stacks, run integration checks, and generate video proofs. Use when asked "how do I verify this", "prove this works", "video proof", or "integration test for my change".
user-invocable: true
argument-hint: "[check-name] [--up] [--video] [--proof]"
---

# Verification

Verify changes against an isolated, throwaway Paseo stack before reporting done.

See [docs/verification.md](../../docs/verification.md) for complete architecture, two-daemon assertions, and the decision matrix.

## The ladder

Cheapest first:

1. **Tier 1: Daemon RPC / CLI (`daemon`).** Assert over WebSocket RPCs or loopback HTTP (~100ms). If a change is verifiable at the daemon layer, verify it here.
2. **Tier 2: Browser UI (`ui`).** Drive headless Chromium with Playwright against the web UI.
3. **Tier 3: Cross-host fleet (`fleet`).** Assert multi-daemon coordination across peered stacks (`hosts: 2`).

Video recording and narration are orthogonal to tier: set `video: true` in check metadata or pass `--video`/`--proof`.

## Execution workflow

### 1. Start an isolated stack

```bash
# Single daemon stack
node scripts/verify/stack.mjs up

# Two peered daemons (for cross-host / sync work)
node scripts/verify/stack.mjs up --peer
```

Reads configuration and endpoint URLs from `.dev/verify/<runId>/stack.json`.

### 2. Write or choose a check script

Create `scripts/verify/checks/<name>.mjs`:

```javascript
export const meta = {
  name: "<check-name>",
  tier: "daemon", // "daemon" | "ui" | "fleet"
  hosts: 1, // 1, or 2 when the check needs a peer -> runner passes --peer to stack.mjs up
  video: false, // --video / --proof forces recording on regardless
  description: "Brief summary of observable behavior asserted",
};

export const steps = [
  {
    id: "health",
    label: "Daemon answers health endpoint",
    narrate: "Daemon is healthy.",
    async run(ctx) {
      const res = await fetch(`${ctx.host().httpUrl}/api/health`);
      ctx.expect(res.status === 200, "health endpoint returned 200");
      return "health 200 ok";
    },
  },
  {
    id: "action",
    label: "Perform behavior",
    narrate: "Behavior succeeded.",
    async run(ctx) {
      const client = ctx.host().client;
      // Assert RPC response, database state, or UI element via ctx
      return "action passed";
    },
  },
];

### 3. Run the check

```bash
# Run standalone (creates and tears down a stack automatically)
node scripts/verify/run.mjs <check-name>

# Run against an existing stack
node scripts/verify/run.mjs <check-name> --stack <runId>

# Run with Playwright video recording, TTS narration, and assembled proof.mp4
node scripts/verify/run.mjs <check-name> --proof

# Keep stack running after check completes for inspection
node scripts/verify/run.mjs <check-name> --up --keep

Results are saved to `artifacts/verify/<runId>/result.json`.

### 4. Stop the stack

```bash
node scripts/verify/stack.mjs down <runId>

# Tear down all stacks in the worktree
node scripts/verify/stack.mjs down --all
```

To clean up any orphaned test stacks across runs:

```bash
node scripts/verify/stack.mjs sweep
```

## Attaching proofs to report_status

Submit completion with proofs under `artifacts/verify/<runId>/`:

```json
{
  "status": "completed",
  "kind": "milestone",
  "description": "Verified behavior against isolated daemon stack.",
  "proofs": [
    {
      "kind": "video",
      "path": "/abs/path/to/worktree/artifacts/verify/<runId>/proof.mp4",
      "label": "Proof: Feature interaction"
    },
    {
      "kind": "image",
      "path": "/abs/path/to/worktree/artifacts/verify/<runId>/after.png",
      "label": "After: UI state"
    }
  ]
}
```

### Proof rules

- **Path:** Must be an absolute path (`artifacts/verify/<runId>/...`). Proof files outlive the stack.
- **Size cap:** Max 10 MB per file (`MEDIA_FETCH_MAX_BYTES`).
- **Video:** `.mp4`, `.webm`, `.mov`, `.m4v` (rendered inline in Mission Control feed).
- **Image:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`.

## Gotchas

- **Env leaks:** Strip `PASEO_PASSWORD`, `PASEO_AGENT_ID`, and `PASEO_AGENT_CWD` when starting daemon processes (`env -u PASEO_PASSWORD -u PASEO_AGENT_ID -u PASEO_AGENT_CWD`).
- **Daemon background noise:** Pass `PASEO_VOICE_MODE_ENABLED=0 PASEO_DICTATION_ENABLED=0 PASEO_TUNNEL_AUTOSTART=0 PASEO_RELAY_ENABLED=0 PASEO_SERVICE_PROXY_ENABLED=0 PASEO_LOG_LEVEL=warn`.
- **Commander designation:** In two-daemon mode, designate the Commander by `missionControl.hostAlias` (e.g. `commander`), never by hostname or `"local"`.
- **Web UI bundle:** The prebuilt bundle is from the source checkout. App-UI changes require building the web UI bundle in your worktree or verifying via `npm run dev:app`.