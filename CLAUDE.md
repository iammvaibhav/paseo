# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Antigravity, and Muse Code.

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

| Doc                                                                        | What's in it                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/product.md](docs/product.md)                                         | What Paseo is, who it's for, where it's going                                                                                                                                                            |
| [docs/architecture.md](docs/architecture.md)                               | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                                                                                          |
| [docs/agent-lifecycle.md](docs/agent-lifecycle.md)                         | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                                                                                            |
| [docs/data-model.md](docs/data-model.md)                                   | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                                                                                                   |
| [docs/glossary.md](docs/glossary.md)                                       | Authoritative terminology — UI label wins, no synonyms                                                                                                                                                   |
| [docs/coding-standards.md](docs/coding-standards.md)                       | Type hygiene, error handling, state design, React patterns, file organization                                                                                                                            |
| [docs/design.md](docs/design.md)                                           | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                                                                                           |
| [docs/forms.md](docs/forms.md)                                             | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                                                                                           |
| [docs/hover.md](docs/hover.md)                                             | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it                                                                           |
| [docs/unistyles.md](docs/unistyles.md)                                     | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                                                                                                 |
| [docs/floating-panels.md](docs/floating-panels.md)                         | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash                                                                                |
| [docs/menus.md](docs/menus.md)                                             | The menu engine — popover vs sheet, submenu pages, hover intent, when a decision earns a submenu                                                                                                         |
| [docs/expo-router.md](docs/expo-router.md)                                 | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                                                                                            |
| [docs/notifications.md](docs/notifications.md)                             | Notification tap ownership, native replay and acknowledgement, startup handoff, and payload QA                                                                                                           |
| [docs/file-icons.md](docs/file-icons.md)                                   | Material icon theme integration for the file explorer                                                                                                                                                    |
| [docs/providers.md](docs/providers.md)                                     | Adding a new agent provider end-to-end                                                                                                                                                                   |
| [docs/forge-providers.md](docs/forge-providers.md)                         | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                                                                                            |
| [docs/custom-providers.md](docs/custom-providers.md)                       | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                                                                                                        |
| [docs/plugins.md](docs/plugins.md)                                         | Local plugin manifest, directory source config, RPCs, native surfaces, and attachment sources                                                                                                            |
| [docs/website-i18n.md](docs/website-i18n.md)                               | Website languages: locale URLs, translated Markdown pairs, `{#id}` anchors, Chinese style                                                                                                                |
| [docs/omp-plugins.md](docs/omp-plugins.md)                                 | In-repo Oh My Pi (omp) agent plugins: installer, auto-discovery, account routing, Grok build, and deploy sync                                                                                            |
| [docs/service-proxy.md](docs/service-proxy.md)                             | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                                                                                                |
| [docs/relay-endpoint-security.md](docs/relay-endpoint-security.md)         | Relay E2EE modes: Noise NK mapping, record framing, negotiation, the `requireProtectedSecurity` flag, close codes                                                                                        |
| [docs/code-server.md](docs/code-server.md)                                 | Always-on VS Code Web (code-server) for Open → VS Code Web; install, VPN bind, settings sync                                                                                                             |
| [docs/webhooks.md](docs/webhooks.md)                                       | Webhooks: HTTP-triggered agents, configurable tunnels (Tailscale Funnel / cloudflared), URL token + HMAC auth, templating                                                                                |
| [docs/history-ask.md](docs/history-ask.md)                                 | Agent search at three depths: sidebar search (full text over name/title/id/prompt/status + transcripts), History full-text search, History Ask (agentic, labeled allow-all agents with structured brief) |
| [docs/fleet-state-sync.md](docs/fleet-state-sync.md)                       | Fleet state sync: who owns each fact, how an edge crosses hosts, and the host-locality bug class                                                                                                         |
| [docs/mission-control.md](docs/mission-control.md)                         | Mission Control: fleet board, self-reported status, fleet MCP tools, memory push, the itsaplan bridge, per-host config                                                                                   |
| [docs/agent-driven-development.md](docs/agent-driven-development.md)       | Orchestrator/worker/verifier methodology: briefs, proof contracts, dev-stack fixtures, forensic verification                                                                                             |
| [docs/development.md](docs/development.md)                                 | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP, agent-start span tracing (click→running)                                                                                     |
| [docs/observability.md](docs/observability.md)                             | Telling a parked agent from a working one — the stall signature, where the forensic data lives, what to measure                                                                                          |
| [docs/omp-observability-extension.md](docs/omp-observability-extension.md) | omp hook extension that logs model-call lifecycle to a JSONL feed — lets the dormant-turn detector see a model request in flight                                                                         |
| [docs/omp-process-efficiency.md](docs/omp-process-efficiency.md)           | How Paseo owns omp processes, warm-pool claim cost vs resume cost, why idle-release cannot take a pooled process today                                                                                   |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)                         | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                                                                                                     |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md)           | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                                                                                           |
| [docs/protocol-validation.md](docs/protocol-validation.md)                 | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                                                                                                        |
| [docs/connected-hosts.md](docs/connected-hosts.md)                         | Daemon-owned host registrations, routed SDK scopes, identity and authority boundaries                                                                                                                    |
| [docs/permissions.md](docs/permissions.md)                                 | Semantic daemon permissions, principals, credentials, pairing invitations, and Hub authority                                                                                                             |
| [docs/terminal-performance.md](docs/terminal-performance.md)               | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                                                                                               |
| [docs/agent-stream-performance.md](docs/agent-stream-performance.md)       | Assistant text pipeline — coalescing window, paced reveal, why arrival lumps are smoothed at render                                                                                                      |
| [docs/markdown-renderer.md](docs/markdown-renderer.md)                     | Shared Markdown engine, native selection, links, images and library constraints                                                                                                                          |
| [docs/native-text-selection.md](docs/native-text-selection.md)             | Native diagram grouping, selection boundaries and leading inline image limitations                                                                                                                       |
| [docs/visual-replies.md](docs/visual-replies.md)                           | Visual replies — `<details>` block splitting, the shared chart/page theme on glass, `show_page`/`preview_page`, the page kit, sandbox rules, the localhost port proxy                                    |
| [docs/file-observation.md](docs/file-observation.md)                       | Recursive watcher ownership, Linux constraints, teardown invariants, and Parcel comparison                                                                                                               |
| [docs/testing.md](docs/testing.md)                                         | TDD workflow, determinism, real dependencies over mocks, test organization                                                                                                                               |
| [docs/qa.md](docs/qa.md)                                                   | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                                                                                                |
| [docs/verification.md](docs/verification.md)                               | Verification standard — isolated per-agent stacks, the daemon/ui/fleet tiers, committed check scripts, video proof, archive cleanup                                                                      |
| [docs/mobile-testing.md](docs/mobile-testing.md)                           | Maestro and mobile test workflows                                                                                                                                                                        |
| [docs/mobile-panels.md](docs/mobile-panels.md)                             | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                                                                                                     |
| [docs/explorer-sidebar.md](docs/explorer-sidebar.md)                       | Explorer sidebar, side-pane, and compact workspace sheet host contracts, lifecycle, placement, routing preferences                                                                                       |
| [docs/ad-hoc-daemon-testing.md](docs/ad-hoc-daemon-testing.md)             | Isolated in-process daemon test harness                                                                                                                                                                  |
| [docs/browser-capture-harness.md](docs/browser-capture-harness.md)         | Real-Electron browser screenshot harness and compositor-surface gotcha                                                                                                                                   |
| [docs/web-ui-harness.md](docs/web-ui-harness.md)                           | One command to drive the real web UI with every host connected — registry seeding, serverId discovery, CDP attach                                                                                        |
| [docs/android.md](docs/android.md)                                         | App variants, local/cloud builds, EAS workflows, version codes, F-Droid source builds and store metadata                                                                                                 |
| [docs/docker.md](docs/docker.md)                                           | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                                                                                                         |
| [docs/release.md](docs/release.md)                                         | Release playbook, draft releases, completion checklist                                                                                                                                                   |
| [docs/terminal-worker.md](docs/terminal-worker.md)                         | Terminal worker process model, socket/record/secret, protocol-bump rule and draining, the worker's file copy, Windows desktop                                                                            |
| [docs/deploy.md](docs/deploy.md)                                           | Fleet deploy — change detection, build-once runtime layout, inventory, secrets, logs, and recovery                                                                                                       |
| [docs/terminal-activity.md](docs/terminal-activity.md)                     | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                                                                                                 |
| [SECURITY.md](SECURITY.md)                                                 | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                                                                                            |
| [public-docs/hub/security.md](public-docs/hub/security.md)                 | Public Hub guide — trust boundaries, untrusted triggers, provider controls, and output authority                                                                                                         |

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
pnpm dev                             # Start the dev daemon
pnpm dev:app                         # Start Expo against the dev daemon
pnpm dev:desktop                     # Start Electron desktop dev
pnpm cli -- ls -a -g                 # List all agents
pnpm cli -- daemon status            # Check daemon status
pnpm typecheck                       # Always run after changes
pnpm lint                            # Always run after changes
pnpm format                          # Auto-format with Biome
pnpm format:check                    # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `pnpm cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

When Mo requests an APK, use `pnpm run build:apk:arm64` for an ARM64 build: writes `artifacts/paseo-dogfood-arm64.apk` with diagnostics without starting a device; `pnpm run build:apk` builds all four Android architectures.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Release branches

When the user says "this goes to next", create or
retarget the PR to `next` and preserve that destination through delivery. Follow
[release branch discipline](docs/release.md#release-branch-discipline) for creating
and updating `next`, integrating it after a release, and releasing a hotfix from a tag.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **The live environment is read-only for verification.** The daemons on 6767, the real itsaplan projects, and the user's workspaces hold live data. Verify against an isolated mock fleet (`node scripts/verify/stack.mjs up`, see [docs/verification.md](docs/verification.md)). Use the live environment only when the user explicitly asked for it in this task, or when the behavior cannot be reproduced in the mock and you say so. Even then, additive actions only (create a workspace, add a ticket): never delete, archive, rename, or modify anything that existed before you started.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `pnpm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, push to CI and check GitHub Actions instead.
- Add tests to existing suites and reuse their npm scripts and CI jobs instead of creating feature-specific ones.
- **Always run typecheck and lint after every change.**
- **NEVER run `pnpm install` inside a Paseo dev worktree unless the worktree's own dependencies changed.** Worktrees get their own `node_modules`, but pnpm's content-addressable store (shared across the machine) makes a fresh `pnpm install` fast without any custom symlinking (see "Fast worktrees" in [docs/development.md](docs/development.md)). Running it needlessly still costs a lockfile resolution pass; only do it after changing dependencies on the branch.
- **NEVER `git stash` in a worktree.** Every worktree shares one repository, so `refs/stash` is a single repo-wide stack, not one per worktree. A bare `git stash pop` takes the newest entry pushed by _any_ worktree: it applies another ticket's diff into your tree, drops it, and leaves your own edits stranded on the stack. For a clean tree, commit instead — `git commit -am "wip(<ticket>): <what>"`, then `git reset --soft HEAD~1` when you want them uncommitted again. If you must stash, read `git stash list` first, restore with `git stash apply stash@{N}` (never a bare `pop`), and pin the entry with `git branch wip/<ticket> $(git rev-parse refs/stash)` so a drop or `git gc` cannot reclaim it. See [Worktree git state](docs/development.md#worktree-git-state).
- **Never push directly to `origin` from a worktree.** Commit and merge as soon as your changes are done and verified. Only merge for features and bug fixes — do not merge for analysis or exploratory tasks. Commit on your worktree, merge the local `vaibhav/customizations` branch into your worktree branch, resolve conflicts in your worktree, and fast-forward the local `vaibhav/customizations` branch. Remote pushes belong exclusively to `./scripts/deploy.sh`. See [Landing work from a ticket worktree](#landing-work-from-a-ticket-worktree).
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `pnpm build:client` — rebuild protocol and client declarations.
  - `pnpm build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `pnpm format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use pnpm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the pnpm script:
  - `pnpm lint -- packages/app/src/components/message.tsx`
  - `pnpm format:files -- CLAUDE.md packages/app/src/components/message.tsx`
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
  - Every desktop file open goes to VS Code (chat links incl. `~/…` and folder links, Files sidebar, Changes), Cmd+P opens VS Code's Quick Open, and the Files sidebar browses outside the workspace
  - Switching workspaces swaps the project into one multi-root VS Code window in place, with no page reload (folder 0 is a fixed **⚙ configs** folder)
- LaTeX math rendering for agent messages
- **Visual replies** — terse reply-format rules in the daemon system prompt, collapsible `<details>` evidence, glass-themed chart fences, and agent-built interactive HTML pages inline in chat (`show_page` + `preview_page`, localhost apps proxied to the reader) — see [docs/visual-replies.md](docs/visual-replies.md)
- **Webhooks** — HTTP-triggered agents (a tab below Schedules) with configurable tunnel providers (Tailscale Funnel / cloudflared), URL-token + optional HMAC auth, and payload templating — see [docs/webhooks.md](docs/webhooks.md)
- **History Ask** — agentic history search from History / project / workspace menus (metadata filter + labeled allow-all agents with a structured brief), plus a **sidebar search** bar that narrows the workspace and agent views in place with a full-text pass on every host over each agent's name, title, id, launch prompt, reported status and transcript — see [docs/history-ask.md](docs/history-ask.md)
- **Mission Control** — fleet monitoring: deterministic cross-host board, self-reported status (`report_status`), fleet MCP tools for bots (`/mcp/fleet`, placement-filling `fleet_create_agent`, memory tools), itsaplan tickets dispatched straight to workers, daemon peering with sleep-aware errors. The Commander is a role in `OPERATING.md`, not a built-in agent — see [docs/mission-control.md](docs/mission-control.md)
- `scripts/deploy.sh` for multi-host deploy — see [docs/deploy.md](docs/deploy.md)
- **Vercel-hosted web app** — every deploy publishes `packages/app/dist` to the `paseo-web` Vercel project (`https://paseo-web.vercel.app`), so a phone can open the UI without exposing a daemon and pair over the relay. Config lives in `packages/app/vercel.json`; the token comes from `VERCEL_TOKEN` in `~/.paseo/deploy.env`, and the job skips itself when that is unset.
- `scripts/omp-stats-fleet.sh` — the stock `omp stats` dashboard over **all three hosts combined**, behind the desktop sidebar's **Fleet stats** button. `omp stats` reads exactly one SQLite file and has no remote/merge support, so `scripts/omp-stats-fleet.ts` keeps `~/.omp/profiles/fleet/stats.db` as an incrementally refreshed mirror of each host's `~/.omp/stats.db` and serves it with `OMP_PROFILE=fleet omp stats`. Each refresh sends a host its chunk hashes over one ssh call; the host (`scripts/omp-stats-fleet-export.mjs`, run with bun) returns only the changed chunks, gzipped. Only the first refresh copies everything (~25 MB from dev); later ones take seconds. The button opens the dashboard in the default browser on the last refresh at once and refreshes in the background; reload the page for the new rows. The server stays up until the app quits. A host that fails keeps its previous rows. No omp fork; your real `~/.omp/stats.db` is never written to. `folder` rows are prefixed with the host name, so the dashboard's **Projects** tab is the per-host breakdown. Delete `~/.omp/profiles/fleet` to force a full re-copy. Flags: `--serve`, `--merge-only`, `--summary`, `--json`, `--no-sync`; env `OMP_FLEET_HOSTS` / `OMP_FLEET_PROFILE` / `OMP_FLEET_PORT` (default 3848, one above stock so it never fights a local `omp stats`). Tests: `bun test scripts/omp-stats-fleet.test.ts`.
- **In-repo omp plugins** (`plugins/`) — Oh My Pi agent plugins versioned in-tree and installed to `~/.omp/plugins/node_modules/` across all hosts on deploy: `omp-account-routing` (per-host/per-project OAuth account rotation) and `omp-grok-build` (vendored Grok Build OAuth provider) — see [docs/omp-plugins.md](docs/omp-plugins.md)

Do day-to-day work on this branch, not on `main`.

#### Landing work from a ticket worktree

Ticket work lands on local `vaibhav/customizations` via `./scripts/land-worktree.sh`.
**Only merge for features and bug fixes — do NOT merge for analysis or exploratory tasks.**
Commit and land as soon as changes are done and verified. The trigger words are
**"land it"** / **"merge it"** — both mean: run the script, no push to `origin`
(deploy owns that), no hand-merging in the shared checkout.

```bash
./scripts/land-worktree.sh
```

What the script does: Phase A merges the shared tip into your worktree branch with no
lock held (rerunnable — on conflict it stops with the merge in progress: resolve inside
the worktree, commit, re-run). Phase B takes the land lock (`/tmp/paseo-land.lock`),
re-reads the shared tip, and merges only if the tip has not moved since Phase A — the
check and the merge are one atomic critical section. If the tip moved (another agent
landed concurrently) it aborts and retries from Phase A, up to `PASEO_LAND_ATTEMPTS`
(default 5). The lock is cooperative: it only serializes landers that go through this
script, so never land by hand while another land is in progress. Env overrides:
`PASEO_SHARED_CHECKOUT`, `PASEO_CUSTOM_BRANCH`, `PASEO_LAND_LOCK`,
`PASEO_LAND_LOCK_TIMEOUT`, `PASEO_LAND_ATTEMPTS`.

### Deployment — always use `./scripts/deploy.sh`

Always run [`./scripts/deploy.sh`](scripts/deploy.sh) for deployment. See [docs/deploy.md](docs/deploy.md) for the full guide to modes, options, inventory, secrets, change detection, and recovery.

```bash
./scripts/deploy.sh          # deploy what changed since each host's last deploy, to every host
./scripts/deploy.sh desktop  # only build and install the MacBook app (/Applications/Paseo.app)
```

Options: `--hosts a,b`, `--force`, `--dry-run`, `--commit "msg"`, `--merge-upstream`, `--foreground`.

#### Hard rules

- **Deploy self-detaches by default.** Launch `./scripts/deploy.sh` and tail `~/.paseo/deploy-logs/latest.log`. Never long-wait on deploy inside an agent tool call.
- **Deploy owns pushes.** Worktrees merge locally into `vaibhav/customizations` via [`scripts/land-worktree.sh`](scripts/land-worktree.sh); remote pushes to `origin` belong exclusively to `./scripts/deploy.sh`.
- **You own git history.** Deploy never invents commit subjects and never resolves conflicts. Commit before deploying or pass `--commit "<msg>"`. Merging `upstream/main` (`--merge-upstream`) with conflicts stops deploy with the merge left in progress for manual resolution.
- **Restarting daemons interrupts running agents.** Deploy detects changed components and restarts daemons only when daemon code changed. Avoid deploying while agents are actively executing tasks.
