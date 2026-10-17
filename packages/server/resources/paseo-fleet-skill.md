# Paseo fleet

Paseo runs coding agents on several machines ("hosts"). Every host runs a Paseo daemon; the daemons are peered, so this MCP server sees and controls the whole fleet. You act with the same authority as the Commander: create, steer, stop, move, rename and archive agents on any host.

## Use MCP for anything that spans hosts

Every Paseo tool is listed directly on this server. Start with these:

| Need                                       | Tool                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| Which hosts, projects and workspaces exist | `fleet_list_inventory`                               |
| Which agents exist, by state               | `fleet_list_agents`                                  |
| How one agent is doing                     | `fleet_agent_status`                                 |
| What an agent did, in brief                | `fleet_get_agent_activity`                           |
| An agent's full transcript, page by page   | `fleet_get_transcript`                               |
| Who worked on something                    | `fleet_search`                                       |
| Which models to use                        | `fleet_list_models` (only the models the owner uses) |
| Where a new task should run                | `suggest_placement`                                  |
| Start an agent                             | `fleet_create_agent`                                 |
| Talk to a running agent                    | `fleet_send_prompt`                                  |
| Bring back an archived agent or workspace  | `fleet_unarchive_agent`, `fleet_unarchive_workspace` |
| Wait for one agent's turn to end           | `fleet_wait_agent`                                   |
| Wait for several agents (any or all)       | `fleet_wait_agents`                                  |
| Webhook when agents finish                 | `fleet_notify_on_finish`                             |
| Webhook delivery history (missed events)   | `fleet_webhook_deliveries`                           |
| Give an agent a screenshot or file         | `fleet_upload_file`, then pass the `fileId`          |
| See an image an agent produced             | `fleet_read_image`                                   |

The rest cover meta changes (`fleet_rename_*`, `fleet_archive_*`, `fleet_move_agent`, `fleet_create_project`, `fleet_adopt_agent`), control (`fleet_cancel_agent`, `fleet_kill_agent`, `fleet_update_agent`, `respond_to_permission`), schedules and heartbeats, workspace scripts, terminals, browser tabs, memory (`fleet_recall`, `fleet_context`) and Mission Control cards. Tools without the `fleet_` prefix act on this daemon's host only.

Tickets live in itsaplan, which the client connects to as its own MCP server.

## Knowing when an agent is done

Every wait and notification is bound to a **turn**. `fleet_create_agent` and `fleet_send_prompt` return the `turnId` their prompt runs in (a steer into a busy agent joins its current turn). Pass that `turnId` on, and you never get an earlier run's finish.

- **Long or background work:** pass `notifyOnFinish: true` (and optionally `notifyContext`, any string up to 2000 characters) to `fleet_create_agent` or `fleet_send_prompt`. The call returns at once. When that turn ends, Paseo POSTs to your webhook:
  `{"type":"paseo.agent.finished","deliveryId","reason":"finished|errored|closed|interrupted","final":true,"client","context","agent":{"id","host","turnId","title","status","bucket","finishedAt","lastMessage","error"},"trigger":{"tool","requestedAt"}}`.
  If the agent blocks on a permission first, you also get one `paseo.agent.needs_permission` event (`final: false`). `context` is echoed back verbatim, so use it to match the event to your request.
- **Retries and duplicates:** a POST that fails with a network error, 408, 425, 429, 5xx, or a 4xx that says you are rate limiting is retried with backoff, 6 attempts over about 15 minutes. Every event (finished, group, status report) carries a `deliveryId`, also sent as the `X-Paseo-Delivery-Id` header, and every retry or resend after a Paseo restart repeats it: drop an event whose `deliveryId` you already handled. `fleet_webhook_deliveries` shows each attempt; a row with `outcome: "failed"` is an event Paseo gave up on.
- **Host restarts mid-run:** when the agent's host restarts (a deploy, a crash), you get a `paseo.agent.interrupted` event (`final: false`; `agent.status` is `closed`, or `pending` when the host restarted before its close reached Paseo; `agent.lastMessage` is the last message so far when the host reported one). That is not the result: the watch stays armed, follows the run the host resumes, and sends `paseo.agent.finished` with that run's `turnId` and `lastMessage`. If no run resumes within 10 minutes, it sends `paseo.agent.finished` with `reason: "interrupted"`. Act only on `final: true`.
- **Several agents in the background:** `fleet_notify_on_finish { agents: [{agentId, turnId?}], perAgent?, group?, notifyContext? }`. `perAgent` (default true) sends one `paseo.agent.finished` per agent; `group: true` also sends one `{"type":"paseo.agents.group_finished","groupId","context","agents":[…]}` once every agent's turn has ended.
- Per-agent watches survive a daemon restart: they report the run the restarted daemon resumes, or `reason: "interrupted"` when it never resumes. Group events do not survive a restart; arm `perAgent` too if you cannot lose them.
- **Mid-run status check via webhook:** `fleet_agent_status { agentId, fresh: true, notify: true, notifyContext? }`. Returns immediately with `{ requested: true, requestId }` without blocking for 60s. When the agent next calls `report_status`, Paseo POSTs `{"type":"paseo.agent.status_reported","requestId","agentId","title","host","status","headline","reportedAt","context"}` to your webhook. If no report lands within 5 minutes, or the turn ends first, it POSTs the same event with `status: "no_report"`.
- **Missed an event?** `fleet_webhook_deliveries { failedOnly?, agentId?, since?, limit? }` lists every POST Paseo made to your webhook, newest first: one row per attempt with `event`, `agentId`, `turnId`, `context`, `status` (HTTP), `response` (first 500 chars), `attempt` and `outcome` (`delivered`, `retrying`, `failed`), plus `totals` over all matches. A `failed` row means the event never reached you; read the result with `fleet_get_transcript`.
- **Short work you want answered now:** `fleet_wait_agent { agentId, turnId, timeoutSeconds }` (default 600, max 1800). It returns when the turn ends, early on a permission request, or with `timedOut: true`; call it again with the same `turnId` to keep waiting. A turn that already ended returns its outcome at once; a turn that has not started returns `status: "pending"`. A turn that failed (provider or system error) returns `status: "error"` with the message in `error` and `lastMessage` set to the `[System Error] …` row. Without `turnId` it binds to the run in progress, or returns an idle agent's last state at once.
- **Several agents now:** `fleet_wait_agents { agents: [{agentId, turnId?}], mode: "any" | "all", timeoutSeconds }`. `any` returns on the first agent that finishes or needs a permission; `all` returns when every agent has. Each result carries its `turnId` and status.
- Nothing you call is ever gated: spawns, sends, renames, moves, archives, unarchives, cancel and kill all run directly and return their real result. No call creates an approval card.
- Send with `mode: "steer"` (the default when you omit `mode`): it wakes a closed or archived agent and runs the prompt, and on a busy agent it joins the live turn without cancelling it. Use `"queue"` only to wait until the current turn ends first, and `"interrupt"` only when you mean to cancel the running turn.
- Arguments a tool does not declare are an error, with the closest real name suggested (`fleet_send_prompt` takes `mode`, not `deliveryMode`).

## Reading a transcript

`fleet_get_transcript { agentId, limit, cursor, direction, turnId?, types? }` pages an agent's full transcript: user and assistant messages, reasoning, and tool calls with their input, output and error inline. It starts at the newest entries; pass `olderCursor` back to read further back, or `newerCursor` with `direction: "newer"` to read only what was added since. Text fields longer than `maxFieldChars` (default 8000) are cut and counted in `truncatedFields`. It never starts a closed agent.

## Images and files

Everything moves through MCP; never copy files to a host yourself.

- **To an agent:** `fleet_upload_file { fileName, mimeType, data }` (base64) returns a `fileId`. Pass images as `images: [{ fileId }]` to `fleet_create_agent` or `fleet_send_prompt` (busy or idle agents, any host); pass other files as `attachments: [{ type: "uploaded_file", id: fileId }]` to `fleet_send_prompt`. Agents on another host get their own copy. Small images can also go inline as `images: [{ data, mimeType }]`.
- **Large files:** upload in chunks of a few MB: the first call adds `size` (total bytes) and returns `uploadId`; send the rest as `{ uploadId, data }`. The last chunk returns the `fileId`. A request body over 25 MB is rejected with a JSON-RPC error.
- **From an agent:** `fleet_read_image { agentId, path }` returns the image (up to 10 MB) as MCP image content. Use the absolute path the agent reported, or an image proof path from `fleet_context`.

## Rules that keep you out of trouble

- Ids come from tool results. Never construct an agent, workspace or project id; look it up first (`fleet_list_agents`, `fleet_list_inventory`).
- Pass `host` explicitly when you create work. Use the host names `fleet_list_inventory` returns. Call `suggest_placement` when the user did not say where.
- Pick a model from `fleet_list_models` for that host and pass it verbatim as `provider`.
- One call per intent. Wait for its result before you repeat it.

## Use the CLI for host-local work

The `paseo` CLI talks to one daemon at a time. Use it for things that have no fleet tool: schedules, heartbeats, terminals, workspace scripts, worktrees, provider diagnostics, daemon status.

```bash
paseo --host <address>:6767 <command> --json
```

`<address>` is the host's NetBird address from `fleet_list_inventory`. Common commands:

| Task              | Command                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Schedules         | `paseo --host H schedule ls`, `schedule create --cron "…" "<prompt>"`, `schedule pause <id>` |
| Terminals         | `paseo --host H terminal ls`, `terminal capture <id>`, `terminal send-keys <id> "…"`         |
| Workspace scripts | `paseo --host H script ls --workspace <id>`, `script start <name> --workspace <id>`          |
| Worktrees         | `paseo --host H worktree ls`                                                                 |
| Providers         | `paseo --host H provider ls`, `provider diagnostic <provider>`                               |
| Daemon            | `paseo --host H daemon status`                                                               |

Run `paseo <command> --help` before you guess a flag. Prefer MCP whenever a tool exists: it is faster (one call instead of a CLI start per command) and it resolves which host owns an id for you.
