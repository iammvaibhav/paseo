# Always-on VS Code Web (code-server)

Paseo's desktop **Open → VS Code Web** entry opens the current workspace folder in an in-app browser tab against a per-host code-server URL (`HostProfile.browserEditorUrl`).

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
- `sync-user-data.sh` — rsync User/ + extensions/ from this machine to the remotes

Binary: standalone install under `~/.local/bin/code-server` (v4.127.x).

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
3. Open a workspace → **Open** dropdown → **VS Code Web** → in-app browser tab at `http://…:8765/?folder=<workspacePath>`.

### File opens from Paseo

When a host has **VS Code Web URL** set, desktop file opens (chat links, tool paths, explorer) go to that code-server tab instead of Paseo's built-in file viewer. Without the URL (or on mobile), behavior is unchanged.

Implementation notes (easy to forget later):

- URL builder: `packages/app/src/workspace/browser-editor-url.ts`
- Open routing: `packages/app/src/workspace/open-file-in-browser-editor.ts` (called from `workspace-screen.tsx`)
- code-server has no `?file=` query. Opening a file uses VS Code Web's `payload` map:

  ```
  ?folder=/abs/workspace&payload=[["openFile","vscode-remote:///abs/path/to/file.ts"]]
  ```

  With line/column:

  ```
  ?folder=/abs/workspace&payload=[["gotoLineMode","true"],["openFile","vscode-remote:///abs/path/to/file.ts:12:1"]]
  ```

- An existing VS Code Web browser tab for that host origin is reused via `browser-store.requestNavigation` (triggers `webview.loadURL`). Payload is only read at workbench startup, so jumping to another file **reloads** that tab — acceptable; we deliberately avoid spawning a new browser tab per click.
- HTTPS is not required on VPN IPs **if** the insecure-origin allowlist includes those origins (see above). Tailscale Serve is optional, not required for this fork's setup.

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
