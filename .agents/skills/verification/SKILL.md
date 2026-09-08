---
name: verification
description: Fast parallel verification standard for Paseo. Bring up isolated dev stacks, run integration checks, and generate video proofs. Use when asked "how do I verify this", "prove this works", "video proof", or "integration test for my change".
user-invocable: true
argument-hint: "<check-name> | --all [--up] [--expect pass|fail] [--proof] [--reachable]"
---

# Verification

Verify changes against an isolated, throwaway Paseo stack before landing code or reporting done.

See [docs/verification.md](../../../docs/verification.md) for architecture, the mock fleet contract, and the [decision matrix](../../../docs/verification.md#decision-matrix).

## Workflow

Follow these seven steps in order:

### 1. Decide the tier

Consult the [decision matrix](../../../docs/verification.md#decision-matrix) to choose your check tier:

- `daemon`: RPC, loopback HTTP, or CLI behavior (~100ms per check).
- `ui`: DOM state, navigation, form inputs, or web UI interactions driven via Playwright.
- `fleet`: Cross-host peering, multi-daemon sync, event forwarding (`hosts: 2`). If your change touches daemon-to-daemon coordination or central-config sync across daemons, use `fleet`.

### 2. RED FIRST: write and run the failing check

Write your check under `scripts/verify/checks/<name>.mjs` from the code contracts before changing any code.

Run the check with `--expect fail`:

```bash
node scripts/verify/run.mjs <name> --up --expect fail
```

Confirm that the check exits 0 with `expectationMet: true` in `result.json` and fails for the right reason (the bug you are reproducing, or the feature not yet implemented). This failure is your reproduction. Keep that `result.json`.

Delegate the mechanical authoring and execution of the check script to a `task` subagent (using the omp `task`-role model), but decide what to assert yourself.

### 3. Implement the fix (GREEN)

Implement your changes in the worktree. Run the check to confirm it passes:

```bash
node scripts/verify/run.mjs <name> --up
```

For UI changes, run with `--proof` to record video, generate captions and narration, and assemble `proof.mp4` with before/after stills:

```bash
node scripts/verify/run.mjs <name> --up --proof
```

### 4. Attach proofs and report

Before reporting done, attach the ready-made `proofs[]` from `result.json` to `report_status`. Proof files live under the durable directory `~/.paseo/verify-proofs/<worktree>/<runId>/`, surviving worktree clean or archive operations.

Include:

- Inline video and before/after images from `result.json` (`proofs[]`).
- The red run failure excerpt from step 2 as a `command` proof.
- The mock environment details:
  - If the user asked to try it themselves: run with `--keep --reachable` and paste the reachable web UI URL, the daemon password, the reproduction recipe, and the **connect snippet** the runner prints (also `node scripts/verify/stack.mjs connect <runId>`). The user pastes the snippet into the devtools console of the mock's web UI page; it registers the host with the password and the VS Code Web URL, then reloads. Without it the page lands on the add-host form, because the connection hint carries no password.
  - Otherwise: paste the 3-line reproduction recipe printed by `run.mjs`.

### 5. Browser choice

- **Playwright** inside check scripts is the default and only assertion mechanism. It runs server-side, deterministically, captures before/after stills, and records video.
- **Paseo `browser_*` tools** run on the user's connected MacBook Electron client and open tabs in their local workspace. Use them only when the user's Mac is connected as a visible "see it live" surface, pointing them at the reachable mock URL (`ctx.reachableUrl()`). If `browser_*` returns `browser_no_host`, or times out with "The browser did not respond", the MacBook is not connected (a stale registration times out instead of failing fast); do not retry and do not fail the task. Report the reachable URL and password instead. Save any captured `browser_screenshot` bytes to disk under the run's proof directory before attaching. `browser_*` is also the only way to observe Electron-guest-only behavior.

### 6. Live environment

Follow the live environment rule in [CLAUDE.md](../../../CLAUDE.md#critical-rules): verify against the isolated mock fleet by default. Use the live environment (the 6767 daemon, real itsaplan projects, real workspaces) only when the user explicitly requested it or when the behavior cannot be reproduced in the mock stack and you state why. All live environment actions must be strictly additive (create a new workspace or ticket); never delete, archive, rename, or modify pre-existing data.

### 7. Run-all

After merging upstream changes and before landing or deploying:

```bash
node scripts/verify/run.mjs --all
```

The runner groups checks by required host count, boots one stack per group, and runs checks sequentially. Checks must be self-namespacing (unique titles, workspace directories, and agent IDs) so they do not collide when sharing a stack.

Assert on the objects your check created, never on global counts or list lengths. The mock is production-shaped: a live Commander provisions its own workspace seconds after boot, the warm pool adds worktrees, and other checks share the stack. A row-count assertion that passed on an idle daemon fails the moment a real actor moves.

## The check script

Check scripts live in `scripts/verify/checks/<name>.mjs`.

Check skeleton:

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
```

### Step context (`ctx`)

| Property / Method              | Type             | Description                                                                                                                                                                                                            |
| ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.stack`                    | `object`         | Parsed `stack.json` object.                                                                                                                                                                                            |
| `ctx.host(name?)`              | `function`       | Host info `{ httpUrl, wsUrl, home, logFile, client }` where `client` is an authenticated `DaemonClient` (`appVersion: "0.1.70"`). Defaults to `"commander"` (`stack.hosts[0]`). Access peers via `ctx.host("peer-b")`. |
| `ctx.page`                     | `Page \| null`   | Playwright `Page` instance (available in `ui` tier or when video recording is enabled; `null` otherwise).                                                                                                              |
| `ctx.shot(label)`              | `function`       | Captures a PNG screenshot to `<proofDir>/shots/` (or `<artifactsDir>/shots/`) and returns its absolute path. Labels `"before"` and `"after"` populate `result.shots`.                                                  |
| `ctx.expect(condition, msg)`   | `function`       | Throws an error if `condition` is falsy, failing the step.                                                                                                                                                             |
| `ctx.log(msg)`                 | `function`       | Prints formatted log output unless `--json` is set.                                                                                                                                                                    |
| `ctx.artifactsDir`             | `string`         | Absolute path to `<worktree>/artifacts/verify/<runId>`.                                                                                                                                                                |
| `ctx.readDaemonLog(hostName?)` | `function`       | Reads and returns the daemon log file for the specified host.                                                                                                                                                          |
| `ctx.fixtureRepo`              | `string`         | Absolute path to `<runDir>/fixture`, a git repo keyed `remote:github.com/paseo-verify/fixture` for itsaplan-mapped tests.                                                                                              |
| `ctx.password`                 | `string \| null` | Per-run daemon password, or `null` when booted with `--no-password`.                                                                                                                                                   |
| `ctx.reachableUrl(hostName?)`  | `function`       | Returns the reachable HTTP URL for `hostName` (default `"commander"`), or loopback HTTP URL if `--reachable` was not used.                                                                                             |

## CLI flags

### `run.mjs`

```bash
# Standalone run (brings up stack, runs check, tears down)
node scripts/verify/run.mjs <check-name> --up

# Run against an existing active stack
node scripts/verify/run.mjs <check-name> --stack <runId>

# Red run: exit 0 iff check fails (reproduction)
node scripts/verify/run.mjs <check-name> --up --expect fail

# Green run: exit 0 iff check passes (default)
node scripts/verify/run.mjs <check-name> --up --expect pass

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

### `stack.mjs`

```bash
# Start an isolated stack
node scripts/verify/stack.mjs up [--peer] [--reachable] [--no-password] [--no-itsaplan] [--no-commander] [--no-code-server] [--json] [--quiet]

# List active stacks
node scripts/verify/stack.mjs ls [--json]

# Stop a stack and clean up run-specific itsaplan resources
node scripts/verify/stack.mjs down <runId>

# Stop all stacks in the worktree
node scripts/verify/stack.mjs down --all

# Prune orphaned stacks and durable proofs older than 14 days
node scripts/verify/stack.mjs sweep [--older-than-minutes N] [--json] [--quiet]
```

## Attaching proofs to report_status

Submit completion with proofs from `result.json`:

```json
{
  "status": "completed",
  "kind": "milestone",
  "description": "Verified status card lifecycle against isolated daemon stack.",
  "proofs": [
    {
      "kind": "video",
      "path": "/home/ubuntu/.paseo/verify-proofs/<worktree>/v-1a2b3c4d/proof.mp4",
      "label": "Proof: Status card lifecycle"
    },
    {
      "kind": "image",
      "path": "/home/ubuntu/.paseo/verify-proofs/<worktree>/v-1a2b3c4d/after.png",
      "label": "After: Status card in feed"
    },
    {
      "kind": "command",
      "label": "Red run: node scripts/verify/run.mjs status-card-lifecycle --up --expect fail",
      "excerpt": "FAIL card-render: status card not found in DOM\nexpectation: fail, expectationMet: true",
      "exitCode": 0
    }
  ]
}
```

### Proof rules

- **Path:** Must be an absolute path (`~/.paseo/verify-proofs/...`). Durable proofs survive worktree cleanup.
- **Size cap:** Maximum 10 MB per file (`MEDIA_FETCH_MAX_BYTES`).
- **Video formats:** `.mp4`, `.webm`, `.mov`, `.m4v` (rendered inline in Mission Control chat feed).
- **Image formats:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`.

## Conflicts with other skills

- The brief's Proof Contract overrides `verifiable-artifact`'s PR-first ranking: operational verification on an isolated dev stack with inline proofs takes precedence over opening a draft PR for evidence.
- `tdd` is the inner unit loop for localized function logic; this skill is the outer end-to-end loop defending observable system behavior across daemons, bridge, and UI.
- `diagnosing-bugs` reproduction is a red check here: write a check that fails for the reported bug (`--expect fail`) before touching production code.
