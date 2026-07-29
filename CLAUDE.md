# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, and Pi.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online; the docs capture gotchas and conventions you cannot derive from the code or external sources.

At the start of non-trivial work, list `docs/` and skim anything relevant to the task. When you learn something meta worth preserving — a gotcha, a convention, a workflow, a piece of system context that will outlive the current task — update an existing doc or propose a new one. Code-level facts belong in inline comments next to the code; system, process, and gotcha-level facts belong in `docs/`.

| Doc                                                                | What's in it                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [docs/product.md](docs/product.md)                                 | What Paseo is, who it's for, where it's going                                                                                  |
| [docs/architecture.md](docs/architecture.md)                       | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                |
| [docs/agent-lifecycle.md](docs/agent-lifecycle.md)                 | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                  |
| [docs/data-model.md](docs/data-model.md)                           | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                         |
| [docs/glossary.md](docs/glossary.md)                               | Authoritative terminology — UI label wins, no synonyms                                                                         |
| [docs/coding-standards.md](docs/coding-standards.md)               | Type hygiene, error handling, state design, React patterns, file organization                                                  |
| [docs/design.md](docs/design.md)                                   | Theme tokens — colors, fonts, spacing, radii, icons                                                                            |
| [docs/forms.md](docs/forms.md)                                     | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                 |
| [docs/hover.md](docs/hover.md)                                     | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it |
| [docs/unistyles.md](docs/unistyles.md)                             | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                       |
| [docs/floating-panels.md](docs/floating-panels.md)                 | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash      |
| [docs/expo-router.md](docs/expo-router.md)                         | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                  |
| [docs/file-icons.md](docs/file-icons.md)                           | Material icon theme integration for the file explorer                                                                          |
| [docs/providers.md](docs/providers.md)                             | Adding a new agent provider end-to-end                                                                                         |
| [docs/forge-providers.md](docs/forge-providers.md)                 | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                  |
| [docs/custom-providers.md](docs/custom-providers.md)               | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                              |
| [docs/service-proxy.md](docs/service-proxy.md)                     | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                      |
| [docs/code-server.md](docs/code-server.md)                         | Always-on VS Code Web (code-server) for Open → VS Code Web; install, VPN bind, settings sync                                   |
| [docs/webhooks.md](docs/webhooks.md)                               | Webhooks: HTTP-triggered agents, configurable tunnels (Tailscale Funnel / cloudflared), URL token + HMAC auth, templating      |
| [docs/history-ask.md](docs/history-ask.md)                         | History Ask: agentic history search (metadata filter + labeled allow-all agents with structured brief)                         |
| [docs/plannotator.md](docs/plannotator.md)                         | Embedded Plannotator: daemon-spawned annotate sessions, feedback → agent, deploy                                               |
| [docs/development.md](docs/development.md)                         | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                     |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)                 | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                           |
| [docs/protocol-validation.md](docs/protocol-validation.md)         | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                              |
| [docs/terminal-performance.md](docs/terminal-performance.md)       | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                     |
| [docs/testing.md](docs/testing.md)                                 | TDD workflow, determinism, real dependencies over mocks, test organization                                                     |
| [docs/mobile-testing.md](docs/mobile-testing.md)                   | Maestro and mobile test workflows                                                                                              |
| [docs/mobile-panels.md](docs/mobile-panels.md)                     | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                           |
| [docs/ad-hoc-daemon-testing.md](docs/ad-hoc-daemon-testing.md)     | Isolated in-process daemon test harness                                                                                        |
| [docs/browser-capture-harness.md](docs/browser-capture-harness.md) | Real-Electron browser screenshot harness and compositor-surface gotcha                                                         |
| [docs/android.md](docs/android.md)                                 | App variants, local/cloud builds, EAS workflows                                                                                |
| [docs/docker.md](docs/docker.md)                                   | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                               |
| [docs/release.md](docs/release.md)                                 | Release playbook, draft releases, completion checklist                                                                         |
| [docs/terminal-activity.md](docs/terminal-activity.md)             | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                       |
| [SECURITY.md](SECURITY.md)                                         | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                  |

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with Biome
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, push to CI and check GitHub Actions instead.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/app/src/components/message.tsx`
  - `npm run format:files -- CLAUDE.md packages/app/src/components/message.tsx`
- **The protocol stays backward-compatible. Features don't have to.** Two separate contracts:
  - **Protocol contract (always):** schema changes must not break parsing in either direction. An old client must still parse messages from a new daemon; a new daemon must still parse messages from an old client.
    - New fields: `.optional()` with a sensible default.
    - Never flip optional → required, remove fields, or narrow types (`string` → `enum`, `nullable` → non-null).
    - Removed fields stay accepted (we stop sending them, not stop reading them).
    - Test with: "does a 6-month-old client still parse this?" and "does a 6-month-old daemon still send something this client accepts?"
    - Wire schemas are pure structural declarations. Do not add `.transform()`, `.catch()`, or `.preprocess()` to WebSocket message schemas; put normalization in an explicit post-validation pass.
    - Plain `z.union()` is forbidden when every branch has a shared literal tag. Use `z.discriminatedUnion()` unless generated-code regression tests prove that specific shape is miscompiled.
    - `.default()` is acceptable on primitive leaves only. Never put defaults on item schemas for large arrays or big inbound containers.
  - **Feature contract (per-feature):** a new feature may require a new daemon capability. The client detects whether the capability is present and either runs the feature or shows "Update the host to use this." That's it.
    - **No fallback paths.** Don't write a degraded version of a new feature that runs on old daemons. Don't fan out across legacy RPCs to simulate a missing capability. The user upgrades or doesn't get the feature.
    - **No defensive branches scattered through the feature.** Capability detection happens in one place; downstream code reads a clean shape.
    - **Capability flags live in `server_info.features.*`** with a single `// COMPAT(featureName): added in v0.1.X, drop the gate when floor >= v0.1.X` comment marking the cleanup site.
    - Existing functionality keeps working across versions — that's the protocol contract doing its job. New-feature degradation is not the goal.
    - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

- **All back-compat shims are tagged and dated for cleanup.** Every shim that exists for old-client/old-daemon support carries a `COMPAT(name)` comment with the version it was added in and a target removal date (typically 6 months out). One grep — `rg "COMPAT\("` — should produce the full list of cleanup work. Don't bury back-compat in untagged `??`-fallbacks or optional-chain tunnels — that's how it stops being deletable.

## Platform gating

The app runs on iOS, Android, web (browser), and web (Electron desktop). Code is cross-platform by default. Gate only when you must. Import gates from `@/constants/platform`.

### The four gates

| Gate                       | Type      | When to use                                                                                                                 |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `isWeb`                    | constant  | DOM APIs — `document`, `window`, `<div>`, `addEventListener`, `ResizeObserver`. This is the **exception**, not the default. |
| `isNative`                 | constant  | Native-only APIs — Haptics, `StatusBar.currentHeight`, push tokens, camera/scanner, `expo-av`.                              |
| `getIsElectron()`          | cached fn | Desktop wrapper features — file dialogs, titlebar drag region, daemon management, app updates, dock badges.                 |
| `useIsCompactFormFactor()` | hook      | Layout decisions — sidebar overlay vs pinned, modal vs full screen, single-panel vs split. From `@/constants/layout`.       |

### Decision matrix

| I need to...                                                   | Use                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Access DOM (`document`, `window`, `<div>`, `addEventListener`) | `if (isWeb)`                                                              |
| Use a native-only API (Haptics, push tokens, camera)           | `if (isNative)`                                                           |
| Use an Electron bridge (file dialog, titlebar, updates)        | `if (getIsElectron())`                                                    |
| Switch layout between phone and tablet/desktop                 | `useIsCompactFormFactor()`                                                |
| Show something on hover, always-visible on native              | `isHovered \|\| isNative \|\| isCompact` (hover only works on web)        |
| Gate to iOS or Android specifically                            | `Platform.OS === "ios"` / `Platform.OS === "android"` (rare, keep inline) |

### Rules

- **Default is cross-platform.** Don't gate unless you have a specific reason.
- **Prefer Metro file extensions over `if` statements.** When a module has fundamentally different implementations per platform, use `.web.ts` / `.native.ts` file extensions instead of runtime `if (isWeb)` branches. Metro resolves the correct file at build time — the unused platform code is never bundled. Reserve `if (isWeb)` for small, inline checks (a single line or a few props). If you find yourself writing a large `if (isWeb) { ... } else { ... }` block, split into separate files instead.
  ```
  hooks/
    use-audio-recorder.web.ts    ← uses Web Audio API
    use-audio-recorder.native.ts ← uses expo-audio
  ```
  Import as `@/hooks/use-audio-recorder` — Metro picks the right file automatically.
- **Use `.electron.ts` / `.electron.tsx` for Electron-only web modules.** Electron is still the Metro `web` platform, but desktop dev/build sets `PASEO_WEB_PLATFORM=electron`, so Metro first looks for `.electron.*` files and falls back to normal `.web.*` files. Use this when the implementation depends on Electron-only behavior such as `webviewTag`, desktop preload APIs, or the Electron bridge. Keep plain browser web in `.web.*`, and keep native fallbacks in the base file or `.native.*`.
  ```
  components/
    browser-pane.electron.tsx ← Electron <webview> implementation
    browser-pane.web.tsx      ← plain web fallback
    browser-pane.tsx          ← native fallback
  ```
  Import as `@/components/browser-pane` — Electron desktop gets the `.electron.tsx` file, browser web gets `.web.tsx`, and native gets the native/base implementation.
- **NEVER use raw DOM APIs without `isWeb` guard.** DOM APIs crash native. Casting a RN ref to `HTMLElement` is a red flag — ensure the block is web-only.
- **NEVER use `onPointerEnter`/`onPointerLeave`.** They don't fire on native iOS.
- **Hover only works on web.** React Native's `onHoverIn`/`onHoverOut` on `Pressable` does NOT fire on native iOS/iPad — the underlying W3C pointer events are behind disabled experimental flags. For hover-to-show UI (kebab menus, action buttons), use `isHovered || isNative || isCompact` so the controls are always visible on native and hover-to-show on web.
- **Don't use Platform.OS as a proxy for layout capabilities.** Use breakpoints for layout decisions, not platform checks.
- **Import `isWeb`/`isNative` from `@/constants/platform`.** Never write `const isWeb = Platform.OS === "web"` locally.

## Debugging

Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log

## Custom fork workflow (iammvaibhav)

This checkout is maintained as a **personal fork** of the official repo, not as a direct clone of `getpaseo/paseo`. `AGENTS.md` and `agents.md` are symlinks to this file (`CLAUDE.md`).

### Git remotes

| Remote     | Repository          | Purpose                                           |
| ---------- | ------------------- | ------------------------------------------------- |
| `upstream` | `getpaseo/paseo`    | Official mainline — rebase source only            |
| `origin`   | `iammvaibhav/paseo` | Personal fork — where the custom branch is pushed |

### Custom branch

All local customizations live on **`vaibhav/customizations`**, branched from `upstream/main`. Current additions include:

- ACP **Allow All** mode for generic ACP providers (Cursor, Grok, etc.)
- **Open in editor over SSH** for remote workspaces (`HostProfile.sshHost`)
- **Open → VS Code Web** via always-on code-server on each host (`HostProfile.browserEditorUrl`) — see [docs/code-server.md](docs/code-server.md)
  - Background **preload** so it opens instantly, and in-place file opens with no reload via the `scripts/code-server/paseo-bridge/` extension
  - Desktop-only **Host files** browser (left rail) rooted at `/`, opening files in VS Code Web
- LaTeX math rendering for agent messages
- **Webhooks** — HTTP-triggered agents (a tab below Schedules) with configurable tunnel providers (Tailscale Funnel / cloudflared), URL-token + optional HMAC auth, and payload templating — see [docs/webhooks.md](docs/webhooks.md)
- **History Ask** — agentic history search from History / project / workspace menus (metadata filter + labeled allow-all agents with a structured brief) — see [docs/history-ask.md](docs/history-ask.md)
- **Plannotator** — embedded markdown annotation review (daemon-spawned sessions, feedback → agent) — see [docs/plannotator.md](docs/plannotator.md)
- `scripts/deploy.sh` for multi-host deploy

Do day-to-day work on this branch, not on `main`.

### Deployment — always use `./scripts/deploy.sh`

**Always consult and run [`scripts/deploy.sh`](scripts/deploy.sh) for deploy.** Do not freestyle multi-host sync, remote restarts, or “just restart the daemon” with ad-hoc commands unless you are deliberately debugging a single host.

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **How**         | `./scripts/deploy.sh` from the repo root                                                           |
| **Daemon home** | `~/.paseo` locally; `/home/vaibhav/.paseo` (blrofc3), `/home/ubuntu/.paseo` (iammvaibhav)          |
| **Port**        | **6767** (production-style host daemon — what the desktop app and remotes use)                     |
| **Desktop**     | Unsigned build → **quit → `rm -rf` → `cp -R` → `open` `/Applications/Paseo.app`** (not Paseo Test) |
| **Not this**    | `npm run dev` / port **6768** / `.dev/paseo-home` is checkout hot-reload only, not deploy          |

#### Agents MUST treat deploy as fire-and-forget

`./scripts/deploy.sh` **self-detaches** by default (new process session via `start_new_session`). The parent exits immediately and prints the log path. **Do not** run deploy under a long-lived agent tool wait that can be cancelled — canceling used to SIGTERM the whole process group and kill desktop/remotes mid-flight even though daemon restarts were already detached.

```bash
# Prefer a clean env so a previous detached child cannot leak state into this shell.
env -u PASEO_DEPLOY_DETACHED -u PASEO_DEPLOY_RUN_DIR -u PASEO_DEPLOY_LOG -u PASEO_DEPLOY_FOREGROUND \
  ./scripts/deploy.sh
# → prints: Detached deploy started pid=… log=~/.paseo/deploy-logs/run-…/deploy.log
# Then poll logs; do not keep a shell parent waiting on deploy.
tail -f ~/.paseo/deploy-logs/latest.log
```

| Log                    | Path                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **Latest full deploy** | `~/.paseo/deploy-logs/latest.log` (symlink)                                               |
| **Latest run dir**     | `~/.paseo/deploy-logs/latest-run/` (jobs: `job-desktop.log`, `job-remote-blrofc3.log`, …) |
| **Mirrors**            | `/tmp/paseo-deploy-run.log`, `/tmp/paseo-deploy-latest-run` → same files                  |
| **PID**                | `~/.paseo/deploy-logs/latest-run/pid` and `/tmp/paseo-deploy-pid`                         |

Interactive / debug (stay attached): `PASEO_DEPLOY_FOREGROUND=1 ./scripts/deploy.sh`.

**Hard rules (agents):**

1. **Expect the detach banner.** A healthy launch prints `Detached deploy started pid=…` and exits the parent immediately. If you instead see only `Continuing detached deploy` with **no** new `Detached deploy started`, the shell is still attached — kill it and relaunch with the `env -u …` form above.
2. **Never set `PASEO_DEPLOY_DETACHED` / `PASEO_DEPLOY_DETACH_TOKEN` yourself.** They are internal child-only. `deploy.sh` only trusts a child that holds the per-run detach token file + is a session leader; leaked env from a previous run always re-detaches.
3. **Never long-wait on deploy in the tool.** Launch, read the printed log path / pid, then poll `~/.paseo/deploy-logs/latest.log` (or the job logs) with short commands.

The script builds server packages, restarts host daemons with **`--home …/.paseo`**, and syncs remotes. Local/remote **daemon** restarts are **new-session detached** (not plain `nohup` — on macOS that still dies with a cancelled agent tool mid-restart) and must observe a **new PID + `/api/health`**. Restarts use the **built CLI** (`~/.local/bin/paseo` / `packages/cli/dist`), never `npx tsx` mid-build. On failure, deploy tries a detached **`daemon start` recovery** before aborting. The **whole deploy** is also detached by default so waiting for health/desktop cannot be killed by tool cancel.

**Local-only restart (agents):** after `npm run build:server`, use:

```bash
./scripts/restart-local-daemon.sh
```

**Recover if a local restart leaves the daemon down:**

```bash
PATH="$HOME/.local/bin:$PATH" paseo daemon start --home "$HOME/.paseo" \
  && curl -fsS http://127.0.0.1:6767/api/health
```

Remote recovery (example):

```bash
ssh blrofc3 'PATH="$HOME/.local/bin:$PATH" paseo daemon start --home "$HOME/.paseo"'
ssh iammvaibhav 'PATH="$HOME/.local/bin:$PATH" paseo daemon start --home "$HOME/.paseo"'
```

### Day-to-day flow

1. Commit changes on `vaibhav/customizations` (or let deploy auto-commit).
2. Run `./scripts/deploy.sh` from the repo root — **this is the deploy path.** (Self-detaches; tail `~/.paseo/deploy-logs/latest.log`.)

The script:

1. **Local Mac** — auto-commits any uncommitted changes (commit message written by the `claude` CLI on **Haiku 4.5**, falling back to a timestamp; if pre-commit fails, **Grok 4.5 high** fixes lint/format/typecheck and commits), fetches `upstream`, fast-forwards `origin/main` to `upstream/main`, **merges** `upstream/main` into the custom branch (on conflict, `grok` at **Grok 4.5 / `high` effort** resolves markers, stages, fixes pre-commit checks, and completes the merge commit — streaming its output), then **pushes** to `origin`. After the push, post-deploy work runs **in parallel**: each remote host, local daemon restart (after a local `build:server`), local code-server, and the **desktop app** build then install via the formal loop below. Skip desktop with `PASEO_BUILD_DESKTOP=0`; retarget with `PASEO_DESKTOP_APP` (COMPAT: `PASEO_DESKTOP_TEST_APP`). Local server compile is not parallel with the desktop build (both write `packages/*/dist`). Models are overridable via `PASEO_COMMIT_MSG_MODEL` / `PASEO_CONFLICT_MODEL` / `PASEO_CONFLICT_EFFORT` / `PASEO_CONFLICT_MAX_TURNS`. A merge commit is used deliberately (simpler + one-pass resolution); linear history is not preserved.
2. **`blrofc3`** and **`iammvaibhav`** — each is a parallel post-push job: repoints `origin` to the fork if still on `getpaseo/paseo`, checks out `vaibhav/customizations` from `origin`, installs deps when `package.json` / lockfile changed, builds, and restarts each host's `~/.paseo` daemon.

No longer requires a clean working tree — uncommitted changes are auto-committed first. The auto-commit runs the pre-commit hook (lint/format/typecheck), so a quality failure aborts the sync before anything is pushed.

#### Desktop install (this fork) — formal contract

**Do you need Paseo Test?** No. `/Applications/Paseo.app` is already an ad-hoc custom build, not a signed production app we must protect. `Paseo Test.app` only matters if you keep a signed release side-by-side (upstream-doc default). **This fork always replaces `Paseo.app`.**

| Layout                            | When                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| Replace `/Applications/Paseo.app` | **Daily custom-fork use** — dock/Spotlight stay the same (what deploy does)                |
| Paseo (Orig) + replace Paseo      | Only if you still have a signed release to keep (manual; not deploy)                       |
| `Paseo Test.app`                  | Safer default in **upstream** docs when you must not touch a signed app — **not our path** |

**Can you replace while the window is open?** Partially:

- **On disk:** macOS can replace the `.app` while the process still runs (process keeps old inodes).
- **In memory:** open windows keep old JS/asar until quit/relaunch. Electron does **not** hot-reload a packaged install.
- **Dangerous:** `cp -R` _onto_ an existing bundle **merges** files → mixed signatures → dyld Team ID crashes. Always **`rm -rf` then `cp -R`**.

**Canonical loop** (what `deploy.sh` → `install_desktop_app` does every time; ~2 min build + ~2s install):

```bash
# 1) build unsigned
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- \
  -c.mac.notarize=false -c.mac.hardenedRuntime=false -p never

# 2) quit → replace → open  (never merge onto an existing .app)
osascript -e 'tell application "Paseo" to quit'
rm -rf /Applications/Paseo.app
cp -R packages/desktop/release/mac-arm64/Paseo.app /Applications/Paseo.app
open /Applications/Paseo.app
```

Expect a brief close/reopen. That is intentional — not a bug.

### Manual equivalents

```bash
git fetch upstream
git checkout vaibhav/customizations
git merge upstream/main            # resolve conflicts, then commit the merge
git push origin vaibhav/customizations

npm run build:server
npx tsx packages/cli/src/index.js daemon restart --home ~/.paseo
```

### Useful overrides

```bash
PASEO_DESKTOP_ONLY=1 ./scripts/deploy.sh          # app UI only: build + install /Applications/Paseo.app + relaunch
PASEO_SKIP_REMOTES=1 ./scripts/deploy.sh          # local only
PASEO_SKIP_LOCAL=1 ./scripts/deploy.sh            # remotes only
PASEO_SKIP_DAEMON=1 ./scripts/deploy.sh          # code-server + settings only (no daemon build/restart)
PASEO_SKIP_CODE_SERVER=1 ./scripts/deploy.sh      # skip VS Code Web deploy
PASEO_SYNC_CODE_SERVER_USER_DATA=1 ./scripts/deploy.sh  # also rsync code-server User/ + extensions/
PASEO_NODE_VERSION=22 ./scripts/deploy.sh
```

code-server settings sync uses this Mac’s live `~/.local/share/code-server/User/settings.json` (not the repo template).

### Local desktop builds (unsigned)

Never run bare `npm run build:desktop` locally — it hangs on notarization, and an ad-hoc build with hardened runtime crashes at launch (dyld "different Team IDs"). Use the unsigned flags above (or let `./scripts/deploy.sh` do it).

**Agents: do not invent install paths.** Always the formal loop in **Desktop install (this fork)** above: target **`/Applications/Paseo.app`**, **quit → `rm -rf` → `cp -R` → `open`**. Never `Paseo Test.app` for day-to-day deploy. Never `cp -R` onto an existing bundle without deleting first. Prefer `./scripts/deploy.sh` (or `PASEO_SKIP_REMOTES=1` for local-only) so build + install stay one path.

**App-only changes** (UI only): `PASEO_SKIP_REMOTES=1 PASEO_SKIP_DAEMON=1 ./scripts/deploy.sh` still builds/installs desktop via the same contract.
