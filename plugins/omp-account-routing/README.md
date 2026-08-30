# omp-account-routing

Per-host / per-project OAuth account routing for [Oh My Pi](https://omp.sh).

omp rotates multiple OAuth accounts per provider by usage headroom with
per-session stickiness. This extension adds the missing control: which account
a project uses, and how accounts fall back.

Enforcement is the native session pin (`AuthStorage.pinSessionOAuthAccount`),
keyed on the session id that request-time key resolution uses. OAuth refresh,
broker proxying, usage attribution, and the `/session` account picker all keep
working. **No `routing:` config → the extension is a no-op.**

## Install

```bash
omp install ./omp-account-routing   # symlinks into the plugin set, watches for changes
omp plugin list                      # verify it shows up enabled
```

## Config

Two layers, merged per provider (project wins):

| Layer | File |
|---|---|
| Host (all projects) | `~/.omp/agent/account-routing.yml` |
| Project (committed) | `.omp/account-routing.yml` in the repo |

Aliases live in the host config so project configs are portable across hosts.

### Host — `~/.omp/agent/account-routing.yml`

```yaml
accounts:
  ambient:  "account:google-oauth2|user_01K23XXGE6YS2PQF8R5PCFKHBX"
  personal: "account:google-oauth2|user_01JFWEBSP5K22DTWCSKAQ3X5RF"

routing:
  cursor:
    strategy: primary-fallback   # route ambient first, fall back to personal on rate limit
    order: [ambient, personal]
```

### Project — `.omp/account-routing.yml`

```yaml
routing:
  cursor:
    strategy: round-robin        # alternate accounts across sessions
    enabled: [ambient, personal]
```

To force a single account in a project, set `enabled` to just that alias:

```yaml
routing:
  cursor:
    enabled: [personal]          # only the personal account, ever
```

## Options

| Key | Values | Default |
|---|---|---|
| `strategy` | `primary-fallback` · `weekly-expiry-first` · `weekly-deadline-first` · `round-robin` · `off` | `primary-fallback` |
| `order` | list of aliases or identity keys, preference order | all stored accounts |
| `enabled` | subset of `order` actually usable | all of `order` |
| `rotate` | `session` · `prompt` (round-robin granularity) | `session` |

`strategy: off` disables routing for that provider explicitly; an empty
`enabled: []` means no account is usable.

## Behavior

- **primary-fallback** — every new prompt starts on the first eligible
  account. If a turn hits a rate-limit/auth error (`auto_retry_start`) or a
  credential gets auto-disabled (`credential_disabled`), the retry advances to
  the next eligible account; the following prompt returns to the primary.
- **weekly-expiry-first** — for Grok Build, fetch each eligible account's
  weekly billing period and use the account that resets soonest. Billing data
  is cached for five minutes. If any account's billing data is unavailable,
  the configured `order` wins. Rate-limit and auth failures advance through
  the same computed order as `primary-fallback`.
- **weekly-deadline-first** — for Google Antigravity, rank accounts by weekly
  drain rate (`remaining ÷ hours until the weekly reset`), highest first: the
  account whose weekly allowance is closest to expiring is the quota you
  actually stand to lose. The 5-hour window only breaks ties between weeklies
  that are within 5% of each other, because an account under weekly deadline
  pressure still gets several fresh 5-hour buckets before its weekly resets.
  An account whose 5-hour bucket is under 3% is ranked last to avoid a pointless
  429. Buckets are read per model family — `gemini-*` models rank on the Gemini
  group, `claude-*`/`gpt-*` on the Claude-and-GPT group — and cached for one
  minute. If any account's quota data is unavailable, the configured `order`
  wins.

  This exists because omp cannot rank Antigravity on the weekly window itself:
  its usage fetcher reads `fetchAvailableModels`, which exposes only the 5-hour
  counter, so its ranking strategy fills `primary` and leaves `secondary` empty.
  The core comparator checks the weekly window first and finds nothing to
  compare. This strategy reads `retrieveUserQuotaSummary` instead, which returns
  both buckets.

- **round-robin** — the routed account rotates per session (or per prompt with
  `rotate: prompt`). The cursor is persisted per working directory in
  `~/.omp/agent/account-routing-state.json`, so balance survives restarts.

Routing is applied at `session_start`, `session_switch`, and
`before_agent_start` (handlers are awaited, so the pin lands before the first
request of a turn resolves its API key). Disabled accounts drop out of the
stored account list, so an advance naturally lands on the next eligible one.

## Notes

- **Works in broker mode**: pinning selects among the broker-served accounts;
  refresh still happens through the broker on omp's normal path.
- **The `/session` account picker keeps working.** An earlier version enforced
  with a runtime API-key override (`setRuntimeApiKey`); that made omp report
  auth as `--api-key`, return an empty `listOAuthAccounts`, and refuse manual
  pinning. Pinning avoids all three.
- **Config wins over manual pins.** A pin you set via `/session` is re-applied
  from config on the next prompt. Change the config (or set `strategy: off`) to
  hand control back.
- **`enabled` is a preference, not a hard exclusion.** When the pinned
  account is rate-limited or auto-disabled, omp's native resilience may route
  around it to a sibling the pin didn't forbid. If "never touch account X"
  must hold even when the preferred account fails, pair this extension with
  the broker account pool file (`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE`), which
  removes the sibling from the visible set entirely — then a blocked ambient
  is retried (and fails loudly) instead of switching. Explicit `--api-key`
  overrides beat both mechanisms by design.
- **`omp -p`, `/fresh`, and `/reset` mint a fresh provider session id** that no
  extension API exposes, so those sessions route natively. Interactive sessions
  and `--mode rpc` (how Paseo spawns omp) are routed.
- If a provider has an explicit `--api-key` or `models.yml`
  `providers.<name>.apiKey` override, pinning is refused and logged — that
  override legitimately wins.
- See `omp token <provider> --list` (or the `auth_credentials` table in
  `~/.omp/agent/agent.db`) for your account emails / identity keys.
