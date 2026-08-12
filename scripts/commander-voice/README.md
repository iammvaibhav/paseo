# Commander Voice

A voice front-end for the Commander: you talk, it dispatches, the fleet works.
Thin relay between a browser page, the Gemini Live API, and the Paseo daemon —
no second brain. All intelligence stays in the Commander; this node converts
speech to dispatches and daemon events to speech. See
[docs/commander-voice.md](../../docs/commander-voice.md) for the spec.

## Architecture

```mermaid
flowchart LR
    Mic["Browser page (mic + speaker)"] <-->|audio WS| Proxy["Voice node (Node) — Gemini Live proxy + tool executors"]
    Proxy <-->|Live API WS| Gemini["Gemini Live"]
    Proxy <-->|@getpaseo/client WS| Daemon["Daemon (commander host)"]
    Daemon --> Cmd["Commander thread"]
    Daemon -->|mission_control_event push| Proxy
```

Two modes, chosen at session setup (`voiceMode`, default `relay`; env
`VOICE_MODE`, overridden by the Mission Control central config when it
publishes one):

- **relay** — shared read tools (`fleet_list_agents`, `fleet_get_agent_activity`,
  `fleet_search`, `fleet_recall`, `fleet_context`, `tag_message`) plus
  `commander_dispatch` (ack immediately, never await the turn),
  `proposal_respond` (same RPC as the app's cards), and `pending_updates`
  (drain the update buffer). No mutating tool is declared; every fleet change
  goes through the Commander.
- **direct** — the full Commander allowlist plus `proposal_respond` and
  `pending_updates`; mutating executors route through the daemon proposal gate
  so every side effect is still approval-gated.

Announce policy (in the voice system prompt + the proxy's event filter): only
proposal events and needs-you blockers are injected into the live session and
spoken; everything else is buffered only when it belongs to this session's work
(agents this session dispatched to or steered, proposals it created) and is
otherwise dropped. `pending_updates` is pull-only. Destructive proposals repeat
the classification aloud and require an explicit "yes, approve". Every heard
user turn and spoken reply is mirrored into the Commander thread
(`voiceMirrorKind: "qa"`) so text Commander keeps the dialogue.

## Files

- `server.js` — HTTP + WS proxy (browser <-> Gemini Live), announce policy wiring.
- `lib/daemon.js` — daemon connection, event filter, update buffer.
- `lib/tools.js` — mode-aware tool declarations + executors.
- `lib/voice-prompt.js` — the voice system prompt.
- `lib/config.js` — env config; GEMINI_API_KEY resolved at launch (env, else
  ssh iammvaibhav:/home/ubuntu/llm-gateway/.env, never committed).
- `public/index.html` — mic/speaker page.
- `test/logic.test.mjs` — headless text-mode harness (no mic).
- `test/e2e-audio.mjs` — synthesized-command audio proof.

## Run

Dev (against the dev daemon on 127.0.0.1:6768, password vaibhav123):

```bash
npm install          # ws only
PORT=8787 PASEO_PASSWORD=vaibhav123 node server.js
# open http://localhost:8787 and talk
```

The Gemini API key is read at launch (env or over ssh from
iammvaibhav:/home/ubuntu/llm-gateway/.env). The daemon password is required —
there is no anonymous dev default.

Production (on the commander host):

```bash
PORT=8787 PASEO_WS_URL=ws://127.0.0.1:6767/ws \
  PASEO_PASSWORD=<daemon-password> GEMINI_API_KEY=<key> node server.js
```

Optional env: `HOST`, `VOICE_NAME` (default Puck), `GEMINI_MODEL`,
`VOICE_MODE` (default `relay`; `direct` declares the full Commander allowlist —
the Mission Control central config overrides it when it publishes one),
`UPDATE_BUFFER_CAP` (default 64), `TLS_KEY_PATH`/`TLS_CERT_PATH` (plain HTTP
is fine for dev; localhost is a secure context for the mic). `PORT` defaults
to 8787, `HOST` to 0.0.0.0. TLS: when both `TLS_KEY_PATH` and `TLS_CERT_PATH`
are set the node serves HTTPS + WSS; the browser page then connects over
`wss://` automatically.

## Service (commander host)

`install.sh` installs the node as a managed service — launchd LaunchAgent on
macOS (`sh.paseo.commander-voice`), systemd user unit on Linux
(`paseo-commander-voice.service`) — with a generated launcher that sources
nvm + the env file, then execs `server.js`:

```bash
./scripts/commander-voice/install.sh local        # or blrofc3 / iammvaibhav
```

The service targets its LOCAL daemon (`ws://127.0.0.1:6767/ws`, or the host's
actual daemon listen address when derivable). The daemon password hash in the
host's config can't be used by the node (it authenticates over WS), so deploy
writes the plaintext password — plus the Gemini key — once into
`~/.config/commander-voice/env` (chmod 600) from user-set env vars; nothing
secret is committed and re-runs preserve existing values unless overridden:

```bash
PASEO_COMMANDER_VOICE_PASSWORD=<daemon-password> GEMINI_API_KEY=<key> \
  ./scripts/deploy.sh
```

`scripts/deploy.sh` owns the lifecycle (like code-server): install/refresh +
restart on every deploy, opt out with `PASEO_SKIP_COMMANDER_VOICE=1`. After
deploy, point the app's Mission Control settings → Memory → "Voice node URL"
at the node (e.g. `ws://127.0.0.1:8787/ws`) to enable Commander Voice in the
Mission Control composer.

## Tests

Both need the dev daemon (`.dev/paseo-home`, port 6768, password vaibhav123)
with a Commander provisioned (boot does it) — never 6767.

```bash
node --test test/logic.test.mjs     # text-mode harness, no microphone
node test/e2e-audio.mjs             # audio proof: TTS -> Live -> tool call
```

Logic harness asserts: the announce-policy filter; the fleet_list_agents
executor; a text turn drives the Live model to call `fleet_list_agents` (audio
reply streamed); `commander_dispatch` lands on the Commander's timeline; a
proposal push produces an injected spoken turn; `proposal_respond` flips the
proposal in the dev store; routine started/finished events never inject and
unrelated ones never buffer (only session-correlated events do).

The audio proof synthesizes "what is the fleet status" (fish.audio if credited,
else gemini-2.5-flash-preview-tts, else macOS `say`), streams it into the Live
session with mic cadence (160 ms chunks, 30 ms apart — the Live speech
detector ignores blobs), asserts `fleet_list_agents` was called, and saves
audio + transcript under `/tmp/commander-voice-e2e/`.
