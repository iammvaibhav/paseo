# Deploy

Paseo fleet deploy ships code changes from the shared `vaibhav/customizations` branch to every host in the inventory. Entry point: [`scripts/deploy.sh`](../scripts/deploy.sh), which runs [`scripts/deploy/main.ts`](../scripts/deploy/main.ts) on Node 22.

## Running deploy

```bash
./scripts/deploy.sh          # deploy what changed since each host's last deploy, to every host
./scripts/deploy.sh desktop  # only build and install the MacBook app (/Applications/Paseo.app)
```

Options:

- `--hosts a,b` — limit to specific inventory hosts.
- `--force` — redeploy unchanged components too.
- `--dry-run` — print the plan; make no commits, pushes, or host changes.
- `--commit "msg"` — commit uncommitted changes with this subject before deploying.
- `--merge-upstream` — merge `upstream/main` before pushing to `origin`.
- `--foreground` — stay attached in the terminal (default detaches).

### Execution model, logs, and lock

Deploy detaches into its own process session by default so cancelling an agent tool or closing your terminal cannot kill a run mid-flight.

- **Follow progress:** `tail -f ~/.paseo/deploy-logs/latest.log`
- **Run directories:** `~/.paseo/deploy-logs/run-<timestamp>/` contains `deploy.log` and per-host logs (`job-<host>.log`).
- **Concurrency:** `~/.paseo/deploy.lock` holds the active PID. A second run refuses to start while another deploy is active.

### Git rules

- Deploy runs only from `vaibhav/customizations`. It refuses other branches.
- Deploy owns pushing to `origin`. Worktrees merge locally into `vaibhav/customizations` via [`scripts/land-worktree.sh`](../scripts/land-worktree.sh); do not push to `origin` directly.
- Uncommitted changes stop deploy unless `--commit "<subject>"` is passed.
- Merging `upstream/main` (`--merge-upstream`) stops on conflict with the merge left in progress. Resolve the conflict, commit, and rerun deploy. Deploy never invents commit subjects or resolves conflicts.

## Inventory (`~/.paseo/fleet-hosts.json`)

The inventory defines all fleet machines. See [`scripts/deploy/fleet-hosts.example.json`](../scripts/deploy/fleet-hosts.example.json) for the format:

- `name`: host identifier (`iammvaibhav`, `blrofc3`, `prod`, `dell-server`, `macbook`).
- `ssh`: SSH host alias from `~/.ssh/config`.
- `address`: NetBird IPv4 address.
- `dns`: NetBird DNS name.
- `platform`: `linux-arm64`, `linux-x64`, `darwin-arm64`, or `darwin-x64`.
- `role`:
  - `builder` — has a checkout and builds packages locally.
  - `target` — has no checkout; receives pre-built tarballs from its `buildFrom` builder.
- `buildFrom`: for targets, the name of the builder that packages their runtime (e.g. `iammvaibhav` for `prod`, `blrofc3` for `dell-server`).
- `daemon`: `systemd` (Linux) or `desktop` (MacBook).
- `tunnel`: `""`, `"cloudflared"`, or `"tailscale-funnel"`.
- `artifactDir`: directory on builders where tarballs stage.
- `profile`: configuration profile name passed to service installers (`local`, `blrofc3`, `iammvaibhav`).
- `services`: array of enabled services: `omp`, `code-server`, `plannotator`, `voice`, `stall-cron`, `macbook-watch`, `omp-proxy`.

To add a host, add an entry to `~/.paseo/fleet-hosts.json` and run `./scripts/deploy.sh`. For new targets, deploy generates a daemon password automatically and saves it to `~/.paseo/deploy.env`.

## Secrets (`~/.paseo/deploy.env`)

Secrets live in `~/.paseo/deploy.env` (`chmod 600`) on the deploy host:

- `PASEO_PASSWORD` — daemon auth password for the local host.
- `PASEO_HOST_PASSWORD_<HOST>` — peer passwords for remote hosts (e.g. `PASEO_HOST_PASSWORD_PROD`).
- `VERCEL_TOKEN` — token for publishing web exports to Vercel (skips Vercel when unset).
- `GEMINI_API_KEY` — API key for Commander Voice.
- `PASEO_COMMANDER_VOICE_PASSWORD` — daemon password used by the voice service.
- `GITHUB_TOKEN` — optional GitHub token to raise rate limits during `omp update`; falls back to `gh auth token`.

## Change detection

Each host stores component commits in `~/.paseo/deploy-state.json`. A component is redeployed only when files under its paths changed since that commit, or on `--force`.

Component paths live in [`scripts/deploy/plan.ts`](../scripts/deploy/plan.ts):

- `daemon`: server, CLI, client, protocol, relay, highlight, plugin packages, the lockfile, and patches. Changes to the deploy tooling itself (`scripts/deploy/**`) never restart a daemon.
- `app`: desktop package, daemon paths, and app UI paths.
- `vercel`: app UI paths and client dependencies.
- `code-server`: `scripts/code-server`.
- `plannotator`: `scripts/plannotator`.
- `voice`: `scripts/commander-voice`.
- `omp-proxy`: `scripts/omp-proxy` and `plugins/` (also redeploys when the fleet omp version changes).

### Routine steps

Every deploy runs idempotent routine steps on selected reachable hosts:

1. **omp:** updates `omp` to match the deploy host's version, installs plugins from `plugins/`, and syncs the verifier agent role ([`scripts/set-omp-verifier-role.mjs`](../scripts/set-omp-verifier-role.mjs)).
2. **Services:** refreshes stall-cron and macbook-watch if listed in host services, and verifies tunnel configuration.
3. **code-server settings:** pushes the deploy host's live `~/.local/share/code-server/User/settings.json` merged with remote settings; restarts code-server only when settings changed.
4. **Config sync:** writes peer definitions, DNS hostnames, system prompt ([`scripts/paseo-system-prompt.md`](../scripts/paseo-system-prompt.md)), and enables the web UI on every reachable daemon, then runs `paseo daemon reload`.

## Build-once runtime layout

Deploy builds once per platform:

1. **Linux builders** (`iammvaibhav` linux-arm64, `blrofc3` linux-x64) build the server and web UI, then bundle a standalone runtime tarball via [`scripts/deploy/host/package-runtime.mjs`](../scripts/deploy/host/package-runtime.mjs).
2. **Linux targets** (`prod`, `dell-server`) receive the tarball over SSH, verified with SHA-256 checksums. Targets never clone the repository or run builds.
3. **Activation:** [`scripts/deploy/host/activate-runtime.sh`](../scripts/deploy/host/activate-runtime.sh) unrolls the runtime under `~/.local/share/paseo/releases/<release>`, atomically swaps the symlink `~/.local/share/paseo/current`, links `~/.local/bin/paseo`, updates the systemd user service `paseo-daemon.service`, and restarts the unit. Only the currently running release is retained on disk.

## MacBook desktop contract

The MacBook is a builder with `daemon: "desktop"`.

- [`scripts/deploy/host/desktop-app.sh`](../scripts/deploy/host/desktop-app.sh) builds unsigned Electron packages (`CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build:desktop`).
- Before replacement, it copies `/Applications/Paseo.app` to `/Applications/Paseo (Orig).app` as a fallback.
- It stops running Paseo processes, deletes `/Applications/Paseo.app`, copies the new build into place, and opens the app.
- [`scripts/deploy/host/desktop-daemon.sh`](../scripts/deploy/host/desktop-daemon.sh) restarts the MacBook daemon only when daemon code changed. It snapshots running agents with [`scripts/deploy-nudge.mjs`](../scripts/deploy-nudge.mjs), restarts the supervisor worker via [`scripts/restart-local-daemon.sh`](../scripts/restart-local-daemon.sh), and nudges the snapshot so agents resume on the new worker.

## Recovery

### Restarting a Linux daemon

Linux daemons run under systemd:

```bash
systemctl --user restart paseo-daemon.service
systemctl --user status paseo-daemon.service
```

### Rolling back

Hosts keep only the running release, so going back means shipping a new commit: revert the bad commit on `vaibhav/customizations` and deploy. Change detection redeploys exactly the components the revert touches.

```bash
git revert <bad-commit>
./scripts/deploy.sh
```
