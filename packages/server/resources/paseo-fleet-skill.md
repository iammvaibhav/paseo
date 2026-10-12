# Paseo fleet

Paseo runs coding agents on several machines ("hosts"). Every host runs a Paseo daemon; the daemons are peered, so this MCP server sees and controls the whole fleet. You act with the same authority as the Commander: create, steer, stop, move, rename and archive agents on any host.

## Use MCP for anything that spans hosts

Start with these tools. They are loaded on every connection:

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
| Wait for one agent's turn to end           | `fleet_wait_agent`                                   |
| Wait for several agents (any or all)       | `fleet_wait_agents`                                  |
| Webhook when agents finish                 | `fleet_notify_on_finish`                             |

Everything else is one search away. Call `paseo_tool_search` with what you want in plain words ("move an agent to another host", "archive a workspace", "cancel an agent"); it returns the matching tools with their input schemas. Run any of them with `paseo_tool_call { name, arguments }`.

Tickets live in itsaplan, which the client connects to as its own MCP server.

## Knowing when an agent is done

Every wait and notification is bound to a **turn**. `fleet_create_agent` and `fleet_send_prompt` return the `turnId` their prompt runs in (a steer into a busy agent joins its current turn). Pass that `turnId` on, and you never get an earlier run's finish.

- **Long or background work:** pass `notifyOnFinish: true` (and optionally `notifyContext`, any string up to 2000 characters) to `fleet_create_agent` or `fleet_send_prompt`. The call returns at once. When that turn ends, Paseo POSTs to your webhook:
  `{"type":"paseo.agent.finished","reason":"finished|errored|closed","client","context","agent":{"id","host","turnId","title","status","bucket","finishedAt","lastMessage","error"},"trigger":{"tool","requestedAt"}}`.
  If the agent blocks on a permission first, you also get one `paseo.agent.needs_permission` event. `context` is echoed back verbatim, so use it to match the event to your request.
- **Several agents in the background:** `fleet_notify_on_finish { agents: [{agentId, turnId?}], perAgent?, group?, notifyContext? }`. `perAgent` (default true) sends one `paseo.agent.finished` per agent; `group: true` also sends one `{"type":"paseo.agents.group_finished","groupId","context","agents":[…]}` once every agent's turn has ended.
- **Short work you want answered now:** `fleet_wait_agent { agentId, turnId, timeoutSeconds }` (default 600, max 1800). It returns when the turn ends, early on a permission request, or with `timedOut: true`; call it again with the same `turnId` to keep waiting. A turn that already ended returns its outcome at once; a turn that has not started returns `status: "pending"`. Without `turnId` it binds to the run in progress, or returns an idle agent's last state at once.
- **Several agents now:** `fleet_wait_agents { agents: [{agentId, turnId?}], mode: "any" | "all", timeoutSeconds }`. `any` returns on the first agent that finishes or needs a permission; `all` returns when every agent has. Each result carries its `turnId` and status.
- Nothing you call is ever gated: spawns, sends, renames, moves, archives, cancel and kill all run directly and return their real result. No call creates an approval card.
- Arguments a tool does not declare are an error, with the closest real name suggested (`fleet_send_prompt` takes `mode`, not `deliveryMode`).

## Reading a transcript

`fleet_get_transcript { agentId, limit, cursor, direction, turnId?, types? }` pages an agent's full transcript: user and assistant messages, reasoning, and tool calls with their input, output and error inline. It starts at the newest entries; pass `olderCursor` back to read further back, or `newerCursor` with `direction: "newer"` to read only what was added since. Text fields longer than `maxFieldChars` (default 8000) are cut and counted in `truncatedFields`. It never starts a closed agent.

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
