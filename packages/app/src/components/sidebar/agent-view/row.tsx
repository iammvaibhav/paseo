import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HostGlyph } from "@/components/host-glyph";
import { StatusRing } from "@/components/status-ring";
import { isWeb } from "@/constants/platform";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { rowActivityMs, type LifecycleRow } from "@/mission-control/lifecycle";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

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

function getStatusDotStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.statusDotNeedsInput;
    case "failed":
      return styles.statusDotFailed;
    case "running":
      return styles.statusDotRunning;
    case "attention":
      return styles.statusDotAttention;
    case "done":
      return styles.statusDotDone;
  }
}

export interface SidebarAgentViewRowProps {
  row: LifecycleRow;
  onAgentPress?: () => void;
}

export const SidebarAgentViewRow = memo(function SidebarAgentViewRow({
  row,
  onAgentPress,
}: SidebarAgentViewRowProps) {
  const { t } = useTranslation();
  const { agent } = row;

  const activityMs = useMemo(() => rowActivityMs(row), [row]);
  const activityDate = useMemo(
    () => (activityMs === null ? null : new Date(activityMs)),
    [activityMs],
  );
  const timeAgo = useCompactTimeAgo(activityDate);

  const stateBucket = rowToSidebarStateBucket(row);
  const title = agent.title ?? agent.name ?? t("agentList.fallbackTitle");

  const handlePress = useCallback(() => {
    onAgentPress?.();
    navigateToAgent({
      serverId: agent.serverId,
      workspaceId: agent.workspaceId ?? undefined,
      agentId: agent.id,
    });
  }, [agent.id, agent.serverId, agent.workspaceId, onAgentPress]);

  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={title}
      testID={`sidebar-agent-view-row-${agent.serverId}-${agent.id}`}
    >
      <View style={styles.glyphSlot}>
        {stateBucket === "running" ? (
          <StatusRing />
        ) : (
          <View style={[styles.statusDot, getStatusDotStyle(stateBucket)]} />
        )}
      </View>
      <HostGlyph serverId={agent.serverId} label={agent.serverLabel ?? agent.serverId} size="sm" />
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {timeAgo ? (
        <Text style={styles.time} numberOfLines={1}>
          {timeAgo}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[0.5],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  glyphSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  statusDotNeedsInput: {
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
  },
  statusDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  statusDotRunning: {
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
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
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
    minWidth: 0,
  },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    flexShrink: 0,
  },
}));
