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

Four tools, no more: `fleet_status` (instant board summary), `commander_dispatch`
(ack immediately, never await the turn), `proposal_respond` (same RPC as the
app's cards), `pending_updates` (drain the update buffer).

Announce policy (in the voice system prompt + the proxy's event filter): only
proposal events and needs-you blockers are injected into the live session and
spoken; everything else (started, finished, milestones, verdicts) queues
silently into a capped ring buffer drained by `pending_updates`. Destructive
proposals repeat the classification aloud and require an explicit
"yes, approve".

## Files

- `server.js` — HTTP + WS proxy (browser <-> Gemini Live), announce policy wiring.
- `lib/daemon.js` — daemon connection, event filter, update buffer.
- `lib/tools.js` — the four tool declarations + executors.
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
`UPDATE_BUFFER_CAP` (default 64), `TLS_KEY_PATH`/`TLS_CERT_PATH` (plain HTTP
is fine for dev; localhost is a secure context for the mic).

## Tests

Both need the dev daemon (`.dev/paseo-home`, port 6768, password vaibhav123)
with a Commander provisioned (boot does it) — never 6767.

```bash
node --test test/logic.test.mjs     # text-mode harness, no microphone
node test/e2e-audio.mjs             # audio proof: TTS -> Live -> tool call
```

Logic harness asserts: the announce-policy filter; the fleet_status executor;
a text turn drives the Live model to call `fleet_status` (audio reply
streamed); `commander_dispatch` lands on the Commander's timeline; a proposal
push produces an injected spoken turn; `proposal_respond` flips the proposal
in the dev store; routine started/finished events buffer silently and
`pending_updates` drains them.

The audio proof synthesizes "what is the fleet status" (fish.audio if credited,
else gemini-2.5-flash-preview-tts, else macOS `say`), streams it into the Live
session with mic cadence (160 ms chunks, 30 ms apart — the Live speech
detector ignores blobs), asserts `fleet_status` was called, and saves audio +
transcript under `/tmp/commander-voice-e2e/`.
