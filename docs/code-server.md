# Always-on VS Code Web (code-server)

Paseo's desktop **Open → VS Code Web** entry opens the current workspace folder in an in-app tab against a per-host code-server URL (`HostProfile.browserEditorUrl`). That tab reuses the browser webview with no address bar / toolbar (`BrowserRecord.chrome = "embedded"`).

## URLs used in this fork

| Host                      | Bind                  | URL to put in Settings → host → **VS Code Web URL** |
| ------------------------- | --------------------- | --------------------------------------------------- |
| Local Mac                 | `127.0.0.1:8765`      | `http://127.0.0.1:8765`                             |
| `blrofc3` (Tailscale)     | `100.105.100.71:8765` | `http://blrofc3:8765`                               |
| `iammvaibhav` (WireGuard) | `10.7.0.1:8765`       | `http://iammvaibhav:8765`                           |

`blrofc3` / `iammvaibhav` must resolve on the Mac (they already do via `/etc/hosts` or mDNS in this setup). Auth is `none` because the listeners are VPN/loopback-only.

## Install / service units

Artifacts live in `scripts/code-server/`:

- `config.local.yaml` / `config.blrofc3.yaml` / `config.iammvaibhav.yaml`
- `sh.paseo.code-server.plist` — macOS LaunchAgent
- `paseo-code-server.service` — Linux user systemd unit
- `user-settings.json` — shared defaults (trust off, no welcome, hidden activity bar)
- `paseo-bridge/` — the in-place file-open extension (see below)
- `install.sh` — install/update the standalone binary, write config + settings, install the bridge extension, restart the service
- `sync-user-data.sh` — rsync User/ + extensions/ from this machine to the remotes

Binary: standalone install under `~/.local/bin/code-server` (latest, or pin with `CODE_SERVER_VERSION`).

### Deploy / update (preferred)

`./scripts/deploy.sh` deploys code-server on local + remotes after the daemon sync (binary update, config, service restart). **User settings** come from this Mac’s live `~/.local/share/code-server/User/settings.json` (pushed to remotes automatically). The repo `user-settings.json` is only a bootstrap fallback when no live file exists yet. Overrides:

```bash
PASEO_SKIP_CODE_SERVER=1 ./scripts/deploy.sh              # daemon only
PASEO_SYNC_CODE_SERVER_USER_DATA=1 ./scripts/deploy.sh    # also rsync full User/ + extensions/
CODE_SERVER_VERSION=4.127.0 ./scripts/deploy.sh           # pin binary version
```

Or deploy one host directly:

```bash
./scripts/code-server/install.sh local
./scripts/code-server/install.sh blrofc3      # run on that host (or via sync script)
./scripts/code-server/install.sh iammvaibhav
```

Workspace trust / Restricted Mode is disabled by default (`--disable-workspace-trust` on the service, plus `security.workspace.trust.enabled: false` in `User/settings.json`) so folders open in full mode.

Startup chrome defaults (also in `User/settings.json`):

- `workbench.startupEditor: "none"` — no Welcome tab
- `workbench.activityBar.location: "hidden"` — no activity bar
- `workbench.secondarySideBar.defaultVisibility: "hidden"` — no secondary side bar (chat/copilot panel)

There is no VS Code setting to start with the **primary** Explorer sidebar closed; close it once with ⌘B / Ctrl+B and that layout is remembered per folder.

### Local Mac

```bash
cp scripts/code-server/config.local.yaml ~/.config/code-server/config.yaml
cp scripts/code-server/user-settings.json ~/.local/share/code-server/User/settings.json
cp scripts/code-server/sh.paseo.code-server.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.paseo.code-server.plist
launchctl kickstart -k gui/$(id -u)/sh.paseo.code-server
curl -I http://127.0.0.1:8765/
```

### Linux remotes (`blrofc3`, `iammvaibhav`)

```bash
# on the remote, after installing ~/.local/bin/code-server
mkdir -p ~/.config/code-server ~/.config/systemd/user ~/.local/share/code-server/User
# copy the matching config.*.yaml → ~/.config/code-server/config.yaml
# copy paseo-code-server.service → ~/.config/systemd/user/
# copy user-settings.json → ~/.local/share/code-server/User/settings.json
systemctl --user daemon-reload
systemctl --user enable --now paseo-code-server.service
sudo loginctl enable-linger "$USER"   # keep running after SSH logout
```

## Desktop app wiring

1. Settings → each host → **VS Code Web URL** (values in the table above).
2. Restart Paseo once after setting URLs so Chromium picks up `--unsafely-treat-insecure-origin-as-secure` for those origins (needed for VS Code webviews/service workers over plain HTTP on VPN IPs). Origins are persisted under the app `userData` dir as `browser-editor-insecure-origins.json` and applied in `packages/desktop/src/features/browser-editor-origins.ts` before `app.whenReady()`.
3. Open a workspace → **Open** dropdown → **VS Code Web** → in-app tab at `http://…:8765/?folder=<workspacePath>` (chrome-less; not a normal browser tab).

### File opens from Paseo

When a host has **VS Code Web URL** set, desktop file opens (chat links, tool paths, explorer) go to that code-server tab instead of Paseo's built-in file viewer. Without the URL (or on mobile), behavior is unchanged.

Implementation notes (easy to forget later):

- URL builder: `packages/app/src/workspace/browser-editor-url.ts`
- Open routing: `packages/app/src/workspace/open-file-in-browser-editor.ts` (`openBrowserEditorTab` / `tryOpenFileInBrowserEditor`, called from `workspace-screen.tsx`). Creates/reuses tabs with `chrome: "embedded"` so `BrowserPane` hides the toolbar.
- code-server has no `?file=` query. Opening a file uses VS Code Web's `payload` map:

  ```
  ?folder=/abs/workspace&payload=[["openFile","vscode-remote:///abs/path/to/file.ts"]]
  ```

  With line/column:

  ```
  ?folder=/abs/workspace&payload=[["gotoLineMode","true"],["openFile","vscode-remote:///abs/path/to/file.ts:12:1"]]
  ```

- An existing VS Code Web browser tab for that host origin is reused. File opens now go through the **paseo-bridge** extension (`browser-store.requestBridgeOpen`) so the file appears **in place with no reload** (see below). A `webview.loadURL` reload only happens for the one-time folder/workbench load or as a fallback when the bridge is unreachable.
- HTTPS is not required on VPN IPs **if** the insecure-origin allowlist includes those origins (see above). Tailscale Serve is optional, not required for this fork's setup.

## Snappy opens: preload + in-place bridge

Two mechanisms make VS Code Web feel instant (Electron desktop only):

**Preload.** When a workspace whose host has a VS Code Web URL becomes active, the app warms a chrome-less `<webview>` in the background (`workspace/preload-browser-editor.ts` → `ensureResidentBrowserWebview`), parked in the resident webview host. "Open → VS Code Web" then adopts that already-booted webview instead of cold-loading it. One warm window per code-server origin; switching workspaces on the same host reuses it (files still open by absolute path, so a stale folder root is only cosmetic).

**In-place file open (paseo-bridge).** code-server reads the `?payload=[["openFile",…]]` map only at workbench startup, so changing it forces a full reload. Instead, the `scripts/code-server/paseo-bridge/` extension runs a loopback HTTP listener (`127.0.0.1:8766`, `PASEO_BRIDGE_PORT` to override) that handles `POST /open {path,line,column}` → `vscode.window.showTextDocument`. The app calls it **same-origin** from the workbench page via code-server's built-in reverse proxy — `fetch("/proxy/8766/open", …)` run through `webview.executeJavaScript` — so there is no new VPN-exposed port and no CORS/insecure-origin change. Keep the port in sync between `extension.js` (`DEFAULT_PORT`) and `packages/app/src/workspace/browser-editor-url.ts` (`CODE_SERVER_BRIDGE_PORT`).

The extension is plain CommonJS (no build step). **Copying the folder into `extensions/` is not enough** — code-server only loads extensions registered in `~/.local/share/code-server/extensions/extensions.json`, so a plain copy is silently ignored (`code-server --list-extensions` won't show it and nothing binds `8766`). `install.sh` therefore packages a `.vsix` with `vsce` and runs `code-server --install-extension …vsix --force`, then restarts the service (skip the whole step with `PASEO_SKIP_CODE_SERVER_EXTENSION=1`). It activates on `onStartupFinished` (i.e. only while a code-server window is open); if two windows race for the port, only the first binds (the rest stand down on `EADDRINUSE`) — fine for the single-window model. Verify with `code-server --list-extensions` (expect `paseo.paseo-bridge`) and `curl http://127.0.0.1:8765/proxy/8766/health` while a window is open.

## Host file browser

A desktop-only **Host files** entry in the left rail (`components/left-sidebar.tsx`) opens a right-side sidebar (`components/host-explorer-sidebar.tsx`) that browses the host filesystem rooted at `/`, independent of any workspace. It reuses the shared `FileExplorerPane` and the existing `file_explorer_request` / download RPCs — the server already accepts an arbitrary `cwd` and only sandboxes navigation _within_ it (`file-explorer/service.ts` `resolveScopedPath`), so no server change is needed. Clicking a file opens it in VS Code Web via `openHostFileInBrowserEditor` (absolute path → bridge, or a cold `?payload` open); the per-row **Download** action works as elsewhere. The sidebar renders inside the workspace screen and targets the active workspace's host, so it appears while a workspace is open.

## Syncing settings & extensions across the three hosts

code-server stores user data under `~/.local/share/code-server/` by default:

- `User/settings.json`, `User/keybindings.json`
- `extensions/`

**Native VS Code Settings Sync (Microsoft/GitHub login) does not work in code-server** — it is intentionally omitted from OSS builds. Copilot / GitHub sign-in is a separate auth flow and does **not** sync settings or extensions across hosts.

Practical options:

1. **rsync from whichever machine you just configured** (script included):

   ```bash
   ./scripts/code-server/sync-user-data.sh
   # or set CODE_SERVER_DATA=/path/to/share/code-server if not using the default
   ```

   Restart code-server on the remotes after a big extension sync (`systemctl --user restart paseo-code-server`).

2. **Git-backed User folder** — keep `User/settings.json` + `keybindings.json` in a private git repo and pull on each host. Extensions still need rsync or a scripted `code-server --install-extension` list.

3. **Syncthing** on `User/` + `extensions/` — live sync, but risky if three code-servers write the same files concurrently.
