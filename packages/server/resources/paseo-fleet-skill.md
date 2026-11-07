# Paseo fleet

Paseo runs coding agents on several machines ("hosts"). Every host runs a Paseo daemon; the daemons are peered, so this MCP server sees and controls the whole fleet. You act with the same authority as the Commander: create, steer, stop, move, rename and archive agents on any host.

## Use MCP for anything that spans hosts

Tools named `fleet_*` and `memory_*` act on any host. Start with these:

| Need                                       | Tool                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| Which hosts exist, and the names they take | `fleet_list_hosts`                                             |
| Which projects and workspaces exist        | `fleet_list_inventory`                                         |
| Which agents exist, by state               | `fleet_list_agents`                                            |
| How one agent is doing                     | `fleet_agent_status`                                           |
| What an agent did, in brief                | `fleet_get_agent_activity`                                     |
| An agent's full transcript, page by page   | `fleet_get_transcript`                                         |
| Who worked on something, what was decided  | `memory_search` (`byAgent: true`), then `memory_get`           |
| Which models to use                        | `fleet_list_models` (only the models the owner uses)           |
| Where a new task should run                | `fleet_create_agent` with `dryRun: true`                       |
| Start an agent                             | `fleet_create_agent`                                           |
| Talk to a running agent                    | `fleet_send_prompt`                                            |
| Stop, kill, or change an agent's settings  | `fleet_cancel_agent`, `fleet_kill_agent`, `fleet_update_agent` |
| Bring back an archived agent or workspace  | `fleet_unarchive_agent`, `fleet_unarchive_workspace`           |
| Wait for one agent's turn to end           | `fleet_wait_agent`                                             |
| Wait for several agents (any or all)       | `fleet_wait_agents`                                            |
| Webhook when agents finish                 | `fleet_notify_on_finish`                                       |
| Webhook delivery history (missed events)   | `fleet_webhook_deliveries`                                     |
| Give an agent a document, log or image     | `attachments` on `fleet_create_agent` / `fleet_send_prompt`    |
| See an image an agent produced             | `fleet_read_image`                                             |

The rest cover meta changes (`fleet_rename_*`, `fleet_archive_*`, `fleet_move_agent`, `fleet_create_project`, `fleet_promote_workspace`), tickets (`fleet_ticketize_agent`), reminders (`fleet_remind_agent`, `fleet_list_reminders`, `fleet_cancel_reminder`), file uploads (`fleet_upload_file`), and the operating doc (`fleet_playbook`).

Every other tool acts only on the host serving this endpoint, and its description says so: schedules and heartbeats, workspace scripts, terminals, `create_workspace`, provider inspection, pending permissions, browser tabs. Host-local tools that a fleet tool covers (`create_agent`, `list_agents`, `send_agent_prompt`, `list_hosts`, and the like) are not listed here; use the fleet tool.

Tickets live in itsaplan, which the client connects to as its own MCP server.

## Naming a host

`fleet_list_hosts` lists every host: the name fleet results use for it, whether it is the host serving this endpoint (`self`), whether it is online, and every name a `host` argument accepts for it. Each host declares its own names (its alias, the DNS names it serves and their first label, its OS hostname, its serverId), so `prod`, `prod.netbird.cloud` and `local` all name the same host when prod serves the call. `local` always means the host answering the call; when you pass hosts to a different daemon, use one of the other names.

A name that matches no host, or more than one host, is refused, and the error lists every host with its names. Pick one and call again.

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
- Send with `mode: "steer"` (the default when you omit `mode`): it wakes a closed or archived agent and runs the prompt, and on a busy agent it joins the live turn without cancelling it. Use `"interrupt"` only when you mean to cancel the running turn. No send waits for the agent to go idle.
- Arguments a tool does not declare are an error, with the closest real name suggested (`fleet_send_prompt` takes `mode`, not `deliveryMode`).

## Reading a transcript

`fleet_get_transcript { agentId, limit, cursor, direction, turnId?, types? }` pages an agent's full transcript: user and assistant messages, reasoning, and tool calls with their input, output and error inline. It starts at the newest entries; pass `olderCursor` back to read further back, or `newerCursor` with `direction: "newer"` to read only what was added since. Text fields longer than `maxFieldChars` (default 8000) are cut and counted in `truncatedFields`. It never starts a closed agent.

## Images and files

Everything moves through MCP; never copy files to a host yourself.

- **To an agent, always as attachments:** pass files in `attachments` on `fleet_create_agent` or `fleet_send_prompt` (busy or idle agents, any host). Each item is one of:
  - `{ name, mimeType, base64 }`: the file inline, e.g. `{ name: "diagram.png", mimeType: "image/png", base64: "iVBOR…" }`.
  - `{ name, mimeType, text }`: a text file inline, e.g. `{ name: "design.md", mimeType: "text/markdown", text: "# Design…" }`.
  - `{ fileId }`: a file uploaded earlier with `fleet_upload_file { fileName, mimeType, data }` (base64) or `{ fileName, mimeType, text }`.

  Any type works: markdown, logs, PDFs, images. The agent gets each file's path in its prompt and opens it itself; PNG, JPEG, GIF and WebP also reach it as native images. Agents on another host get their own copy.

- **Never put file content in the prompt.** A prompt containing a base64 `data:` URI, or longer than 64 KB, is rejected. Keep the prompt to the instructions and refer to the attached file by name. A markdown file with embedded `data:` images: attach each image as its own file, and attach the markdown with those images replaced by their file names.
- **Large files:** upload in chunks of a few MB: the first call adds `size` (total bytes) and returns `uploadId`; send the rest as `{ uploadId, data }`. The last chunk returns the `fileId`. A request body over 25 MB is rejected with a JSON-RPC error, so inline attachments suit files up to a few MB.
- **From an agent:** `fleet_read_image { agentId, path }` returns the image (up to 10 MB) as MCP image content. Use the absolute path the agent reported.

## Rules that keep you out of trouble

- Ids come from tool results. Never construct an agent, workspace or project id; look it up first (`fleet_list_agents`, `fleet_list_inventory`).
- Call `fleet_list_hosts` before you pass `host`, and pass a name it lists. Omit `host` to let Paseo place the agent from the prompt; `cwd` needs `host`, because a path names a directory on one host.
- Pick a model from `fleet_list_models` for that host and pass it verbatim as `provider`.
- One call per intent. Wait for its result before you repeat it.

## Use the CLI for host-local work

The `paseo` CLI talks to one daemon at a time. Use it for host-local work on a host other than the one serving this endpoint: schedules, heartbeats, terminals, workspace scripts, worktrees, provider diagnostics, daemon status. On the serving host, the host-local MCP tools do the same.

```bash
paseo --host <address>:6767 <command> --json
```

`<address>` is one of the DNS names `fleet_list_hosts` lists for the host (for example a `*.netbird.cloud` name). Common commands:

| Task              | Command                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Schedules         | `paseo --host H schedule ls`, `schedule create --cron "…" "<prompt>"`, `schedule pause <id>` |
| Terminals         | `paseo --host H terminal ls`, `terminal capture <id>`, `terminal send-keys <id> "…"`         |
| Workspace scripts | `paseo --host H script ls --workspace <id>`, `script start <name> --workspace <id>`          |
| Worktrees         | `paseo --host H worktree ls`                                                                 |
| Providers         | `paseo --host H provider ls`, `provider diagnostic <provider>`                               |
| Daemon            | `paseo --host H daemon status`                                                               |

Run `paseo <command> --help` before you guess a flag. Prefer MCP whenever a tool exists: it is faster (one call instead of a CLI start per command) and it resolves which host owns an id for you.
