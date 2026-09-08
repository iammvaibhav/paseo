# Web UI harness

Two surfaces, one script. Prefer the user's own browser tabs — they watch the
session the agent drives — and fall back to headless Chromium here when that
machine is asleep.

```bash
node scripts/web-ui-harness.mjs --bootstrap   # print the browser_* recipe
node scripts/web-ui-harness.mjs               # Chromium here, stay alive on CDP 9222
node scripts/web-ui-harness.mjs --once        # Chromium here, screenshot, exit
```

It prints JSON: every host it seeded with that host's sidebar row counts, the
totals, the theme, and the screenshot path. `allHostsServingRows: true` is the
check that matters — a seeded host proves nothing, a host that answers puts rows
on screen. `itsaplanSession: "injected"` means the itsaplan pane can render a
board.

## Theme

Dark by default. `--theme light|auto|zinc|midnight|claude|ghostty|pureBlack`, or
`PASEO_WEB_UI_THEME`, takes any name from `THEME_OPTIONS` in
`packages/app/src/styles/theme.ts`.

Two writes, not one: Paseo reads `theme` out of `@paseo:app-settings`, while the
embedded board is next-themes reading `itsaplan-theme` on **itsaplan's own
origin**. Seed only the first and the pane stays light inside a dark shell, so
the harness visits that origin once to set it there.

## Verify per host, never by page text

A page-wide search for "Connecting" matches unrelated copy, so a half-connected
fleet reads as healthy. Each sidebar row carries its `serverId` in its test id;
count rows per id instead.

## The itsaplan pane needs two hacks

The embed is a cross-origin iframe on a self-signed cert, so out of the box it
renders `chrome-error://` and every project switch looks dead. Chromium is
launched with `--ignore-certificate-errors` for that.

Sign-in then hangs on "Signing in…" forever, because better-auth issues its
cookie `SameSite=Lax` and Chromium drops it in a third-party frame — the same
reason the desktop app uses a `<webview>` (see `itsaplan-webview.electron.tsx`).
The harness mints a session over HTTP and re-adds it as `SameSite=None`.
Credentials come from `ITSAPLAN_EMAIL`/`ITSAPLAN_PASSWORD` or
`--itsaplan-credentials` (default `/tmp/itsaplan-e2e/credentials.json`). Note
better-auth answers an origin-less sign-in with 403, so the request carries an
explicit `Origin`.

## Browser tool: --bootstrap

An agent's `browser_*` tabs are resident webviews inside the **user's desktop
app**, on another machine. Addresses differ from there: this host's WireGuard
`10.7.0.x` may be unreachable and `127.0.0.1:6767` is that machine's own daemon.
`--bootstrap` resolves the addresses that work _from there_ and prints the
`localStorage` seed to paste into `browser_evaluate`.

It never assumes an address. Candidates come from this config, from
`--address srv_x=host:port`, and from the vantage machine's own `peers[]` (which
is how the MacBook knows us as `10.7.0.1` and blrofc3 as its Tailscale
address). Each candidate is probed **from the vantage** over ssh and accepted
only when the `serverId` matches, because `127.0.0.1:6767` answers everywhere
and would silently point a peer's entry at the wrong daemon. `--vantage`
overrides the auto-detected machine; reachable ssh is the proxy for "the browser
tool is up".

### Which origin

Every daemon's fixed CORS allowlist holds loopback origins plus
`https://app.paseo.sh`, and itsaplan's cookie is `SameSite=Lax`. Those two facts
pull in opposite directions, so the emit prints both URLs:

| Origin                                    | Hosts connected             | itsaplan pane                      |
| ----------------------------------------- | --------------------------- | ---------------------------------- |
| `uiUrl` — the vantage's `127.0.0.1:6767`  | all                         | sign-in hangs (third-party cookie) |
| `paneUrl` — `http://<itsaplan host>:6767` | that host only (others 403) | works, same site                   |
| Desktop app                               | all                         | works                              |

Judge a board in the desktop app. Use a browser tab for the fleet sidebar, or
for one host's pane.

## Never click "Add host"

Pairing through the UI is interactive. Seed `localStorage` instead and reload,
the same way `packages/app/e2e/support/helpers/hosts.ts` does. The registry key
is `@paseo:daemon-registry` and each entry is the shape
`buildSeededHost()` produces in
`packages/app/e2e/support/helpers/daemon-registry.ts`, plus a `password` on the
connection.

## serverId is not optional and not local

A registry entry only connects when its `serverId` matches the daemon behind the
endpoint, and a peer's id exists nowhere on this machine. Ask the daemon:

```bash
curl -s -H "Authorization: Bearer $PASEO_PASSWORD" http://10.7.0.4:6767/api/status
# {"status":"server_info","serverId":"srv_...","hostname":"blrofc3",...}
```

`/api/health` needs no auth but carries no id. The harness discovers the local
daemon from `daemon.listen` and every peer from `peers[]` in
`$PASEO_HOME/config.json`, then resolves each id over `/api/status`. Add a peer
to that config and the harness picks it up with no code change.

## Driving it

Attach over CDP from an eval cell:

```js
const tab = await browser.open({ name: "paseo", app: { cdp_url: "http://127.0.0.1:9222" } });
```

or with Playwright directly:

```js
const { chromium } = require("/data/paseo/node_modules/@playwright/test");
const page = (await chromium.connectOverCDP("http://127.0.0.1:9222")).contexts()[0].pages()[0];
```

Sidebar test ids are stable handles: `sidebar-project-row-<viewKey>`,
`sidebar-project-itsaplan-<viewKey>`, `sidebar-workspace-row-<key>`.

## Gotchas

- There is no display server here, so Chromium runs headless. Use screenshots.
- `--user-data-dir` defaults to `/tmp/paseo-web-ui-harness` and keeps the seeded
  registry, so re-runs are fast. Delete it to start clean.
- A deploy restarts the daemon and kills the harness (`exit 143`). Restart it
  after deploying.
- Chromium comes from `/snap/bin/chromium` by default; override with
  `PASEO_WEB_UI_CHROMIUM`. Playwright's own browsers are not installed.
