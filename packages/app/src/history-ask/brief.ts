import type { HistorySearchRoots } from "./paths";
import type { HistoryAskScope } from "./scope";

export function buildHistoryAskBrief(input: {
  scope: HistoryAskScope;
  question: string;
  roots: HistorySearchRoots;
}): string {
  const question = input.question.trim();
  const scope = input.scope;
  const roots = input.roots;

  const scopeLines = [
    `- Kind: \`${scope.kind}\``,
    `- Host (serverId): \`${scope.serverId}\``,
    `- Display name: ${scope.displayName}`,
  ];
  if (scope.projectId) {
    scopeLines.push(`- Project id: \`${scope.projectId}\``);
  }
  if (scope.workspaceId) {
    scopeLines.push(`- Workspace id: \`${scope.workspaceId}\``);
  }
  if (scope.workspaceIds.length > 0) {
    scopeLines.push(`- Workspace ids: ${scope.workspaceIds.map((id) => `\`${id}\``).join(", ")}`);
  }
  if (scope.cwds.length > 0) {
    scopeLines.push(`- Working directories (cwd):`);
    for (const cwd of scope.cwds) {
      scopeLines.push(`  - \`${cwd}\``);
    }
  } else {
    scopeLines.push(
      `- Working directories: **all on this host** (no cwd filter — host-wide search)`,
    );
  }

  const paseoLines =
    roots.paseoAgentDirs.length > 0
      ? roots.paseoAgentDirs.map((path) => `- \`${path}/\` (agent JSON files)`)
      : [
          "- `~/.paseo/agents/{sanitized-cwd}/` — sanitize cwd by stripping the FS root and replacing path separators with `-`",
        ];

  const nativeLines: string[] = [
    "### Claude",
    ...(roots.claudeProjectDirs.length > 0
      ? roots.claudeProjectDirs.map((path) => `- \`${path}/\``)
      : ["- `~/.claude/projects/{encoded-cwd}/` — non-alphanumeric chars → `-`"]),
    "### Grok",
    ...(roots.grokSessionDirs.length > 0
      ? roots.grokSessionDirs.map((path) => `- \`${path}/\``)
      : ["- `~/.grok/sessions/{encodeURIComponent(cwd)}/`"]),
    "### Codex",
    "- Codex sessions live under `~/.codex/sessions/` (date-partitioned rollout JSONL).",
    "- Prefer Paseo catalog `persistence` / runtime handles when available; otherwise search Codex session trees by timestamp and content.",
    "### Other providers",
    "- Use each provider's normal on-disk session layout when present.",
    "- Always cross-check against the Paseo agent catalog first.",
  ];

  const howToSearch = [
    "1. **Shortlist via Paseo catalog**",
    "   - Use tools to list agents with `includeArchived: true`.",
    "   - Filter by this scope:",
  ];

  if (scope.kind === "workspace" && scope.workspaceId) {
    howToSearch.push(
      `     - Prefer \`workspaceId === ${scope.workspaceId}\`, else match cwd \`${scope.cwds[0] ?? ""}\`.`,
    );
  } else if (scope.kind === "project") {
    howToSearch.push(
      "     - Keep agents whose `cwd` is in the project cwd list above, or whose `workspaceId` is in the workspace id list.",
    );
  } else {
    howToSearch.push("     - Host-wide: do not filter by cwd unless the question implies one.");
  }

  howToSearch.push(
    "   - Rank by title/keywords from the user question, recency (`lastActivityAt` / `updatedAt`), and provider.",
    "2. **Read transcripts**",
    "   - Open matching Paseo agent JSON under the catalog paths.",
    "   - Follow `persistence` / native handles into Claude / Codex / Grok / other native transcript files when needed.",
    "   - Skim logs and message text for answers — do not invent sessions that are not on disk.",
    "3. **Answer with citations**",
    "   - For each claim, cite **agent id**, **title**, **cwd**, and a short **snippet**.",
    "   - If nothing matches, say so clearly and suggest a broader scope.",
  );

  return [
    "# History Ask",
    "",
    "You are a **History Ask** agent. Your job is to search past Paseo agent sessions and native provider transcripts on this host to answer the user's question.",
    "",
    "## Operating rules",
    "",
    "- You run in **allow-all / unattended** mode so you can read freely without permission prompts.",
    "- Stay **read-only** with respect to the user's software projects: do **not** edit application code, open PRs, or change git state.",
    "- You may read files under Paseo home, provider session dirs, and the scoped working directories.",
    "- Prefer evidence from disk over speculation. Cite sources.",
    "",
    "## SCOPE",
    "",
    ...scopeLines,
    "",
    "## PASEO CATALOG",
    "",
    "Paseo stores one JSON file per agent:",
    "",
    ...paseoLines,
    "",
    "Each file includes id, title, provider, cwd, workspaceId, labels, timestamps, and often a persistence handle.",
    "",
    "## NATIVE TRANSCRIPT PATHS",
    "",
    ...nativeLines,
    "",
    "## HOW TO SEARCH",
    "",
    ...howToSearch,
    "",
    "## USER QUESTION",
    "",
    question || "(empty question)",
    "",
  ].join("\n");
}
