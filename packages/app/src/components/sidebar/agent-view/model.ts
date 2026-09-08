import type { LifecycleBucketGroup, LifecycleRow } from "@/mission-control/lifecycle";

export type SidebarAgentViewBucket = "needs_you" | "running" | "ready" | "done";

export const SIDEBAR_AGENT_VIEW_BUCKET_ORDER: readonly SidebarAgentViewBucket[] = [
  "needs_you",
  "running",
  "ready",
  "done",
];

export interface SidebarAgentViewSection {
  bucket: SidebarAgentViewBucket;
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
}

export function buildSidebarAgentViewSections(
  input: BuildSidebarAgentViewSectionsInput,
): SidebarAgentViewSection[] {
  const { groups, hostFilters, projectFilters, projectViewKeyByWorkspaceKey, showDone } = input;

  const hasHostFilter = hostFilters.length > 0;
  const allowedHosts = hasHostFilter ? new Set(hostFilters) : null;

  const hasProjectFilter = projectFilters.length > 0;
  const allowedProjects = hasProjectFilter ? new Set(projectFilters) : null;

  const rowsByBucket = new Map<LifecycleBucketGroup["bucket"], LifecycleRow[]>();
  for (const group of groups) {
    const existing = rowsByBucket.get(group.bucket);
    if (existing) {
      existing.push(...group.rows);
    } else {
      rowsByBucket.set(group.bucket, [...group.rows]);
    }
  }

  const sections: SidebarAgentViewSection[] = [];

  for (const bucket of SIDEBAR_AGENT_VIEW_BUCKET_ORDER) {
    if (bucket === "done" && !showDone) {
      continue;
    }

    const rows = rowsByBucket.get(bucket);
    if (!rows || rows.length === 0) {
      continue;
    }

    const filteredRows = rows.filter((row) => {
      if (allowedHosts && !allowedHosts.has(row.agent.serverId)) {
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
    });

    if (filteredRows.length > 0) {
      sections.push({
        bucket,
        rows: filteredRows,
      });
    }
  }

  return sections;
}
