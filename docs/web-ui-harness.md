# Web UI harness

One command gives an agent the real Paseo web UI with every host connected:

```bash
node scripts/web-ui-harness.mjs            # seed, verify, stay alive on CDP 9222
node scripts/web-ui-harness.mjs --once     # seed, verify, screenshot, exit
```

It prints JSON: the hosts it seeded, the sidebar projects it saw, the workspace
row count, and the screenshot path. `anyHostNotConnected: false` means the UI
reached every daemon.

## Why not the agent-browser tabs

An agent's `browser_*` tabs are resident webviews inside the **user's desktop
app**, which runs on another machine. In those tabs `127.0.0.1:6767` is that
machine's daemon, and this host's WireGuard peers (`10.7.0.x`) are unreachable —
seeding a host registry there connects nothing and the host card sits on
`Connecting` forever. The harness runs Chromium on the host that owns the
network, so all three daemons are reachable.

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
