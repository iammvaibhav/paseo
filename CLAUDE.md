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

At the start of non-trivial work, list `docs/` and skim anything relevant to the task.

| Doc                                                                        | What's in it                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [docs/product.md](docs/product.md)                                         | What Paseo is, who it's for, where it's going                                                                                                    |
| [docs/architecture.md](docs/architecture.md)                               | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                                  |
| [docs/agent-lifecycle.md](docs/agent-lifecycle.md)                         | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                                    |
| [docs/data-model.md](docs/data-model.md)                                   | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                                           |
| [docs/glossary.md](docs/glossary.md)                                       | Authoritative terminology — UI label wins, no synonyms                                                                                           |
| [docs/coding-standards.md](docs/coding-standards.md)                       | Type hygiene, error handling, state design, React patterns, file organization                                                                    |
| [docs/design.md](docs/design.md)                                           | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                                   |
| [docs/forms.md](docs/forms.md)                                             | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                                   |
| [docs/hover.md](docs/hover.md)                                             | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it                   |
| [docs/unistyles.md](docs/unistyles.md)                                     | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                                         |
| [docs/floating-panels.md](docs/floating-panels.md)                         | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash                        |
| [docs/menus.md](docs/menus.md)                                             | The menu engine — popover vs sheet, submenu pages, hover intent, when a decision earns a submenu                                                 |
| [docs/expo-router.md](docs/expo-router.md)                                 | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                                    |
| [docs/file-icons.md](docs/file-icons.md)                                   | Material icon theme integration for the file explorer                                                                                            |
| [docs/providers.md](docs/providers.md)                                     | Adding a new agent provider end-to-end                                                                                                           |
| [docs/forge-providers.md](docs/forge-providers.md)                         | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                                    |
| [docs/custom-providers.md](docs/custom-providers.md)                       | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                                                |
| [docs/plugins.md](docs/plugins.md)                                 | Local plugin manifest, directory source config, RPCs, native surfaces, and attachment sources                                  |
| [docs/service-proxy.md](docs/service-proxy.md)                             | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                                        |
| [docs/code-server.md](docs/code-server.md)                                 | Always-on VS Code Web (code-server) for Open → VS Code Web; install, VPN bind, settings sync                                                     |
| [docs/webhooks.md](docs/webhooks.md)                                       | Webhooks: HTTP-triggered agents, configurable tunnels (Tailscale Funnel / cloudflared), URL token + HMAC auth, templating                        |
| [docs/history-ask.md](docs/history-ask.md)                                 | History Ask: agentic history search (metadata filter + labeled allow-all agents with structured brief)                                           |
| [docs/mission-control.md](docs/mission-control.md)                         | Mission Control: fleet board, self-reported status feed, Commander + ephemeral Verifiers, Ask/Auto approval gate, fleet search                   |
| [docs/commander.md](docs/commander.md)                                     | Commander north star: the three layers, runtime model (per-turn snapshots), card grammar, placement doctrine, context architecture, tool surface |
| [docs/commander-voice.md](docs/commander-voice.md)                         | Voice front-end for the Commander: Gemini Live proxy, four-tool relay surface, announce policy, TTS test harness                                 |
| [docs/mission-control-roadmap.md](docs/mission-control-roadmap.md)         | Milestones and tasks from today's Mission Control implementation to the commander.md design                                                      |
| [docs/agent-driven-development.md](docs/agent-driven-development.md)       | Orchestrator/worker/verifier methodology: briefs, proof contracts, dev-stack fixtures, forensic verification                                     |
| [docs/plannotator.md](docs/plannotator.md)                                 | Embedded Plannotator: daemon-spawned annotate sessions, feedback → agent, deploy                                                                 |
| [docs/development.md](docs/development.md)                                 | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                                       |
| [docs/observability.md](docs/observability.md)                             | Telling a parked agent from a working one — the stall signature, where the forensic data lives, what to measure                                  |
| [docs/omp-observability-extension.md](docs/omp-observability-extension.md) | omp hook extension that logs model-call lifecycle to a JSONL feed — lets the dormant-turn detector see a model request in flight                 |
| [docs/omp-process-efficiency.md](docs/omp-process-efficiency.md)           | How Paseo owns omp processes, warm-pool claim cost vs resume cost, why idle-release cannot take a pooled process today                           |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)                         | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                                             |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md)           | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                                   |
| [docs/protocol-validation.md](docs/protocol-validation.md)                 | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                                                |
| [docs/terminal-performance.md](docs/terminal-performance.md)               | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                                       |
| [docs/file-observation.md](docs/file-observation.md)                       | Recursive watcher ownership, Linux constraints, teardown invariants, and Parcel comparison                                                       |
| [docs/testing.md](docs/testing.md)                                         | TDD workflow, determinism, real dependencies over mocks, test organization                                                                       |
| [docs/qa.md](docs/qa.md)                                                   | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                                        |
| [docs/mobile-testing.md](docs/mobile-testing.md)                           | Maestro and mobile test workflows                                                                                                                |
| [docs/mobile-panels.md](docs/mobile-panels.md)                             | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                                             |
| [docs/ad-hoc-daemon-testing.md](docs/ad-hoc-daemon-testing.md)             | Isolated in-process daemon test harness                                                                                                          |
| [docs/browser-capture-harness.md](docs/browser-capture-harness.md)         | Real-Electron browser screenshot harness and compositor-surface gotcha                                                                           |
| [docs/android.md](docs/android.md)                                         | App variants, local/cloud builds, EAS workflows                                                                                                  |
| [docs/docker.md](docs/docker.md)                                           | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                                                 |
| [docs/release.md](docs/release.md)                                         | Release playbook, draft releases, completion checklist                                                                                           |
| [docs/terminal-activity.md](docs/terminal-activity.md)                     | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                                         |
| [SECURITY.md](SECURITY.md)                                                 | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                                    |
| [public-docs/hub/security.md](public-docs/hub/security.md)                 | Public Hub guide — trust boundaries, untrusted triggers, provider controls, and output authority                                                 |

### Writing docs

- **Integrate, don't append.** Find the doc that owns the subject and rewrite the part that is now wrong. The standard failure is finishing a task and adding a paragraph to the bottom of the closest-looking doc; ten tasks later the doc is a pile of paragraphs in discovery order. `docs/custom-providers.md` is what that looks like.
- **Don't document logic.** Prose that restates code drifts from the code and loses. Write down what the code can't tell you: why something is shaped the way it is, the gotcha that cost an afternoon, conventions nothing enforces, constraints that span packages or versions. If a reader could get it in two minutes by opening the file, cut it.
- **One fact, one doc.** Every other mention is a link. If you are about to write the same paragraph in two docs, one of them is a link.
- **Respect the layers.** `CONTRIBUTING.md` and this file name things and link out. Activity docs like `docs/qa.md` and `docs/testing.md` set the bar for a kind of work. Subject docs like `docs/unistyles.md` own one thing completely. A layer never re-explains the one below it.
- **One subject per doc.** If the subject doesn't fit in a sentence, split the doc. A section per provider, vendor, or platform is a table plus one worked example.
- **Delete.** Obsolete sections go. Prefer a `packages/app/src/thing.ts:120` reference over a pasted block.
- **New doc?** Add a row to the table above and link it from the docs that should send readers there.
- Code-level facts belong in comments next to the code, not here.

### Doc voice

Plain and short. Second person. State the rule, then the reason when the reason isn't obvious. Match the doc you're editing.

Do not:

- Write a sentence to land a point. "It's not X, it's Y", "That's not a Z, that's a W", and every other setup-and-punchline shape.
- Add a clause that only asserts importance: "and that matters", "which is what keeps it working", "this is critical".
- Use "honest", "robust", "seamless", "powerful", "simply", "just", "delightful".
- Restate something you already said, in different words, for emphasis.
- Hedge with "generally", "typically", or "you may want to" when the answer is "do this".
- Clear your throat: "It's worth noting that", "In order to", "This section covers".

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
- **The protocol stays backward-compatible. Features don't have to.** Read [docs/protocol-compatibility.md](docs/protocol-compatibility.md) before touching `packages/protocol`. The short version:
  - **Protocol contract (always):** an old client parses messages from a new daemon, and a new daemon parses messages from an old client. New fields are optional; never narrow, never remove, never require. Wire schemas stay pure — no `.transform()`, `.catch()`, or `.preprocess()`.
  - **Feature contract (per-feature):** gate the capability once on `server_info.features.*`, then run the feature or tell the user to update the host. No fallback paths, no defensive branches.
  - **Every shim is tagged.** `// COMPAT(name): added in vX, remove after <date>` at the site that has to be deleted. `rg "COMPAT\("` is the cleanup backlog; untagged back-compat is permanent by accident.
  - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

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
  desktop/browser/pane/
    index.electron.tsx ← Electron <webview> implementation
    index.web.tsx      ← plain web fallback
    index.tsx          ← native fallback
  ```
  Import as `@/desktop/browser/pane` — Electron desktop gets the `.electron.tsx` file, browser web gets `.web.tsx`, and native gets the native/base implementation.
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
- **Mission Control** — fleet monitoring and dispatch: deterministic cross-host board, self-reported status feed (`report_status`), Commander agent with idle-flush digest queue, ephemeral proof-auditing Verifiers, Ask/Auto approval gate, daemon peering with sleep-aware errors — see [docs/mission-control.md](docs/mission-control.md)
- `scripts/deploy.sh` for multi-host deploy
- `scripts/omp-stats-fleet.sh` — the stock `omp stats` dashboard over **all three hosts combined**. `omp stats` reads exactly one SQLite file and has no remote/merge support, so the script snapshots each host's `~/.omp/stats.db` (`VACUUM INTO` over ssh via bun), merges them into `~/.omp/profiles/fleet/stats.db`, and serves it with `OMP_PROFILE=fleet omp stats`. No omp fork, no rebuild; your real `~/.omp/stats.db` is never written to. `folder` rows are prefixed with the host name, so the dashboard's **Projects** tab is the per-host breakdown while every other tab is the fleet total. Flags: `--no-sync`, `--merge-only`, `--summary`, `--json`; env `OMP_FLEET_HOSTS` / `OMP_FLEET_PROFILE` / `OMP_FLEET_PORT` (default 3848, one above stock so it never fights a local `omp stats`).

Do day-to-day work on this branch, not on `main`.

### Deployment — always use `./scripts/deploy.sh`

**Always consult and run [`scripts/deploy.sh`](scripts/deploy.sh) for deploy.** Do not freestyle multi-host sync, remote restarts, or “just restart the daemon” with ad-hoc commands unless you are deliberately debugging a single host.

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **How**         | `./scripts/deploy.sh` from the repo root (or `/home/ubuntu/paseo` on iammvaibhav)                  |
| **Daemon home** | `~/.paseo` locally; `/home/vaibhav/.paseo` (blrofc3), `/home/ubuntu/.paseo` (iammvaibhav)          |
| **Port**        | **6767** (production-style host daemon — what the desktop app and remotes use)                     |
| **Desktop**     | Unsigned build → **quit → `rm -rf` → `cp -R` → `open` `/Applications/Paseo.app`** (not Paseo Test) |
| **Not this**    | `npm run dev` / port **6768** / `.dev/paseo-home` is checkout hot-reload only, not deploy          |

**Orchestrator modes** (auto-detected by `uname -s`):

- **MacBook (macOS)** — as before: local = MacBook (daemon restart + desktop build/install), remotes = `blrofc3` + `iammvaibhav`.
- **iammvaibhav (Linux)** — the current home of the migrated `paseo` project. Local = iammvaibhav (daemon build/restart + nudge + services); remotes = `blrofc3` (WireGuard); the **MacBook is a desktop-only job** (`job-macbook-desktop`): deploy ssh's to it (alias `macbook` = `10.7.0.2`), git-syncs the checkout (non-clobbering: dirty/diverged → skip), and runs `PASEO_DESKTOP_ONLY=1` to build → quit → replace → relaunch `Paseo.app`. The job is reachability-gated and **never fatal** — if the MacBook is down or its checkout is dirty, iammvaibhav + blrofc3 still deploy.
- **The MacBook daemon is deliberately NOT restarted by iammvaibhav deploys** — `paseo-dev` agents on the Mac stay untouched until the migration is complete. Its desktop app still talks to the local daemon; iammvaibhav shows up via peering.

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
2. Run `./scripts/deploy.sh` from the repo root — **this is the deploy path.** (Self-detaches; tail `~/.paseo/deploy-logs/latest.log`.) Today the deploy normally runs **from iammvaibhav** (`ssh iammvaibhav 'cd /home/ubuntu/paseo && ./scripts/deploy.sh'` with `PASEO_PASSWORD` set for the nudge).

The script:

1. **Git phase (on the orchestrator host)** — auto-commits any uncommitted changes (commit message written by the `claude` CLI on **Haiku 4.5**, falling back to a timestamp; if pre-commit fails, **Grok 4.5 high** fixes lint/format/typecheck and commits), fetches `upstream`, fast-forwards `origin/main` to `upstream/main`, fast-forwards to whatever `origin/$BRANCH` already has (never force-reverts another host's push), **merges** `upstream/main` into the custom branch (on conflict, `grok` at **Grok 4.5 / `high` effort** resolves markers, stages, fixes pre-commit checks, and completes the merge commit — streaming its output), then **pushes** to `origin`. After the push, post-deploy work runs **in parallel**: each remote host, local daemon restart (after a local `build:server`), local code-server, and the **desktop app** build then install via the formal loop below (on the MacBook, either locally or via the ssh job). Skip desktop with …
2. **Remotes** — each is a parallel post-push job: repoints `origin` to the fork if still on `getpaseo/paseo`, checks out `vaibhav/customizations` from `origin`, installs deps when `package.json` / lockfile changed, builds, and restarts the host's `~/.paseo` daemon (with the self-wake nudge). From the MacBook the remotes are `blrofc3` + `iammvaibhav`; from iammvaibhav the remote is `blrofc3` (via WireGuard) plus the MacBook desktop job.

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
PASEO_SKIP_SYSTEM_PROMPT=1 ./scripts/deploy.sh    # leave each host's daemon.appendSystemPrompt alone
PASEO_NODE_VERSION=22 ./scripts/deploy.sh
```

code-server settings sync uses this Mac’s live `~/.local/share/code-server/User/settings.json` (not the repo template).

The daemon system prompt is version-controlled at [`scripts/paseo-system-prompt.md`](scripts/paseo-system-prompt.md) and pushed into `daemon.appendSystemPrompt` in every host's `~/.paseo/config.json` by `scripts/set-append-system-prompt.mjs`. It syncs **before** the daemons restart on purpose: `DaemonConfigStore` only reads `config.json` at boot and writes its in-memory value back on any later patch, so a prompt written after the restart is reverted by the next settings change. Editing `config.json` by hand on a running daemon has the same problem — change it in Settings → Host → System prompt, or let deploy do it. Note ACP providers (Grok, Cursor, Antigravity) have no system-prompt plumbing and never receive it.

### Local desktop builds (unsigned)

Never run bare `npm run build:desktop` locally — it hangs on notarization, and an ad-hoc build with hardened runtime crashes at launch (dyld "different Team IDs"). Use the unsigned flags above (or let `./scripts/deploy.sh` do it).

**Agents: do not invent install paths.** Always the formal loop in **Desktop install (this fork)** above: target **`/Applications/Paseo.app`**, **quit → `rm -rf` → `cp -R` → `open`**. Never `Paseo Test.app` for day-to-day deploy. Never `cp -R` onto an existing bundle without deleting first. Prefer `./scripts/deploy.sh` (or `PASEO_SKIP_REMOTES=1` for local-only) so build + install stay one path.

**App-only changes** (UI only): `PASEO_SKIP_REMOTES=1 PASEO_SKIP_DAEMON=1 ./scripts/deploy.sh` still builds/installs desktop via the same contract.
