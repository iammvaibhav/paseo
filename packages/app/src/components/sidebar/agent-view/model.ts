import {
  compareTimeDescRows,
  type LifecycleBucketGroup,
  type LifecycleRow,
} from "@/mission-control/lifecycle";
import {
  sortBySidebarSearchRank,
  type SidebarSearchRanking,
} from "@/components/sidebar/sidebar-search-rank";

/**
 * Running agents, then one Recent list of every other visible agent (needs
 * you, ready, done) newest first. Status shows in each row's dot, so marking an
 * agent done changes its dot without moving it. While a search narrows the
 * view, one ranked Results section replaces both.
 */
export type SidebarAgentViewSectionKey = "running" | "recent" | "results";

export interface SidebarAgentViewSection {
  key: SidebarAgentViewSectionKey;
  rows: LifecycleRow[];
}

export function agentWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export interface BuildSidebarAgentViewSectionsInput {
  groups: readonly LifecycleBucketGroup[];
  hostFilters: readonly string[];
  projectFilters: readonly string[];
  projectViewKeyByWorkspaceKey: ReadonlyMap<string, string>;
  showDone: boolean;
  /** The search bar's matches and how to rank them; null while no search narrows the view. */
  search: (SidebarSearchRanking & { agentKeys: ReadonlySet<string> }) | null;
}

export function buildSidebarAgentViewSections(
  input: BuildSidebarAgentViewSectionsInput,
): SidebarAgentViewSection[] {
  const { groups, hostFilters, projectFilters, projectViewKeyByWorkspaceKey, search } = input;

  const hasHostFilter = hostFilters.length > 0;
  const allowedHosts = hasHostFilter ? new Set(hostFilters) : null;

  const hasProjectFilter = projectFilters.length > 0;
  const allowedProjects = hasProjectFilter ? new Set(projectFilters) : null;

  const keep = (row: LifecycleRow): boolean => {
    if (allowedHosts && !allowedHosts.has(row.agent.serverId)) {
      return false;
    }

    if (search && !search.agentKeys.has(`${row.agent.serverId}:${row.agent.id}`)) {
      return false;
    }

    if (allowedProjects) {
      if (!row.agent.workspaceId) {
        return false;
      }
      const key = agentWorkspaceKey(row.agent.serverId, row.agent.workspaceId);
      const projectViewKey = projectViewKeyByWorkspaceKey.get(key);
      if (!projectViewKey || !allowedProjects.has(projectViewKey)) {
        return false;
      }
    }

    return true;
  };

  // A search reaches every bucket, Done and closed agents included, and ranks
  // matches by how well they matched instead of by status and recency.
  if (search) {
    const rows = sortBySidebarSearchRank(
      search,
      groups.flatMap((group) => group.rows).filter(keep),
      (row) => ({
        key: `${row.agent.serverId}:${row.agent.id}`,
        agent: row.agent,
        activityMs: row.sortTime,
      }),
    );
    return rows.length > 0 ? [{ key: "results", rows }] : [];
  }

  const running: LifecycleRow[] = [];
  const recent: LifecycleRow[] = [];
  for (const group of groups) {
    if (group.bucket === "dormant") continue;
    if (group.bucket === "done" && !input.showDone) continue;
    const target = group.bucket === "running" ? running : recent;
    for (const row of group.rows) {
      if (keep(row)) target.push(row);
    }
  }
  recent.sort(compareTimeDescRows);

  const sections: SidebarAgentViewSection[] = [];
  if (running.length > 0) sections.push({ key: "running", rows: running });
  if (recent.length > 0) sections.push({ key: "recent", rows: recent });
  return sections;
}
