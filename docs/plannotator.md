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
  → Electron serves the 22 MB UI bundle from a local cache and proxies its
       small `/api/*` requests to http://<vpn-host>:<port>
       (falls back to the direct remote URL if the local binary/cache is unavailable)
  → browser store id is a normal createBrowserId() uuid (must match
       BrowserAutomationBrowserIdSchema — never `plannotator-<sessionId>`)
  → user annotates / approves
  → accepted submit closes the Paseo tab immediately
  → process exits after Plannotator's built-in grace period; stdout JSON parsed
  → plannotator.session.event { event: "feedback"|"closed", decision?, feedback? }
  → auto-send to agentId OR prefill composer (settings)
  → tab closes
```

### Chrome mode

VS Code Web uses `chrome: "embedded"` (persistent webview, never detached).  
Plannotator uses `chrome: "embedded-transient"` (chrome-less UI, normal create/destroy lifecycle) because each session is a **different port = different origin**.

### Local UI acceleration

Plannotator's upstream UI is a 22.6 MB Vite single-file build and its temporary server
does not compress or cache it. Loading that HTML directly from a remote host takes
roughly 10–15 seconds over VPN.

The desktop app warms a local UI cache from the locally installed `plannotator` binary,
then opens a loopback proxy per review. The proxy serves the large HTML locally and
forwards only the small API calls to the remote session. If the binary version changes,
its size/mtime cache key changes and the UI is extracted again. No Plannotator source
checkout or custom upstream build is required.

The proxy also sets Plannotator's existing preferences:

- auto-close: immediate
- color theme: `neutral`, following system light/dark mode
- grid background: off

After `/api/approve`, `/api/deny`, or `/api/feedback` succeeds, Electron tells the app
to close the review tab immediately. Feedback delivery continues in the background
while the upstream CLI completes its hard-coded 1.5 second response grace period.

### Settings

| Setting                   | Default       | Meaning                                                               |
| ------------------------- | ------------- | --------------------------------------------------------------------- |
| `defaultFileOpener`       | `"paseo"`     | Ordinary file clicks use Paseo, VS Code Web, or Plannotator           |
| `plannotatorFeedbackMode` | `"auto-send"` | `"auto-send"` → `sendAgentMessage`; `"compose"` → prefill agent draft |

Plannotator accepts document and configuration formats (`.md`, `.mdx`, `.txt`, HTML,
YAML, JSON, TOML, INI, CSV, logs, XML, and related formats). When it is selected as
the default, unsupported source-code files open in Paseo instead. Explicit
**Open → Plannotator** remains available independently of the default.

Cmd/Ctrl-click is an explicit side-pane disposition and always opens in Paseo.

### Remote hosts

Same reachability model as VS Code Web: the Electron webview loads `http://<host>:<port>` **directly** (not through the E2E relay). The host must be reachable over VPN/LAN. Daemon spawns with `PLANNOTATOR_REMOTE=1` so Plannotator binds `0.0.0.0`. Unauthenticated — keep listeners VPN/loopback-only.

Embed host is derived from the host's `browserEditorUrl` hostname, then `sshHost`, then label.

### Path allowlist

Daemon only annotates paths under the requested `workspaceDir`.

### Concurrency

Max 3 concurrent sessions per session manager; port pool `19432–19463`.

- Re-opening the **same path** reuses the live session (no second process).
- At the cap, the **oldest** session is stopped so a new open can proceed.
- Closing a Plannotator browser tab calls `plannotator.session.stop` so slots free immediately.

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
