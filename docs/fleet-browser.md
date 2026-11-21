# Fleet browser windows

Agents browse in the fleet's always-on Chromes (prod, home, work: Chrome on a Selkies
desktop, driven over CDP with `agent-browser`; see the `fleet-browser` skill). Paseo
shows the windows an agent opened in a **Browser** tab in the workspace's Explorer and
lets the user take control of one and hand it back.

## Who owns what

| Piece                                                | Owner                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The Chromes, Selkies, CDP proxy                      | flotilla's `browser` component on each host                                                                                          |
| Which Chromes a daemon may use                       | `<PASEO_HOME>/fleet-browser.json`, written by flotilla's `paseo` bundle                                                              |
| Which agent opened which window, and who controls it | the daemon that owns the agent (`packages/server/src/server/fleet-browser/`, persisted in `<PASEO_HOME>/fleet-browser/windows.json`) |
| Watching and taking over                             | the app (`packages/app/src/fleet-browser/`)                                                                                          |

`fleet-browser.json` lives outside `config.json` because `config.json` is parsed strictly:
an unknown key would break any daemon that predates this feature. The daemon re-reads
it every 5 s.

## Agent contract

Agents open and close windows with caller-bound Paseo tools (`fleet_browser_open`,
`fleet_browser_close`, `fleet_browser_list`, `fleet_browser_handoff`). The daemon binds
each catalog to its calling agent, which is the only reliable owner: `PASEO_AGENT_ID` in
an agent's shell can belong to another agent (see the verification gotchas). Remote
`/mcp/fleet` clients never get these tools.

`fleet_browser_open` does what the skill's `browser.py open` does (new window, optional
fresh browser context, agent-browser session bound by writing
`<socketDir>/<session>.target` before the first attach). The daemon and its agents share
`HOME` and `XDG_RUNTIME_DIR`, so the session the daemon binds is the one the agent's
`agent-browser --session S` reaches.

Windows are never closed automatically: the agent closes them, and the user can close a
leftover from the tab. A window closed outside Paseo (live view, Chrome restart)
disappears at the next reconcile, which runs every 15 s while windows exist and before
every list.

## Take-over

| Action       | Daemon state                | Agent hears                                                                                                              |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Take control | owner `user`, window raised | a "Browser takeover" `<paseo-system>` notice, steered into its turn, only if it is running                               |
| Hand back    | owner `agent`               | a "Browser resume" notice with the page before and after and the user's note: steered when running, a new turn when idle |
| Release      | owner `agent`               | "Browser control returned", only if it was told about the take-over and is still running                                 |

The notice is the soft pause: an agent-browser command already in flight still lands,
and an agent that ignores the notice can keep typing. The one hard rule is
`fleet_browser_close`: the daemon refuses it while the user has control. Providers
without live steering get the notice by replacing the running turn.

## Live view

Selkies streams the whole desktop, and the desktop shows only the top window (labwc
maximizes every window), so the tab raises the window it shows (`Target.activateTarget`).
Other windows show CDP screenshots, which work on covered windows; the CDP screencast
does not.

- Watching uses the view-only Selkies client (`<liveViewUrl>/#shared`): it sends no
  input. A shield above the frame keeps clicks and keys in Paseo.
- Take control opens the full client in a window-sized overlay.

Every fleet desktop has one fixed size at 96 DPI, set by flotilla's browser component
(`browser.width` x `browser.height`, 16:10 to fill the tab's frame), and every viewer
scales it. Selkies otherwise lets each full client (Take control, the live view in a
browser tab, a phone or tablet) resize the shared desktop and its DPI to its own
screen. A portrait tablet then turns the desktop vertical for every viewer, and a
viewer watching through a resize can get only its top-left corner while the capture
catches up.

The frame is only mounted while the tab is on screen; every connected viewer costs the
browser host CPU.

The fleet's Selkies streams H.264, decoded with WebCodecs. WebCodecs exists only in a
secure context, and an iframe is secure only when every page above it is: the desktop
app (`paseo://`, a privileged secure scheme), the https web app and `localhost` qualify.
The daemon-served web UI over `http://<NetBird IP>` does not: there the frame has no
`VideoDecoder` and the live view stays black, while thumbnails still update.
Playwright's bundled Chromium has no H.264 decoder at all, so `fleet-browser-tab` starts
a throwaway browser from the same image that streams JPEG
(`scripts/verify/checks/fleet-browser-tab.mjs`).
