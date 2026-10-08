# History Ask

Fast full-text History search is the front door: one box on the History screen
ranks session names and indexed transcripts together (including archived
sessions). History Ask is the fallback when that index finds nothing, or when
you want a summarization agent instead of a ranked list.

This is a custom-fork feature (`vaibhav/customizations`).

## What it is

| Piece               | Behavior                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **History search**  | History → Agents tab searches titles **and** transcripts via an FTS5 index                      |
| **Empty-state Ask** | Zero FTS hits keep "No sessions match" / Clear search, plus **Ask about this** (prefills Ask)   |
| **Agentic Ask**     | History → Ask tab (or project/workspace ⋮ → **Ask history…**) launches an agent                 |
| **Scope**           | Workspace (one cwd), project (all non-archived workspaces on a host), or host-wide              |
| **Jobs**            | Labeled with `paseo.history-ask=1`; listed under History → Ask; open like normal history agents |

Do **not** set `internal: true` on History Ask agents — that can hide them from history. Labels only.

## Entry points

1. **Project ⋮** → Ask history… → project scope on that host
2. **Workspace ⋮** → Ask history… → workspace scope
3. **History** screen → **Ask** tab → default host-wide scope (or pending scope from ⋮)

Navigation uses `buildSessionsRoute()` and the History Ask zustand store (`pendingScope`, `activeTab`).

## Launch contract

`launchHistoryAsk` (app-only, no new daemon RPC):

1. Resolve provider/model from `createAgentPreferencesService` (project → global).
2. Force **unattended** mode:
   - Claude `bypassPermissions`
   - Codex `full-access`
   - Copilot `allow-all`
   - ACP (Cursor / Grok / …) `paseo-allow-all` or first mode with `isUnattended: true`
3. Build a markdown brief with scope, Paseo catalog paths, native transcript roots, search instructions, and the user question.
4. `client.createAgent({ config, workspaceId?, initialPrompt: brief, labels })`.
5. Title: `Ask: ` + truncated question (~50 chars).

Primary `cwd` is the first scope cwd (or first active workspace on the host for host-wide).

## Labels

| Key                              | Value                              |
| -------------------------------- | ---------------------------------- |
| `paseo.history-ask`              | `"1"`                              |
| `paseo.history-ask.scope`        | `workspace` \| `project` \| `host` |
| `paseo.history-ask.project-id`   | optional                           |
| `paseo.history-ask.workspace-id` | optional                           |

## Path encoding (brief roots)

Mirrors daemon/native layout so the agent can find files:

- Paseo catalog: `~/.paseo/agents/{sanitizePaseoAgentDir(cwd)}/`
- Claude: `~/.claude/projects/{encodeClaudeProjectDir(cwd)}/`
- Grok: `~/.grok/sessions/{encodeURIComponent(cwd)}/`
- Codex: `~/.codex/sessions/` (+ Paseo persistence handles)

## Code map

```
packages/app/src/history-ask/
  labels.ts
  paths.ts
  scope.ts
  brief.ts
  unattended-mode.ts
  launch.ts
  fuzzy.ts
  history-ask-store.ts
  index.ts
```

UI: `sessions-screen.tsx`, `sidebar-workspace-menu.tsx`, `sidebar-workspace-list.tsx`, `sidebar-status-list.tsx`.

## Tests

```bash
npx vitest run packages/app/src/history-ask --bail=1
```
