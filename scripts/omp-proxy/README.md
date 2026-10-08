# omp-proxy

Small Bun + TypeScript server. It exposes OpenAI-style endpoints for
6 subscription providers. It gets the sign-in data from the OMP auth
broker (`omp auth-broker serve`) and calls each provider the same way
OMP does.

Run from source (development):

```sh
bun run start             # the proxy
bun run grok-refresher    # the grok-build refresher (broker host only)
```

## Credentials

The proxy reads credentials only from the OMP auth broker. The broker
runs on prod: `http://prod.netbird.cloud:8770` (NetBird only).

The proxy finds the broker the same way the `omp` command does:

1. `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`, if set.
2. Else `auth.broker.url` and `auth.broker.token` in
   `~/.omp/agent/config.yml`.
3. Else the token file `<home>/.omp/auth-broker.token`.

It does not start if it finds no broker URL. On prod, the broker keeps
its token in `~/.omp/auth-broker.token`.

The broker owns token refresh. The proxy receives credentials without
refresh tokens, and asks the broker to refresh an expired access token.

The broker refreshes only the providers built into OMP. It cannot
refresh `grok-build`, because that provider comes from a plugin
(broker log: `Unknown OAuth provider: grok-build`). To fix this,
`src/grok-refresher.ts` runs on the broker host (prod) as the systemd
user unit `omp-grok-refresher` (`deploy/omp-grok-refresher.service`).
Every 5 minutes it refreshes each `grok-build` token that expires in
less than 30 minutes. It uses the plugin's own refresh call and writes
to the broker's `agent.db` with OMP's refresh lease. The broker sees
the change in `agent.db` and sends the new token to its clients.

It runs as the second mode of the same binary
(`omp-proxy grok-refresher`), so the host stores one Bun runtime.
The plugin code is compiled in.

OMP still opens `agent.db` and `models.db` in the agent folder, and
`<home>/.omp/cache/`, for model and snapshot caches. These files hold
no credentials.

Default bind is `127.0.0.1:4317`. Set `OMP_PROXY_BIND` to change it.
A non-loopback bind refuses to start unless `OMP_PROXY_TOKEN` is set,
or `OMP_PROXY_NO_AUTH=1` is set. When the token is set, `/v1` and `/api`
routes need `Authorization: Bearer <token>`. Use `OMP_PROXY_NO_AUTH=1`
only on a private network (for example NetBird): every peer can then
use all stored subscription sign-ins.

## Endpoints

- `GET /healthz` shows `{ ok: true, version }`.
- `GET /api/providers` lists the 6 providers with accounts and routing.
- `GET /v1/models` lists all models; `GET /v1/{provider}/models` lists one.
- `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages` take
  `model` as `<provider>/<modelId>`, or a bare id with `?provider=<id>`.
- `POST /v1/{provider}/chat/completions|responses|messages` is the same,
  with `model` bare or qualified.
- `GET /api/requests?limit=N` (newest first) and
  `GET /api/requests/{requestId}` show past turns (ring buffer, 500).
- `/`, `/app.js`, `/app.css` serve the UI (embedded from `public/`).

## Per-request controls

Query param wins over header.

- `account` / `x-omp-account`: `auto` (default), `any`, alias, email,
  or credential row id. `auto` uses the routing rules from
  `account-routing.yml` in the agent folder when set, else pi-ai
  selection.
  `any` uses pi-ai selection only. An explicit value pins that sign-in;
  an unknown value gives 400.
- `session` / `x-session-id` (also the standard keys pi-ai reads:
  body `prompt_cache_key`, `metadata.session_id`, headers `session_id`,
  `conversation_id`, `x-prompt-cache-key`, ...). When absent, the proxy
  links the turn to the prior turn it continues (`chain`), else starts
  a new id (`new`).

Account notes:

- pi-ai does not use a pinned sign-in when it has a rate-limit block
  for the model family (for example the Antigravity `counter:google`
  block). It selects a different sign-in, as OMP does. The
  `x-omp-account` response header always shows the sign-in that did
  the request.
- `auto` routing does not use sign-ins that model discovery shows
  without access to the model (Codex `accountAccess`).

## Images

All three formats accept images in user messages and tool results:
chat `image_url`, Responses `input_image`, and Messages `image` with a
`base64` or `url` source.

- **Base64 (`data:` URL)**: the proxy treats it like an image pasted
  into OMP. It converts unsupported formats to PNG and resizes with
  OMP's `resizeImage` defaults (longest edge 1568 px, about 500 KB,
  shortest edge at least 200 px). The output is byte-for-byte the same
  as OMP's. Results are cached, so a resent history is not resized again.
- **`http(s)` URL**: the proxy sends the URL unchanged, without a
  resize, and the provider downloads the image. Some sites refuse
  provider downloaders (robots.txt), and the request then fails with
  the provider's error.
  - Antigravity (Gemini) needs the image type with the URL. The proxy
    sends the URL only when its file extension gives the type
    (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`).
  - Cursor cannot take a URL.
  - For those cases the proxy downloads the image (30 s timeout, 20 MB
    limit) and treats it like a base64 image.
- `file_id` references are not supported (400).

pi-ai's wire parsers (checked on 18.4.3) lose URL images and every image
in Responses-format user messages; `src/images.ts` restores them.

## Build

One compiled file holds the proxy, both plugins and the UI. Build it on
the linux-arm64 dev host only; prod gets the binary.

```sh
bun install --frozen-lockfile
bun run build          # dist/omp-proxy (about 120 MB, linux-arm64)
bun run typecheck
```

`build` and `typecheck` first copy `omp-grok-build` and
`omp-account-routing` from the repo's `plugins/` into `vendor/`
(gitignored), so the proxy always compiles in the same plugin source that
deploy installs on the hosts.

The build marks `omp-legacy-pi-modules` as external. OMP's own build
generates that module so that plugins on disk can import OMP. The proxy
compiles its plugins in and never loads plugins from disk, so it does
not need it.

The binary needs no Bun on the target host. It does need OMP's native
library `~/.omp/natives/<pinned version>/pi_natives.linux-arm64.node`.
`omp` unpacks the library for its own version at first start and deletes
the other versions' libraries, so the proxy only starts on a host whose
`omp` is the pinned version.

## Deployment (prod)

`./scripts/deploy.sh` owns prod through its `prod` job. It builds the
binary on the orchestrator, then on prod runs `omp update`, installs the
changed units from `deploy/`, swaps `~/.local/bin/omp-proxy` (the old one
stays as `omp-proxy.prev`), restarts `omp-auth-broker`, then `omp-proxy` and
`omp-grok-refresher`, and checks `/healthz`. `PASEO_SKIP_PROD=1` skips it;
`PASEO_PROD_HOST` changes the ssh alias.

Prod runs the broker, so the proxy uses the broker's own token file
`~/.omp/auth-broker.token`. One-time setup on a new prod host:

- `~/.omp-proxy/agent/account-routing.yml`: account aliases and routing
  (copy from the dev host). Without it, `auto` uses pi-ai selection and
  aliases do not resolve.
- `systemctl --user enable` for the four units, and `loginctl enable-linger`.

`omp-proxy.service` sets `PI_CODING_AGENT_DIR=~/.omp-proxy/agent`, so
the proxy keeps its caches out of the broker's `~/.omp/agent/agent.db`.

On prod the proxy listens on `127.0.0.1:4317` only. To use it from
another host, open an SSH tunnel:

```sh
ssh -N -L 4317:127.0.0.1:4317 prod   # then use http://127.0.0.1:4317
```

## Bifrost (prod)

Bifrost v2.2.5 (https://github.com/maximhq/bifrost) runs on prod in
front of omp-proxy. It gives a web UI with login and API keys.

- Binary: `~/.local/bin/bifrost-http` (linux-arm64, web UI built in),
  from `https://downloads.getmaxim.ai/bifrost/v2.2.5/linux/arm64/bifrost-http`.
- systemd user unit: `deploy/bifrost.service`. It listens on
  `127.0.0.1:8080`; Caddy fronts it.
- Data folder `~/.bifrost/` (mode 700): `config.json`, `config.db`,
  `logs.db`, and `credentials.txt` with the admin password and the API
  key.
- Provider `omp-proxy` (OpenAI type, base URL `http://127.0.0.1:4317`,
  without `/v1`) with one allowed model. Clients use the model
  `omp-proxy/opencode-go/muse-spark-1.3-contributor` and the header
  `Authorization: Bearer sk-bf-...`.
- Request logs are kept for 7 days.

Edits made in the Bifrost UI stay after a restart. If you edit
`config.json`, the changed sections replace the UI values at the next
start.

## Version pin

The three `@oh-my-pi/*` deps are pinned to one exact omp version. The binary
on prod must be built for the `omp` version on prod and on the fleet: the
broker protocol and the native library both change between releases.

Deploy updates `omp` everywhere. When the fleet is on a newer release than
this pin, the `prod` job runs `bump.sh` on a scratch copy and deploys the
result, so a release without an API break needs no manual step; it logs a
warning that the pin is behind, and you record the new pin with
`./bump.sh <version>` and a commit. When the scratch build fails (an API
break), the job fails before touching prod, and prod keeps running the
previous omp and proxy together. Fix the code, run `./bump.sh <version>`,
commit, and deploy.
