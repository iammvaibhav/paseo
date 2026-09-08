export type GitMetadataScope = "worktree" | "common";

/** Config keys treated as repo-wide even though only one branch's config line changed. */
export const GIT_METADATA_CONFIG_GLOBAL_PREFIXES = ["remote.", "core.", "extensions."] as const;

type GitMetadataEventRule = {
  id: string;
  scope: GitMetadataScope | "both";
  path: string;
  prune?: true;
} & (
  | { match: "exact" | "prefix" | "suffix"; route: "ignore" }
  | { match: "exact" | "prefix" | "suffix"; route: "owner"; refreshBase: boolean }
  | { match: "prefix"; route: "local-ref" | "remote-ref" }
  | { match: "exact"; route: "config" }
  | { match: "exact" | "prefix"; route: "packed-refs" }
);

export type GitMetadataEffect =
  | { kind: "ignore" }
  | { kind: "owner"; refreshBase: boolean }
  | { kind: "ref"; namespace: "local" | "remote"; ref: string }
  | { kind: "config" }
  | { kind: "packed-refs" };

export const GIT_METADATA_EVENT_RULES = [
  { id: "lock", scope: "both", match: "suffix", path: ".lock", route: "ignore" },
  {
    id: "worktree-index",
    scope: "worktree",
    match: "exact",
    path: "index",
    route: "owner",
    refreshBase: false,
  },
  {
    id: "worktree-head",
    scope: "worktree",
    match: "exact",
    path: "HEAD",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "worktree-config",
    scope: "worktree",
    match: "exact",
    path: "config.worktree",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "paseo-worktree-metadata",
    scope: "worktree",
    match: "exact",
    path: "paseo/worktree.json",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "main-index",
    scope: "common",
    match: "exact",
    path: "index",
    route: "owner",
    refreshBase: false,
  },
  {
    id: "main-head",
    scope: "common",
    match: "exact",
    path: "HEAD",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "local-branch",
    scope: "common",
    match: "prefix",
    path: "refs/heads/",
    route: "local-ref",
  },
  {
    id: "remote-branch",
    scope: "common",
    match: "prefix",
    path: "refs/remotes/",
    route: "remote-ref",
  },
  {
    id: "packed-refs",
    scope: "common",
    match: "exact",
    path: "packed-refs",
    route: "packed-refs",
  },
  {
    id: "reftable",
    scope: "common",
    match: "prefix",
    path: "reftable/",
    route: "packed-refs",
  },
  {
    id: "shared-config",
    scope: "common",
    match: "exact",
    path: "config",
    route: "config",
  },
  {
    id: "worktree-administration",
    scope: "common",
    match: "prefix",
    path: "worktrees/",
    route: "ignore",
  },
  {
    id: "hooks",
    scope: "common",
    match: "prefix",
    path: "hooks/",
    route: "ignore",
    prune: true,
  },
  {
    id: "ref-logs",
    scope: "common",
    match: "prefix",
    path: "logs/",
    route: "ignore",
    prune: true,
  },
  {
    id: "object-database",
    scope: "common",
    match: "prefix",
    path: "objects/",
    route: "ignore",
    prune: true,
  },
] as const satisfies readonly GitMetadataEventRule[];

export function getPrunedGitMetadataPaths(scope: GitMetadataScope): string[] {
  return GIT_METADATA_EVENT_RULES.flatMap((rule) => {
    if (rule.scope !== "both" && rule.scope !== scope) return [];
    if (!("prune" in rule) || !rule.prune || rule.match !== "prefix") return [];
    return [rule.path.slice(0, -1)];
  });
}

export function classifyGitMetadataPath(
  scope: GitMetadataScope,
  inputPath: string,
): GitMetadataEffect {
  const path = inputPath.replaceAll("\\", "/");
  const rule = GIT_METADATA_EVENT_RULES.find(
    (candidate) =>
      (candidate.scope === "both" || candidate.scope === scope) &&
      matchesGitMetadataPath(candidate.match, candidate.path, path),
  );
  if (!rule || rule.route === "ignore") return { kind: "ignore" };
  if (rule.route === "owner") {
    return { kind: "owner", refreshBase: rule.refreshBase };
  }
  if (rule.route === "config") return { kind: "config" };
  if (rule.route === "packed-refs") return { kind: "packed-refs" };
  return {
    kind: "ref",
    namespace: rule.route === "local-ref" ? "local" : "remote",
    ref: path.slice(rule.path.length),
  };
}

function matchesGitMetadataPath(
  match: GitMetadataEventRule["match"],
  pattern: string,
  path: string,
): boolean {
  if (match === "exact") return path === pattern;
  if (match === "suffix") return path.endsWith(pattern);
  return path === pattern.slice(0, -1) || path.startsWith(pattern);
}
