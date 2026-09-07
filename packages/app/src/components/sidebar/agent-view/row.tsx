import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, CircleCheck, CircleDot, CircleX } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { HostGlyph } from "@/components/host-glyph";
import { isWeb } from "@/constants/platform";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { rowActivityMs, type LifecycleRow } from "@/mission-control/lifecycle";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);

const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotWarning });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotDanger });
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotSuccess });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

export function rowIconAndColor(row: LifecycleRow) {
  switch (row.bucket) {
    case "needs_you": {
      const failed = row.agent.status === "error" || row.agent.attentionReason === "error";
      return failed
        ? { Icon: ThemedCircleX, mapping: dangerColorMapping }
        : { Icon: ThemedCircleAlert, mapping: warningColorMapping };
    }
    case "running":
      return { Icon: ThemedCircleDot, mapping: runningColorMapping };
    case "ready":
      return { Icon: ThemedCircleCheck, mapping: successColorMapping };
    case "done":
      return { Icon: ThemedCircleCheck, mapping: mutedColorMapping };
    case "dormant":
      return { Icon: ThemedCircleDot, mapping: mutedColorMapping };
  }
}

export interface SidebarAgentViewRowProps {
  row: LifecycleRow;
  projectName?: string;
  showHostGlyph: boolean;
  onAgentPress?: () => void;
}

export const SidebarAgentViewRow = memo(function SidebarAgentViewRow({
  row,
  projectName,
  showHostGlyph,
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

  const { Icon, mapping } = rowIconAndColor(row);
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

  const hasMeta = Boolean(projectName || showHostGlyph);

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={title}
      testID={`sidebar-agent-view-row-${agent.serverId}-${agent.id}`}
    >
      <View style={styles.glyphSlot}>
        <Icon size={12} uniProps={mapping} />
      </View>
      <View style={styles.contentColumn}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {timeAgo ? (
            <Text style={styles.time} numberOfLines={1}>
              {timeAgo}
            </Text>
          ) : null}
        </View>
        {hasMeta ? (
          <View style={styles.metaRow}>
            {showHostGlyph ? (
              <HostGlyph
                serverId={agent.serverId}
                label={agent.serverLabel ?? agent.serverId}
                size="sm"
              />
            ) : null}
            {projectName ? (
              <Text style={styles.metaText} numberOfLines={1}>
                {projectName}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "flex-start",
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
    width: 16,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginTop: 2,
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 14,
    flex: 1,
    minWidth: 0,
  },
}));
