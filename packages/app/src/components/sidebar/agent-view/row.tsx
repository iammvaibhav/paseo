import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Archive, CircleAlert, GripVertical } from "lucide-react-native";
import { usePathname } from "expo-router";
import { StatusRing } from "@/components/status-ring";
import { DraggableListHandle } from "@/components/draggable-list";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { isNative, isWeb } from "@/constants/platform";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useLiveDuration } from "@/hooks/use-live-duration";
import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
import { rowActivityMs, rowRunningStartedMs, type LifecycleRow } from "@/mission-control/lifecycle";
import { useHostLabel } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
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
const ThemedGripVertical = withUnistyles(GripVertical);
const gripColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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

/**
 * The row's second line: the agent's project and the host it runs on ("paseo · dev"), or the
 * host alone when its workspace is not loaded and no project placement names one.
 */
function useAgentPlacementLabel(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  fallbackProjectName?: string | null;
}): string {
  const { serverId, workspaceId, fallbackProjectName } = input;
  // Selects a string so a row re-renders only when its own label changes.
  const projectName = useSessionStore((state) => {
    if (!workspaceId) return null;
    const workspace = state.sessions[serverId]?.workspaces.get(workspaceId);
    return workspace ? projectNameForWorkspace(workspace) : null;
  });
  const hostLabel = useHostLabel(serverId);
  const project = projectName ?? fallbackProjectName ?? null;
  return project ? `${project} · ${hostLabel}` : hostLabel;
}

export interface SidebarAgentViewRowProps {
  row: LifecycleRow;
  /** The agent the visible surface is showing; drawn like the open workspace's row. */
  selected: boolean;
  /** The projects-view project holding the agent's workspace; null hides "Show project". */
  projectViewKey: string | null;
  onAgentPress?: () => void;
  /**
   * The row sits in the Pinned section's drag list. Its status slot becomes the drag handle: it
   * shows a grip while hovered on web, and a short hold on it starts the drag on touch.
   */
  draggable?: boolean;
  isDragging?: boolean;
}

export const SidebarAgentViewRow = memo(function SidebarAgentViewRow({
  row,
  projectViewKey,
  selected,
  onAgentPress,
  draggable = false,
  isDragging = false,
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
  const placementLabel = useAgentPlacementLabel({
    serverId: agent.serverId,
    workspaceId: agent.workspaceId,
    fallbackProjectName: agent.projectPlacement?.projectName,
  });

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
      (isHovered || isDragging) && styles.rowHovered,
      selected && styles.rowSelected,
      pressed && styles.rowPressed,
    ],
    [isDragging, isHovered, selected],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const titleStyle = isHovered ? [styles.title, styles.titleHovered] : styles.title;

  const statusIndicator = <AgentStatusIndicator bucket={stateBucket} />;
  const leading = draggable ? (
    <DraggableListHandle
      accessibilityLabel={t("sidebar.agentView.menu.reorder", { title })}
      testID={`sidebar-agent-view-drag-handle-${agent.serverId}-${agent.id}`}
    >
      {(isHovered || isDragging) && !isNative ? (
        <View style={styles.statusSlot}>
          <ThemedGripVertical size={14} uniProps={gripColorMapping} />
        </View>
      ) : (
        statusIndicator
      )}
    </DraggableListHandle>
  ) : (
    statusIndicator
  );

  return (
    <SidebarAgentHoverCard agent={agent} title={title} disabled={contextMenuOpen || isDragging}>
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
            {leading}
            <View style={styles.text}>
              <Text style={titleStyle} numberOfLines={1}>
                {title}
              </Text>
              <Text
                style={styles.placement}
                numberOfLines={1}
                testID={`sidebar-agent-view-placement-${agent.serverId}-${agent.id}`}
              >
                {placementLabel}
              </Text>
            </View>
            <View style={styles.trailing}>
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
            </View>
          </ContextMenuTrigger>
          <SidebarAgentViewRowMenu
            row={row}
            projectViewKey={projectViewKey}
            onOpen={handleOpenInWorkspace}
          />
        </ContextMenu>
      </View>
    </SidebarAgentHoverCard>
  );
});

export interface SidebarArchivedAgentRowProps {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string;
  lastActivityAt: string | null;
  onPress: () => void;
}

/**
 * An archived agent found by the search bar: the agent row's layout, title,
 * second line, and time, with the archive glyph in the status slot. Archived
 * agents have no live state, so there is no hover card or row menu.
 */
export const SidebarArchivedAgentRow = memo(function SidebarArchivedAgentRow({
  serverId,
  agentId,
  workspaceId,
  title,
  lastActivityAt,
  onPress,
}: SidebarArchivedAgentRowProps) {
  const placementLabel = useAgentPlacementLabel({ serverId, workspaceId });
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
        <View style={styles.text}>
          <Text style={titleStyle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.placement} numberOfLines={1}>
            {placementLabel}
          </Text>
        </View>
        <View style={styles.trailing}>
          {timeLabel ? (
            <Text style={styles.time} numberOfLines={1}>
              {timeLabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
});

// The status slot, padding and type mirror the workspace row (`workspaceRow` in
// sidebar-workspace-list.tsx and sidebar-workspace-row-content.tsx). Agent rows add a second line
// (project · host), so the row aligns its children to the top: the status glyph and the time stay
// on the title's line instead of centring between the two lines.
const styles = StyleSheet.create((theme) => ({
  hoverTarget: {
    position: "relative",
  },
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "flex-start",
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
  text: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
  },
  placement: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  titleHovered: {
    opacity: 1,
  },
  // Holds the reminder glyph and the time on the title's line.
  trailing: {
    height: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
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
