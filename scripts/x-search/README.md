# x-search

MCP server (Streamable HTTP, stateless) with read-only X (Twitter) and web
search tools. It runs on prod as the systemd user unit `x-search` and is meant
to sit behind Bifrost as an HTTP MCP client.

## How it reads X

X blocks automated access, and xAI exposes X search only as a server-side tool
of its Responses API: a request offers Grok `{"type":"x_search"}`, and Grok
itself calls the internal functions (`x_keyword_search`, `x_semantic_search`,
`x_user_search`, `x_thread_fetch`) on xAI's side, then writes the answer. There
is no endpoint that runs a search without a model, and the raw search results
are not returned (`include` rejects every `x_search` output name), so results
are Grok's relay of the fetched posts plus the cited URLs.

omp's own X reader needs `xai`/`xai-oauth` credentials. This server uses the
Grok Build subscription (`grok-build`) instead, through
`https://cli-chat-proxy.grok.com/v1/responses` with the CLI fingerprint headers
from `plugins/omp-grok-build/src/constants.ts` (compiled in, so the CLI
version stays in step with the plugin).

- Token: `omp token grok-build`, cached until two minutes before the JWT
  expires and refetched once on a 401. On prod this reads the auth broker's
  own store, which `omp-grok-refresher` keeps fresh, so there is no separate
  login.
- Cost: every call is a Grok turn (model tokens, including fetched posts, plus
  per-item search fees) drawn from the Grok Build weekly credit pool. The
  account has no on-demand cap, so nothing is billed; an exhausted pool makes
  calls fail until the weekly reset. Check the pool with
  `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`.
- Model `grok-4.7`, reasoning effort `low`. `depth` caps model turns at 2
  (`quick`) or 5 (`thorough`); one turn can run several searches in parallel.
  Override with `X_SEARCH_MODEL` / `X_SEARCH_EFFORT`.

## Tools

| Tool           | Input                                                                            | Typical time |
| -------------- | -------------------------------------------------------------------------------- | ------------ |
| `x_search`     | `request`, `handles`, `exclude_handles`, `since`, `until`, `limit`, `depth`      | 4-18 s       |
| `x_web_search` | `query`, `domains`, `exclude_domains`, `depth` (Grok's server-side `web_search`) | 10-35 s      |

`x_search` covers everything on X in one tool: post search, one post or thread
by URL, an account's posts, account lookup, and questions answered from posts.
The request may use X search syntax.

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
