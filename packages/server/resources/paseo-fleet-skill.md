# Paseo fleet

Paseo runs coding agents on several machines ("hosts"). Every host runs a Paseo daemon; the daemons are peered, so this MCP server sees and controls the whole fleet. You act with the same authority as the Commander: create, steer, stop, move, rename and archive agents on any host, and manage tickets.

## Use MCP for anything that spans hosts

Start with these tools. They are loaded on every connection:

| Need                                       | Tool                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| Which hosts, projects and workspaces exist | `fleet_list_inventory`                               |
| Which agents exist, by state               | `fleet_list_agents`                                  |
| How one agent is doing                     | `fleet_agent_status`                                 |
| What an agent did                          | `fleet_get_agent_activity`                           |
| Who worked on something                    | `fleet_search`                                       |
| Which models to use                        | `fleet_list_models` (only the models the owner uses) |
| Where a new task should run                | `suggest_placement`                                  |
| Start an agent                             | `fleet_create_agent`                                 |
| Talk to a running agent                    | `fleet_send_prompt`                                  |
| Wait for an agent's run to end             | `fleet_wait_agent`                                   |
| Tickets                                    | `ticket_list`, `ticket_create`                       |

Everything else is one search away. Call `paseo_tool_search` with what you want in plain words ("move an agent to another host", "archive a workspace", "cancel an agent", "comment on a ticket"); it returns the matching tools with their input schemas. Run any of them with `paseo_tool_call { name, arguments }`.

## Knowing when an agent is done

- **Long or background work:** pass `notifyOnFinish: true` (and optionally `notifyContext`, any string up to 2000 characters) to `fleet_create_agent` or `fleet_send_prompt`. The call returns at once. When the run ends, Paseo POSTs to your webhook:
  `{"type":"paseo.agent.finished","reason":"finished|errored|closed","client","context","agent":{"id","host","title","status","bucket","finishedAt","lastMessage","error"},"trigger":{"tool","requestedAt"}}`.
  If the agent blocks on a permission first, you also get one `paseo.agent.needs_permission` event. `context` is echoed back verbatim, so use it to match the event to your request.
- **Short work you want answered now:** call `fleet_wait_agent { agentId, timeoutSeconds }` (default 600, max 1800). It returns when the run ends, early on a permission request, or with `timedOut: true`; call it again to keep waiting. Wait on several agents by calling it once per agent in parallel.

Rules that keep you out of trouble:

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
