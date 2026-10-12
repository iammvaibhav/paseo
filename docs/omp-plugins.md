# Omp plugins

The `plugins/` directory contains Oh My Pi (omp) plugins versioned in this repository. Keeping them in-repo ensures `./scripts/deploy.sh` installs the identical plugin set and agent routing rules across every host.

## Included plugins

| Plugin                | Source   | Purpose                                                                                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omp-account-routing` | In-house | Per-host and per-project OAuth account routing for omp. Strategy reference: [`plugins/omp-account-routing/README.md`](../plugins/omp-account-routing/README.md). |
| `omp-grok-build`      | Vendored | Grok Build OAuth provider integration. Provenance and local changes: [`plugins/omp-grok-build/UPSTREAM.md`](../plugins/omp-grok-build/UPSTREAM.md).              |

## Plugin loading in omp

omp discovers plugins under `~/.omp/plugins/node_modules/`. At process start, omp scans each package directory and loads it if `package.json` contains an `omp.extensions` manifest. `~/.omp/plugins/omp-plugins.lock.json` tracks enabled plugins (`{ "plugins": { "<name>": { "version": "...", "enabledFeatures": null, "enabled": true } } }`). Bun loads TypeScript entry points directly without a build step.

## Installer behavior

Run the installer directly:

```bash
bash plugins/install.sh [label]
```

`plugins/install.sh` manages installation under `~/.omp/plugins/`:

- **Copies source directories.** Plugins are copied into `~/.omp/plugins/node_modules/<name>` rather than symlinked. A symlink binds every omp process on the host to a single checkout and branch; worktrees are disposable and branch switches would silently alter agent routing.
- **Content stamp.** The script writes `.paseo-install-stamp` containing a SHA-256 hash of the plugin source tree. Re-running the script is a no-op when the stamp matches.
- **Preserves foreign installs.** A directory the installer did not create, or a symlink left by `omp plugin link`, is moved aside rather than deleted.
- **Preserves disabled state.** The installer only defaults `enabled: true` for newly added lock entries. It never re-enables a plugin manually disabled on that host.
- **Process lifecycle.** omp reads extensions only at process start. Running omp processes are unaffected; updates apply to newly spawned agents.

## Deploy stage

[`./scripts/deploy.sh`](../scripts/deploy.sh) installs in-repo plugins on every host that enables `"omp"` in its `services` list in `~/.paseo/fleet-hosts.json`. Hosts with a checkout run `bash plugins/install.sh <hostname>` directly.

## omp version

Every host runs the same `omp` release. Deploy updates `omp` on the deploy host first, treats that version as the fleet target, and ensures each host running `omp` matches. Each host gets the build for its own architecture (`linux-arm64`, `linux-x64`, `darwin-arm64`).

On each host with `omp`, the routine deploy sequence updates `omp`, installs plugins, and syncs the verifier agent role ([`scripts/set-omp-verifier-role.mjs`](../scripts/set-omp-verifier-role.mjs)).

Prod is an inventory target with the `"omp-proxy"` service rather than a Paseo daemon host. It runs the omp auth broker that each host's `~/.omp/agent/config.yml` points at (`auth.broker`), plus `omp-proxy`, `omp-grok-refresher`, and Bifrost. When the fleet omp version changes, deploy redeploys the prod omp services ([`scripts/omp-proxy/README.md`](../scripts/omp-proxy/README.md)) to stay version-locked.

## Adding a plugin

Add a directory under `plugins/` containing a `package.json` with an `omp.extensions` manifest:

```json
{
  "name": "omp-example-plugin",
  "version": "0.1.0",
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

`plugins/install.sh` discovers and installs any directory under `plugins/` carrying an `omp.extensions` key. Any directory whose `package.json` lacks that key is skipped.

## Formatting

`plugins/**` is excluded from the repo formatter and linter (`.oxfmtrc.json`, `.oxlintrc.json`). These plugins follow omp's own style, which uses tabs, and `omp-grok-build` has to stay diffable against its upstream clone.
