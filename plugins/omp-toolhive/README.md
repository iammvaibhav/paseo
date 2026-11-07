# omp-toolhive

Registers ToolHive's three meta tools as always-loaded omp tools:

| omp tool | ToolHive tool |
|---|---|
| `toolhive_find_tool` | `find_tool` |
| `toolhive_call_tool` | `call_tool` |
| `toolhive_execute_tool_script` | `execute_tool_script` |

omp presents MCP tools as discoverable, so with `tools.xdev` on they sit under `xd://` and agents rarely use them. Extension tools can be `essential`, so this plugin speaks streamable-HTTP MCP to ToolHive itself. Do not also list ToolHive in `mcp.json`.

Config, `~/.omp/agent/toolhive.json` (mode 600):

```json
{ "url": "https://toolhive.thevm.space/mcp", "token": "<bearer>" }
```

`TOOLHIVE_URL` and `TOOLHIVE_TOKEN` override the file. Without either, the plugin registers nothing.
