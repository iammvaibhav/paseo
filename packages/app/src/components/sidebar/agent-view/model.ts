import { getAgentPinnedAt } from "@getpaseo/protocol/agent-labels";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
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
 * Pinned agents, then Running (agents waiting on you first, then running
 * ones), then one Recent list of every other unarchived agent (ready, done)
 * newest first. Status shows in each row's dot, so marking an agent done
 * changes its dot without moving it. Closed (dormant) agents show only when
 * pinned. While a search narrows the view, one ranked Results section replaces
 * all of them.
 */
export type SidebarAgentViewSectionKey = "pinned" | "running" | "recent" | "results";

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
  /**
   * The Pinned section's drag order (`serverId:agentId`). Pins come from each agent's
   * AGENT_PINNED_AT_LABEL; pinned agents missing from this order sit newest pin first.
   */
  pinnedAgentOrder: readonly string[];
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

  const pinned: LifecycleRow[] = [];
  const needsYou: LifecycleRow[] = [];
  const running: LifecycleRow[] = [];
  const recent: LifecycleRow[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (!keep(row)) continue;
      if (getAgentPinnedAt(row.agent.labels)) {
        pinned.push(row);
      } else if (group.bucket === "needs_you") {
        needsYou.push(row);
      } else if (group.bucket === "running") {
        running.push(row);
      } else if (group.bucket !== "dormant") {
        recent.push(row);
      }
    }
  }
  pinned.sort((left, right) =>
    (getAgentPinnedAt(right.agent.labels) ?? "").localeCompare(
      getAgentPinnedAt(left.agent.labels) ?? "",
    ),
  );
  recent.sort(compareTimeDescRows);

  const sections: SidebarAgentViewSection[] = [];
  if (pinned.length > 0) {
    sections.push({
      key: "pinned",
      rows: applyStoredOrdering({
        items: pinned,
        storedOrder: [...input.pinnedAgentOrder],
        getKey: agentKey,
      }),
    });
  }
  if (needsYou.length + running.length > 0) {
    sections.push({ key: "running", rows: [...needsYou, ...running] });
  }
  if (recent.length > 0) sections.push({ key: "recent", rows: recent });
  return sections;
}

export function agentKey(row: LifecycleRow): string {
  return `${row.agent.serverId}:${row.agent.id}`;
}
