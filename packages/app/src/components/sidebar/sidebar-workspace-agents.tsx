import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useLiveTimeAgo } from "@/hooks/use-compact-time-ago";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarAgentEntry } from "@/hooks/use-sidebar-workspace-agents";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { isWeb as platformIsWeb } from "@/constants/platform";
import {
  useSidebarWorkspaceAgentsStore,
  type SidebarAgentsSort,
} from "@/stores/sidebar-workspace-agents-store";

// The width of a workspace row's status slot plus the row gap, so the agent rows land on
// the same rail as the workspace titles above them.
const AGENTS_SECTION_INDENT = 14 + 8;

/**
 * The agent list an expanded workspace row reveals: a compact sort toggle and one row per
 * root agent. Clicking an agent opens it.
 */
export function SidebarWorkspaceAgentsSection({
  workspace,
  agents,
}: {
  workspace: Pick<SidebarWorkspaceEntry, "workspaceKey" | "serverId" | "workspaceId">;
  agents: readonly SidebarAgentEntry[];
}) {
  const { t } = useTranslation();
  const agentsSort = useSidebarWorkspaceAgentsStore((s) => s.agentsSort);
  const setAgentsSort = useSidebarWorkspaceAgentsStore((s) => s.setAgentsSort);
  const handleSortByActivity = useCallback(() => setAgentsSort("activity"), [setAgentsSort]);
  const handleSortByCreated = useCallback(() => setAgentsSort("created"), [setAgentsSort]);
  if (agents.length === 0) {
    return null;
  }

  return (
    <View style={styles.section} testID={`sidebar-workspace-agents-${workspace.workspaceKey}`}>
      <View style={styles.header}>
        <Text style={styles.headerCount} numberOfLines={1}>
          {t("sidebar.workspace.agents.count", { count: agents.length })}
        </Text>
        <View style={styles.sortToggle}>
          <SortButton
            label={t("sidebar.workspace.agents.sortByActivity")}
            active={agentsSort === "activity"}
            testID={`sidebar-workspace-agents-sort-activity-${workspace.workspaceKey}`}
            onPress={handleSortByActivity}
          />
          <SortButton
            label={t("sidebar.workspace.agents.sortByCreated")}
            active={agentsSort === "created"}
            testID={`sidebar-workspace-agents-sort-created-${workspace.workspaceKey}`}
            onPress={handleSortByCreated}
          />
        </View>
      </View>
      {agents.map((agent) => (
        <SidebarAgentRow
          key={agent.agentId}
          agent={agent}
          agentsSort={agentsSort}
          workspace={workspace}
        />
      ))}
    </View>
  );
}

function SortButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  const style = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.sortButton,
      active && styles.sortButtonActive,
      pressed && styles.sortButtonPressed,
    ],
    [active],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={onPress}
      style={style}
      accessibilityRole={platformIsWeb ? undefined : "button"}
      accessibilityState={accessibilityState}
      hitSlop={4}
      testID={testID}
    >
      <Text style={[styles.sortButtonText, active && styles.sortButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function SidebarAgentRow({
  agent,
  agentsSort,
  workspace,
}: {
  agent: SidebarAgentEntry;
  agentsSort: SidebarAgentsSort;
  workspace: Pick<SidebarWorkspaceEntry, "workspaceKey" | "serverId" | "workspaceId">;
}) {
  const { t } = useTranslation();
  // The visible timestamp follows the active sort so the order always explains itself:
  // sorted by activity the rows say how long ago each agent last worked, sorted by
  // creation the rows say when each was created.
  const timeAgo = useLiveTimeAgo(agentsSort === "created" ? agent.createdAt : agent.lastActivityAt);
  const title = agent.title ?? agent.name ?? t("agentList.fallbackTitle");
  const handlePress = useCallback(() => {
    navigateToAgent({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      agentId: agent.agentId,
    });
  }, [agent.agentId, workspace.serverId, workspace.workspaceId]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.agentRow,
      hovered && styles.agentRowHovered,
      pressed && styles.agentRowPressed,
    ],
    [],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole={platformIsWeb ? undefined : "button"}
      accessibilityLabel={title}
      testID={`sidebar-workspace-agent-row-${workspace.workspaceKey}-${agent.agentId}`}
    >
      <View
        style={[styles.agentStatusDot, getAgentStatusDotStyle(agent.statusBucket)]}
        testID={`sidebar-workspace-agent-status-${agent.agentId}`}
      />
      <Text style={styles.agentTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.agentTime} numberOfLines={1}>
        {timeAgo}
      </Text>
    </Pressable>
  );
}

function getAgentStatusDotStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.agentStatusDotNeedsInput;
    case "failed":
      return styles.agentStatusDotFailed;
    case "running":
      return styles.agentStatusDotRunning;
    case "attention":
      return styles.agentStatusDotAttention;
    case "done":
      return styles.agentStatusDotIdle;
  }
}

const styles = StyleSheet.create((theme) => {
  const statusDot = (bucket: SidebarStateBucket) => ({
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket }) ?? undefined,
  });
  return {
    section: {
      paddingLeft: AGENTS_SECTION_INDENT,
      paddingRight: theme.spacing[3],
      paddingBottom: theme.spacing[1],
      gap: 2,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[2],
      paddingVertical: 4,
    },
    headerCount: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
      fontWeight: "500",
      flexShrink: 1,
      minWidth: 0,
    },
    sortToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      flexShrink: 0,
    },
    sortButton: {
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
    },
    sortButtonActive: {
      backgroundColor: theme.colors.surface2,
    },
    sortButtonPressed: {
      opacity: 0.8,
    },
    sortButtonText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
      lineHeight: 14,
    },
    sortButtonTextActive: {
      color: theme.colors.foreground,
    },
    agentRow: {
      minHeight: 26,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 3,
      borderRadius: theme.borderRadius.md,
    },
    agentRowHovered: {
      backgroundColor: theme.colors.surfaceSidebarHover,
    },
    agentRowPressed: {
      backgroundColor: theme.colors.surface2,
    },
    agentStatusDot: {
      width: 6,
      height: 6,
      borderRadius: theme.borderRadius.full,
      flexShrink: 0,
    },
    agentStatusDotNeedsInput: statusDot("needs_input"),
    agentStatusDotFailed: statusDot("failed"),
    agentStatusDotRunning: statusDot("running"),
    agentStatusDotAttention: statusDot("attention"),
    agentStatusDotIdle: {
      backgroundColor: theme.colors.foregroundExtraMuted,
      opacity: 0.4,
    },
    agentTitle: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      lineHeight: 18,
      flex: 1,
      minWidth: 0,
    },
    agentTime: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
      flexShrink: 0,
    },
  };
});
