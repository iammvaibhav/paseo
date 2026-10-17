# History Ask

Agent search has three depths:

| Depth              | Where                               | What it reads                                                           | Latency |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------- | ------- |
| **Sidebar search** | Search icon in the sidebar header   | Name, title, id, status, launch prompt, last report, transcripts (FTS5) | instant |
| **History search** | History → Agents tab                | Session names and indexed transcripts (FTS5), archived included         | instant |
| **History Ask**    | History → Ask tab, ⋮ → Ask history… | Everything on disk, read by an agent                                    | minutes |

This is a custom-fork feature (`vaibhav/customizations`).

## Sidebar search

The search icon next to the Workspaces / Agents toggle opens a search bar that narrows the list in place, in both views and under any project or host filter already applied. Archived agents are opt-in (**Include archived**) and listed under the bar, since the list never shows them. A search that matches nothing offers **Deep search**, which prefills History Ask with the query.

- **Word matches show instantly**: every query word in the title, name, id, or reported description of an agent already in the session store. Workspace names match too.
- **Each host widens them** after a 250 ms pause: it answers `agent.search.request` (`AgentSearchService`, `packages/server/src/server/agent-search/`) with plain text matching, no model call. An agent matches when every query word is a substring of its name, title, id, reported description, launch prompt (first run record's brief, or the first user message of a live agent), or last report headline, or when the transcript FTS5 index (the one History search uses) hits. Name, title, and id matches rank first, then other fields, then transcript-only hits by bm25.
- Closed agents are candidates. The agent view has no Dormant section, so while a search is active closed agents, and Done agents past the retention window, list under **Done**.
- Archived agents are candidates only with **Include archived**. An agent whose workspace is archived counts as archived too (`workspaceArchivedAt` on the match): it is missing from the active agent list and has no directory to open in. They list under the bar in an **Archived** section drawn with the agent view's section header and row (archive glyph in the status slot), instead of the empty state.
- Opening an archived agent (from the bar, History, or the board) sends `agent.unarchive.request` before resuming it. The host runs `unarchiveAgentOnThisHost`, the same code as `fleet_unarchive_agent`: it restores an archived workspace (and its project) first, then clears the agent's `archivedAt`. When the restore fails the agent stays archived and the workspace route shows the reason.
- A workspace whose project record is gone (a removed project, or a pruned legacy path-keyed project) is still restorable while its folder exists: unarchiving recreates a project at the folder (`mainRepoRoot` for a worktree). It never creates a project at the home directory or any folder enclosing the paseo home, because that project would enclose the Commander's workspace. Such a workspace goes into the host's scratch project instead.
- Commander and machinery agents are never candidates.
- The response still carries `semantic` (always false) and a null `score` from the removed jev ranker so older clients parse it; see `COMPAT(agentSearchJev)`.

## History Ask

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
4. Place the agent in the host's scratch (`experiments`) project, in its base workspace: `routing.project.create` with `scratch: true` returns `baseWorkspaceId` (gated on `features.scratchWorkspace`). The scope lives only in the brief and labels, so Ask agents never pile up inside the projects they search. The `fleet_search` deep tier places its Ask agent the same way, through `RoutingService.ensureScratchWorkspace`.
5. `client.createAgent({ config, workspaceId, initialPrompt: brief, labels })`.
6. Title: `Ask: ` + truncated question (~50 chars).

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

UI: `sessions-screen.tsx`, `sidebar-workspace-menu.tsx`, `sidebar-workspace-list.tsx`, `sidebar-status-list.tsx`. Sidebar search: `components/sidebar/sidebar-search.ts` (matching), `sidebar-search-bar.tsx` (bar, archived list, empty state).

## Tests

```bash
npx vitest run packages/app/src/history-ask --bail=1
npx vitest run packages/server/src/server/agent-search --bail=1
```
