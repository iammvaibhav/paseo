# Webhooks

Webhooks let an external HTTP request start an agent. You register a webhook on a
host's daemon; when its URL is hit, the daemon fires an agent (existing agent or a
freshly-provisioned workspace/worktree) with a prompt rendered from the request
payload. Think of it as **Schedules, triggered by an HTTP request instead of a clock.**

This is a custom-fork feature (`vaibhav/customizations`), not part of upstream Paseo.

## Mental model

- A webhook lives on **one host's daemon** and fires agents **on that host only**. There
  is no cross-host dispatch — the daemon can only start agents on itself (`HostProfile`
  is a client concept). "Host" in the create form means "which daemon owns and runs this
  hook," exactly like Schedules. To run on `blrofc3`, register the hook on `blrofc3`.
- The feature reuses the Schedules machinery wholesale: the `new-agent | agent` target
  union, the `createAgent({ kind: "mcp" })` fire path, per-host aggregation in the app,
  and the tab/screen/form layout.

## Request routing

An external request reaches the daemon through a **tunnel** (the daemon is loopback-only
by default and the relay only carries the encrypted WS protocol, not raw HTTP ingress):

```
GitHub/Linear ──HTTPS──▶ <public hostname> (tunnel ingress)
      │  forwards to the machine
      ▼
  tunnel daemon (tailscaled / cloudflared) ──▶ http://<daemon listen addr>/hooks/<id>/<secret>
      │  Express route: verify token → verify HMAC → filter → ack 202
      ▼
  createAgent({ kind: "mcp", ... })  ← agent runs on THIS host
```

TLS terminates on the machine (Tailscale Funnel) or at the vendor edge (Cloudflare), so
the daemon can stay bound to `127.0.0.1` — the tunnel proxies from localhost.

## Tunnel providers (configurable)

Configured under `daemon.tunnel` in `~/.paseo/config.json`, or via env
(`PASEO_TUNNEL_PROVIDER`, `PASEO_TUNNEL_PUBLIC_BASE_URL`) which take precedence:

```jsonc
"daemon": {
  "tunnel": {
    "provider": "tailscale-funnel", // "tailscale-funnel" | "cloudflared" | "none"
    "localPort": 6767,
    // localTarget defaults to the daemon's listen address (host:port). The tunnel
    // forwards there — this matters when the daemon binds to a non-loopback address
    // (e.g. its Tailscale IP), not 127.0.0.1.
    "autoStart": false, // if true, the daemon runs the tunnel process itself
    // cloudflared: { "hostname": "hooks.example.com", "token": "...", "tunnel": "<name>" }
  }
}
```

The deploy script drives this per host **by env** (`PASEO_TUNNEL_PROVIDER` on the
daemon-restart command) rather than editing `config.json`, so an older daemon's strict
config schema is never at risk. `scripts/deploy.sh` sets `tailscale-funnel` for `blrofc3`
and ensures the funnel process is up on every deploy (see below).

| Provider           | Public URL                           | Stable? | Domain needed | Notes                                                    |
| ------------------ | ------------------------------------ | ------- | ------------- | -------------------------------------------------------- |
| `tailscale-funnel` | `https://<machine>.<tailnet>.ts.net` | yes     | no            | Free, zero-config. Ports 443/8443/10000. Default.        |
| `cloudflared`      | `https://<your hostname>`            | yes     | yes (own it)  | Named tunnel; needs a Cloudflare account + domain.       |
| `none`             | (bring-your-own)                     | —       | —             | You expose the daemon yourself; Paseo just serves hooks. |

- **`tailscale-funnel`** — default for work/Tailscale machines (e.g. `blrofc3`). The
  funnel forwards public HTTPS (443) to the daemon's listen address. Requires the tailnet's
  ACL to grant the node the `funnel` node-attribute (verify with `tailscale status --json`
  → `Self.CapMap` contains `funnel`) and — since the daemon runs as a non-root user — the
  Tailscale operator set once: `sudo tailscale set --operator=$USER`. `scripts/deploy.sh`
  does the operator grant and starts the funnel automatically (idempotent). Publishes to the
  **public internet** under the tailnet domain — confirm that is acceptable on a corporate
  tailnet; admins can revoke. Enable manually with:
  `tailscale funnel --bg http://<daemon-listen-addr>` (e.g. `http://100.105.100.71:6767`).
- **`cloudflared`** — for personal machines with a domain. Cloudflare's free tier is fine;
  the domain is the only cost. Quick tunnels (`*.trycloudflare.com`) are intentionally not
  used for registered hooks because their URL changes on every restart.
- **`none`** — user handles exposure (direct port, own reverse proxy). Paseo still serves
  `/hooks/*`; it just can't render a full public URL in the UI.

Each provider is a small adapter behind a common interface: `start() -> publicBaseUrl`,
`stop()`, reconciled on bootstrap like other managed processes. The webhook feature is
provider-agnostic — it only needs "what is my public base URL" to render the copy-paste
hook link.

## Auth

Two layers, both per-webhook:

1. **URL secret token** (baseline, always on). The hook URL is `/hooks/<id>/<secret>` where
   `secret` is high-entropy and unguessable. Works with any sender that lets you set a URL.
   Compared constant-time.
2. **HMAC signature verification** (optional, recommended for internet-exposed hooks). The
   sender signs the raw body with a shared secret; the daemon recomputes and compares
   constant-time. Presets:
   - **GitHub** — `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body.
   - **Linear** — `Linear-Signature: <hex>`, HMAC-SHA256 over the raw body; also check the
     `webhookTimestamp` field to reject replays.
   - **custom** — configurable header + algorithm.

HMAC proves authenticity (sender knows the secret) and integrity (body untampered) without
the secret ever crossing the wire, so it is stronger than a URL token alone. For a generic
sender that supports neither, the URL token is the only guard — keep the tunnel URL private.

**Footgun:** HMAC must be computed over the **raw request body bytes**, before JSON parsing.
The `/hooks/*` route captures the raw body and is mounted _before_ `express.json()` and the
bearer-auth middleware, and is exempt from the Host allowlist (the incoming Host is the
public tunnel hostname, which the DNS-rebinding allowlist would otherwise reject — same
exemption pattern as `/api/health`).

## Prompt templating

The prompt is a template rendered against the request. Available bindings:

- `{{payload.<path>}}` — dot-path into the parsed JSON body (e.g.
  `{{payload.pull_request.title}}`). Missing paths render empty.
- `{{headers.<name>}}` — request header (lowercased).
- `{{query.<name>}}` — query-string parameter.
- `{{raw}}` — the full raw body (capped).

Payload size is capped (reject oversized bodies with `413`). Rendering is pure string
interpolation — no code execution.

## Filtering

An optional `filter` avoids one-hook-per-event. Simple equality rules on payload paths,
e.g. only fire when `payload.action == "opened"`. A request that fails the filter is
recorded as a skipped delivery and returns `202` (webhook senders should still get a 2xx).

## Reliability semantics

- **Ack fast.** The route validates + records the delivery and returns `202` immediately.
  The agent is created with `background: true`; the HTTP response never waits on the run.
- **Idempotency.** If the sender provides a delivery id (`X-GitHub-Delivery`, Linear's
  event id), duplicate deliveries within a window are de-duped so retries don't spawn
  multiple agents.
- **Rate/debounce guard.** A per-hook guard caps how fast a hook can spawn agents, so a
  chatty source can't fork-bomb the daemon.
- **Delivery log.** Each hook keeps a bounded history of recent deliveries (timestamp,
  source, matched/skipped, status, resulting `agentId`, payload snippet) — surfaced in the
  UI with a **replay** action for debugging.

## Data model

One JSON file per webhook at `$PASEO_HOME/webhooks/{id}.json` (atomic writes), mirroring the
schedule store. Shape (`WebhookTrigger`):

| Field                     | Type                                            | Notes                                            |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `id`                      | `string`                                        | 8-hex id; also the URL path segment              |
| `name`                    | `string \| null`                                | Human label                                      |
| `enabled`                 | `boolean`                                       | Disabled hooks return `404`/`410`                |
| `secret`                  | `string`                                        | URL token (high-entropy)                         |
| `auth`                    | `{ hmac?: { preset, secret, header?, algo? } }` | Optional HMAC config                             |
| `target`                  | `WebhookTarget`                                 | `agent` \| `new-agent` (same shape as schedules) |
| `promptTemplate`          | `string`                                        | Rendered against the request                     |
| `filter`                  | `WebhookFilter?`                                | Optional match rules                             |
| `createdAt` / `updatedAt` | `string` (ISO 8601)                             |                                                  |
| `deliveries`              | `WebhookDelivery[]`                             | Bounded history (mirrors `ScheduleRun[]`)        |

## Protocol / RPC

New RPCs use the existing schedule-style names for consistency with the sibling feature:
`webhook/create`, `webhook/list`, `webhook/inspect`, `webhook/delete`, `webhook/update`,
`webhook/test` — each with a `.../response`. Schemas in
`packages/protocol/src/webhook/{types.ts,rpc-schemas.ts}`, registered in `messages.ts`
inbound/outbound unions. Protocol stays additive and backward-compatible (new message
types only; no changes to existing ones).

The UI is **not** capability-gated (personal-fork decision) — the tab always shows; an old
daemon simply won't answer the new RPCs.

## Where things live

| Concern                 | Location                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Webhook records         | `$PASEO_HOME/webhooks/{id}.json`                                                       |
| Tunnel + hook config    | `daemon.tunnel` in `~/.paseo/config.json`                                              |
| HTTP ingress route      | `packages/server/src/server/bootstrap.ts` (`POST /hooks/:id/:secret`)                  |
| Store / service         | `packages/server/src/server/webhook/`                                                  |
| Tunnel adapters         | `packages/server/src/server/tunnel/`                                                   |
| Protocol schemas        | `packages/protocol/src/webhook/`                                                       |
| Client methods          | `packages/client/src/daemon-client.ts`                                                 |
| App tab / screen / form | `packages/app/src/{app/webhooks.tsx,screens/webhooks-screen.tsx,components/webhooks/}` |

## Gotchas

- **Raw body before JSON.** HMAC verification needs unparsed bytes; mount `/hooks/*` before
  `express.json()`.
- **Host allowlist.** The public tunnel hostname is not in the default DNS-rebinding
  allowlist; `/hooks/*` must be exempt (or the hostname added to `hostnames`).
- **Corporate tailnet.** Funnel publishes to the open internet under the org tailnet;
  confirm policy before enabling on a work machine.
- **Never block the response** on the agent run — always `202` then `background: true`.
- **Cap payload size** and **de-dupe delivery ids** to prevent agent storms.
- **Agents run on the receiving daemon only** — pick the host deliberately.
