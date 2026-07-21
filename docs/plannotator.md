# Plannotator (embedded plan/markdown review)

Paseo's desktop app can open Markdown files in an **embedded Plannotator** tab for annotation review, then route the feedback back to a linked agent.

This is a **session-scoped** integration (not always-on like code-server): the daemon spawns `plannotator annotate` per review and tears it down on submit/close.

## Status

| Surface                                | Status                                |
| -------------------------------------- | ------------------------------------- |
| Annotate `.md` / `.markdown`           | Implemented                           |
| Feedback → agent (auto-send / compose) | Implemented                           |
| Open dropdown → Plannotator            | Implemented                           |
| Default markdown open                  | Opt-in setting (default **off**)      |
| Code review / PR review                | Deferred                              |
| Web / mobile                           | Not supported (Electron desktop only) |

## Install

Binary only — **do not** run the full upstream installer in a mode that wires agent Stop hooks.

```bash
./scripts/plannotator/install.sh local
./scripts/plannotator/install.sh blrofc3
./scripts/plannotator/install.sh iammvaibhav
```

Or via deploy:

```bash
./scripts/deploy.sh
PASEO_SKIP_PLANNOTATOR=1 ./scripts/deploy.sh   # skip
PLANNOTATOR_VERSION=0.22.0 ./scripts/deploy.sh # pin
```

Install uses `PLANNOTATOR_MINIMAL=1` / `--minimal` so hooks and skills are not written into Claude/Codex configs. Paseo owns invocation.

Binary path: `~/.local/bin/plannotator` (also searched on `PATH`).

## Capability flag

When the binary is resolvable at daemon start:

```
server_info.features.plannotator === true
```

// COMPAT(plannotator): boolean feature flag.

## How it works

```
Open Markdown / Open → Plannotator
  → plannotator.session.start.request { kind: "annotate", path, workspaceDir, agentId?, remote? }
  → daemon allocates port in 19432–19463, spawns:
      PLANNOTATOR_PORT=… PLANNOTATOR_READY_FILE=… PLANNOTATOR_SKIP_BROWSER_OPEN=1 BROWSER=none
      [PLANNOTATOR_REMOTE=1 when remote]
      plannotator annotate <path> --json --gate
  → client opens chrome-less transient webview tab at http://127.0.0.1:<port>
       (or http://<vpn-host>:<port> for remote hosts)
  → user annotates / approves
  → process exits; stdout JSON parsed
  → plannotator.session.event { event: "feedback"|"closed", decision?, feedback? }
  → auto-send to agentId OR prefill composer (settings)
  → tab closes
```

### Chrome mode

VS Code Web uses `chrome: "embedded"` (persistent webview, never detached).  
Plannotator uses `chrome: "embedded-transient"` (chrome-less UI, normal create/destroy lifecycle) because each session is a **different port = different origin**.

### Settings

| Setting                     | Default       | Meaning                                                                                                           |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `openMarkdownInPlannotator` | `false`       | When true (and feature available), rendered markdown opens go to Plannotator before VS Code Web / built-in viewer |
| `plannotatorFeedbackMode`   | `"auto-send"` | `"auto-send"` → `sendAgentMessage`; `"compose"` → prefill agent draft                                             |

Explicit **Open → Plannotator** always works when the feature is available, regardless of the markdown default setting.

### Remote hosts

Same reachability model as VS Code Web: the Electron webview loads `http://<host>:<port>` **directly** (not through the E2E relay). The host must be reachable over VPN/LAN. Daemon spawns with `PLANNOTATOR_REMOTE=1` so Plannotator binds `0.0.0.0`. Unauthenticated — keep listeners VPN/loopback-only.

Embed host is derived from the host's `browserEditorUrl` hostname, then `sshHost`, then label.

### Path allowlist

Daemon only annotates paths under the requested `workspaceDir`.

### Concurrency

Max 3 concurrent sessions per session manager; port pool `19432–19463`.

## RPCs

| Message                                           | Direction              |
| ------------------------------------------------- | ---------------------- |
| `plannotator.session.start.request` / `.response` | client ↔ daemon        |
| `plannotator.session.stop.request` / `.response`  | client ↔ daemon        |
| `plannotator.session.event`                       | daemon → client (push) |

Stdout decision shapes (annotate `--json`, v0.22):

- `{"decision":"approved"}`
- `{"decision":"annotated","feedback":"…"}`
- `{"decision":"block","reason":"…"}`
- `{"decision":"dismissed",…}`

## Key files

- `scripts/plannotator/install.sh`
- `packages/server/src/services/plannotator/*`
- `packages/server/src/server/session/plannotator/plannotator-session.ts`
- `packages/protocol/src/plannotator/rpc-schemas.ts`
- `packages/app/src/workspace/open-file-in-plannotator.ts`
- `packages/app/src/workspace/plannotator-feedback.ts`
- Browser chrome: `packages/app/src/stores/browser-store/state.ts` (`embedded-transient`)
