# x-search

MCP server (Streamable HTTP, stateless) with read-only X (Twitter) tools.
It runs on prod as the systemd user unit `x-search` and is meant to sit behind
Bifrost as an HTTP MCP client.

## How it reads X

X blocks automated access, so every tool asks Grok to read X with its
server-side `x_search` tool, the same mechanism omp's own X reader and xAI
web search use. omp's built-in path needs `xai`/`xai-oauth` credentials; this
server uses the Grok Build subscription (`grok-build`) instead, through
`https://cli-chat-proxy.grok.com/v1/responses` with the CLI fingerprint headers
from `plugins/omp-grok-build/src/constants.ts` (compiled in, so the CLI
version stays in step with the plugin).

- Token: `omp token grok-build`, cached until two minutes before the JWT
  expires and refetched once on a 401. On prod this reads the auth broker's
  own store, which `omp-grok-refresher` keeps fresh, so there is no separate
  login.
- Cost: calls draw on the Grok Build weekly credit pool (the account has no
  on-demand cap, so nothing is billed). Check the pool with
  `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`.
- Model `grok-4.7-build-fast` with reasoning effort `low` and a small
  `max_turns` per tool keeps a call at 3-15 s and one to four X searches.
  Override with `X_SEARCH_MODEL` / `X_SEARCH_EFFORT`.
- Results are Grok's relay of what `x_search` returned, plus the cited URLs.

## Tools

| Tool             | Input                                                                                                      | Returns                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `x_search`       | `query` (X search syntax), `mode` latest/top, `limit`, `from_handles`, `exclude_handles`, `since`, `until` | Matching posts               |
| `x_get_post`     | `post` (URL or ID), `replies`                                                                              | One post, optionally replies |
| `x_user_posts`   | `handle`, `tab` posts/replies/media, `limit`, `since`                                                      | An account's recent posts    |
| `x_search_users` | `query`, `limit`                                                                                           | Account profiles             |
| `x_ask`          | `question`, `include_web`, `since`                                                                         | Cited answer from X (slower) |

## Run

```sh
bun install --frozen-lockfile
X_SEARCH_TOKEN=<32+ chars> X_SEARCH_BIND=127.0.0.1:8792 bun run start
```

- `X_SEARCH_TOKEN` (required): clients send `Authorization: Bearer <token>`.
- `X_SEARCH_BIND`: `host:port`, default `127.0.0.1:8792`.
- `X_SEARCH_OMP_BIN`: the `omp` binary, default `omp` on `PATH`.
- `GET /healthz` needs no token.

## Prod

- URL `http://100.123.97.105:8792/mcp`, bound to the NetBird address only.
- Bearer token in the personal Aside vault, item `x-search MCP bearer (prod)`.
- `~/.config/x-search/env` (mode 600) holds `X_SEARCH_TOKEN` and
  `X_SEARCH_BIND`. Create it once before the first deploy.
- Deploy from the linux-arm64 dev host with `./deploy-prod.sh`. It builds the
  binary, installs `~/.local/bin/x-search` (previous kept as `x-search.prev`)
  and the unit, restarts, and checks `/healthz`. `scripts/deploy.sh` does not
  run it.
- Logs: `journalctl --user -u x-search`, one line per tool call with its X
  search count and duration.
