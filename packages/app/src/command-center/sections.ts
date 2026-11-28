import type { CommandCenterContribution } from "./contributions";
import {
  buildContributionSections,
  compareBuiltInScores,
  LEADING_SECTION_BAND,
  PINNED_SECTION_BAND,
  scoreSearchFields,
  type CommandCenterFileResult,
  type CommandCenterProjectResult,
  type CommandCenterResultSection,
  type CommandCenterScore,
  type CommandCenterWorkspaceResult,
} from "./results";
import type { CommandCenterTab } from "./tabs";
import type { WorkspaceRanker } from "./workspace-search";

/**
 * How many workspaces All leads with before anything is typed. Background workspaces are left
 * out, as the sidebar leaves them out by default.
 */
const RECENT_WORKSPACE_LIMIT = 3;

export interface CommandCenterSectionTitles {
  recentWorkspaces: string;
  projects: string;
  workspaces: string;
  files: string;
}

export interface CommandCenterSectionsInput {
  tab: CommandCenterTab;
  query: string;
  rankWorkspaces: WorkspaceRanker;
  /** Every project, alphabetical. All finds them once something is typed. */
  projects: readonly CommandCenterProjectResult[];
  workspaces: readonly CommandCenterWorkspaceResult[];
  /** Archived workspaces the host found for the query. Empty without a query. */
  archivedWorkspaces: readonly CommandCenterWorkspaceResult[];
  /**
   * The host matched the archived workspaces for this exact query. Its search forgives typos,
   * so its matches stay even when the client cannot score them. Results from the previous
   * query must match on their own.
   */
  archivedMatchedByHost: boolean;
  /**
   * The sidebar's Show background preference. Without a query, Workspaces lists background
   * workspaces only when the sidebar does; a query finds them either way.
   */
  showBackground: boolean;
  /** The open workspace's result ID. Recent workspaces leaves it out: the user is already there. */
  currentWorkspaceId: string | null;
  contributions: readonly CommandCenterContribution[];
  files: readonly CommandCenterFileResult[];
  titles: CommandCenterSectionTitles;
}

function recentWorkspacesSection(input: CommandCenterSectionsInput): CommandCenterResultSection {
  const recent = input
    .rankWorkspaces(input.workspaces, "")
    .filter((workspace) => workspace.id !== input.currentWorkspaceId && !workspace.background)
    .slice(0, RECENT_WORKSPACE_LIMIT);
  return {
    id: "recent-workspaces",
    band: LEADING_SECTION_BAND,
    rank: 0,
    title: input.titles.recentWorkspaces,
    results: recent,
  };
}

/**
 * Projects the query finds, best match first. Selecting one reveals it in the sidebar. Rows
 * arrive alphabetical and the sort is stable, so equal matches stay alphabetical.
 */
function projectsSection(input: CommandCenterSectionsInput): CommandCenterResultSection {
  const scored: { project: CommandCenterProjectResult; score: CommandCenterScore }[] = [];
  for (const project of input.projects) {
    const score = scoreSearchFields(input.query, {
      visible: [project.title, project.subtitle],
      hidden: [],
    });
    if (score) scored.push({ project, score });
  }
  scored.sort((left, right) => compareBuiltInScores(left.score, right.score));
  return {
    id: "projects",
    band: PINNED_SECTION_BAND,
    rank: 1,
    title: input.titles.projects,
    results: scored.map((entry) => entry.project),
  };
}

/** Active matches first; archived ones are appended, so active rows never move when they land. */
function workspacesSection(input: CommandCenterSectionsInput): CommandCenterResultSection {
  const listed =
    input.query.trim() || input.showBackground
      ? input.workspaces
      : input.workspaces.filter((workspace) => !workspace.background);
  const active = input.rankWorkspaces(listed, input.query);
  const archived = input.query.trim()
    ? input.rankWorkspaces(input.archivedWorkspaces, input.query, {
        keepUnmatched: input.archivedMatchedByHost,
      })
    : [];
  return {
    id: "workspaces",
    band: PINNED_SECTION_BAND,
    rank: 2,
    title: input.titles.workspaces,
    results: [...active, ...archived],
  };
}

function filesSection(input: CommandCenterSectionsInput): CommandCenterResultSection {
  // File rows are matched by the daemon, so they carry no client-side score and cannot be
  // relevance-compared against the rows that do. Pinning them keeps the section comparator
  // total: band is decided before any score is read.
  return {
    id: "files",
    band: PINNED_SECTION_BAND,
    rank: 4,
    title: input.titles.files,
    results: input.files,
  };
}

/**
 * The sections a tab shows. All mixes every kind and leads with recent workspaces until
 * something is typed, then also finds projects; every other tab lists everything of its one
 * kind.
 */
export function buildCommandCenterSections(
  input: CommandCenterSectionsInput,
): CommandCenterResultSection[] {
  switch (input.tab) {
    case "all": {
      const actions = buildContributionSections(input.contributions, input.query);
      if (!input.query.trim()) return [recentWorkspacesSection(input), ...actions];
      return [...actions, projectsSection(input), workspacesSection(input), filesSection(input)];
    }
    case "workspaces":
      return [workspacesSection(input)];
    case "files":
      return [filesSection(input)];
    case "actions":
      return buildContributionSections(input.contributions, input.query, {
        includeQueryOnly: true,
      });
  }
}
