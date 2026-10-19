import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Archive, CircleAlert } from "lucide-react-native";
import { usePathname } from "expo-router";
import { StatusRing } from "@/components/status-ring";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { isWeb } from "@/constants/platform";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useLiveDuration } from "@/hooks/use-live-duration";
import { rowActivityMs, rowRunningStartedMs, type LifecycleRow } from "@/mission-control/lifecycle";
import type { Theme } from "@/styles/theme";
import { buildMissionControlRoute } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import {
  STATUS_INDICATOR_ALERT_SIZE,
  STATUS_INDICATOR_FILLED_DOT_SIZE,
} from "@/utils/status-indicator-geometry";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { focusAgentInGrid } from "@/screens/mission-control/agent-grid/grid-glow";
import { SidebarAgentHoverCard } from "./hover-card";
import { SidebarAgentViewRowMenu } from "./row-menu";
import { AgentReminderIndicator } from "@/agent-reminders/reminder-indicator";

const needsInputColorMapping = (theme: Theme) => ({
  color: theme.colors.background,
  fill: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});
const archiveColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArchive = withUnistyles(Archive);

const ThemedCircleAlert = withUnistyles(CircleAlert);

export function rowToSidebarStateBucket(row: LifecycleRow): SidebarStateBucket {
  switch (row.bucket) {
    case "running":
      return "running";
    case "ready":
      return "attention";
    case "needs_you":
      return row.agent.status === "error" || row.agent.attentionReason === "error"
        ? "failed"
        : "needs_input";
    case "done":
    case "dormant":
      return "done";
  }
}

function getStatusDotStyle(bucket: Exclude<SidebarStateBucket, "running" | "needs_input">) {
  switch (bucket) {
    case "failed":
      return styles.statusDotFailed;
    case "attention":
      return styles.statusDotAttention;
    case "done":
      return styles.statusDotDone;
  }
}

/** Same leading slot, geometry and glyphs as a workspace row's status indicator. */
function AgentStatusIndicator({ bucket }: { bucket: SidebarStateBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.statusSlot}>
        <StatusRing />
      </View>
    );
  }
  if (bucket === "needs_input") {
    return (
      <View style={styles.statusSlot}>
        <ThemedCircleAlert size={STATUS_INDICATOR_ALERT_SIZE} uniProps={needsInputColorMapping} />
      </View>
    );
  }
  return (
    <View style={styles.statusSlot}>
      <View style={[styles.statusDot, getStatusDotStyle(bucket)]} />
    </View>
  );
}

export interface SidebarAgentViewRowProps {
  row: LifecycleRow;
  /** The agent the visible surface is showing; drawn like the open workspace's row. */
  selected: boolean;
  onAgentPress?: () => void;
}

export const SidebarAgentViewRow = memo(function SidebarAgentViewRow({
  row,
  selected,
  onAgentPress,
}: SidebarAgentViewRowProps) {
  const { t } = useTranslation();
  const { agent } = row;

  // A running row says how long it has been running, counted from the same
  // turn start the open agent's own elapsed timer uses; every other row says
  // how long ago it last did anything.
  const runningStartedMs = useMemo(() => rowRunningStartedMs(row), [row]);
  const runningStartedAt = useMemo(
    () => (runningStartedMs === null ? null : new Date(runningStartedMs)),
    [runningStartedMs],
  );
  const activityMs = useMemo(
    () => (runningStartedMs === null ? rowActivityMs(row) : null),
    [row, runningStartedMs],
  );
  const activityDate = useMemo(
    () => (activityMs === null ? null : new Date(activityMs)),
    [activityMs],
  );
  const runningFor = useLiveDuration(runningStartedAt);
  const timeAgo = useCompactTimeAgo(activityDate);
  const timeLabel = runningStartedMs === null ? timeAgo : runningFor;

  const stateBucket = rowToSidebarStateBucket(row);
  const title = agent.title ?? agent.name ?? t("agentList.fallbackTitle");

  const pathname = usePathname();
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  const handleOpenInWorkspace = useCallback(() => {
    onAgentPress?.();
    navigateToAgent({
      serverId: agent.serverId,
      workspaceId: agent.workspaceId ?? undefined,
      agentId: agent.id,
    });
  }, [agent.id, agent.serverId, agent.workspaceId, onAgentPress]);

  // Highlighting the tile only makes sense while the Agent Grid is the visible surface. From
  // anywhere else (a workspace, the Commander view) the row opens the agent in its workspace.
  const handlePress = useCallback(() => {
    const isGridOpen =
      pathname === buildMissionControlRoute() && useAgentGridStore.getState().view === "grid";
    if (!isGridOpen) {
      handleOpenInWorkspace();
      return;
    }
    onAgentPress?.();
    const key = `${agent.serverId}:${agent.id}`;
    const store = useAgentGridStore.getState();
    store.setActiveKey(key);
    store.setGlow(key);
    focusAgentInGrid(agent.serverId, agent.id);
  }, [agent.id, agent.serverId, handleOpenInWorkspace, onAgentPress, pathname]);

  const handlePointerEnter = useCallback(() => {
    if (!contextMenuOpen) setIsHovered(true);
  }, [contextMenuOpen]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      isHovered && styles.rowHovered,
      selected && styles.rowSelected,
      pressed && styles.rowPressed,
    ],
    [isHovered, selected],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const titleStyle = isHovered ? [styles.title, styles.titleHovered] : styles.title;

  return (
    <SidebarAgentHoverCard agent={agent} title={title} disabled={contextMenuOpen}>
      <View
        style={styles.hoverTarget}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
          <ContextMenuTrigger
            style={rowStyle}
            onPress={handlePress}
            accessibilityRole={isWeb ? undefined : "button"}
            accessibilityState={accessibilityState}
            aria-selected={selected}
            accessibilityLabel={title}
            testID={`sidebar-agent-view-row-${agent.serverId}-${agent.id}`}
          >
            <AgentStatusIndicator bucket={stateBucket} />
            <Text style={titleStyle} numberOfLines={1}>
              {title}
            </Text>
            <AgentReminderIndicator
              reminder={agent.reminder}
              testID={`sidebar-agent-view-row-reminder-${agent.serverId}-${agent.id}`}
            />
            {timeLabel ? (
              <Text
                style={styles.time}
                numberOfLines={1}
                testID={`sidebar-agent-view-row-time-${agent.serverId}-${agent.id}`}
              >
                {timeLabel}
              </Text>
            ) : null}
          </ContextMenuTrigger>
          <SidebarAgentViewRowMenu row={row} onOpen={handleOpenInWorkspace} />
        </ContextMenu>
      </View>
    </SidebarAgentHoverCard>
  );
});

export interface SidebarArchivedAgentRowProps {
  agentId: string;
  title: string;
  lastActivityAt: string | null;
  onPress: () => void;
}

/**
 * An archived agent found by the search bar: the agent row's layout, title,
 * and time, with the archive glyph in the status slot. Archived agents have
 * no live state, so there is no hover card or row menu.
 */
export const SidebarArchivedAgentRow = memo(function SidebarArchivedAgentRow({
  agentId,
  title,
  lastActivityAt,
  onPress,
}: SidebarArchivedAgentRowProps) {
  const activityDate = useMemo(
    () => (lastActivityAt ? new Date(lastActivityAt) : null),
    [lastActivityAt],
  );
  const timeLabel = useCompactTimeAgo(activityDate);
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      isHovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isHovered],
  );
  const titleStyle = isHovered ? [styles.title, styles.titleHovered] : styles.title;

  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={title}
        testID={`sidebar-search-archived-${agentId}`}
      >
        <View style={styles.statusSlot}>
          <ThemedArchive size={STATUS_INDICATOR_ALERT_SIZE} uniProps={archiveColorMapping} />
        </View>
        <Text style={titleStyle} numberOfLines={1}>
          {title}
        </Text>
        {timeLabel ? (
          <Text style={styles.time} numberOfLines={1}>
            {timeLabel}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
});

// Mirrors the workspace row (`workspaceRow` in sidebar-workspace-list.tsx and the title and
// status slot in sidebar-workspace-row-content.tsx) so both sidebar views read as one list.
const styles = StyleSheet.create((theme) => ({
  hoverTarget: {
    position: "relative",
  },
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[0.5],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  statusSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  statusDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  statusDotAttention: {
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  statusDotDone: {
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.3,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
  titleHovered: {
    opacity: 1,
  },
  time: {
    height: 20,
    lineHeight: 20,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
}));
