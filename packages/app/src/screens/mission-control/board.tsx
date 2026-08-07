import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, CircleCheck, CircleDot, CircleX } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHostBadges } from "@/hosts/use-host-badges";
import { HostBadge } from "@/hosts/host-badge";
import type { HostBadgeModel } from "@/hosts/appearance";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { isCommanderAgent } from "@/mission-control/labels";

// Board bucket order per the Mission Control spec — needs-input and failures
// first, done last. Distinct from the sidebar's status-list order on purpose.
const BOARD_BUCKET_ORDER: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
];

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);

function bucketIcon(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return ThemedCircleAlert;
    case "failed":
      return ThemedCircleX;
    case "running":
      return ThemedCircleDot;
    case "attention":
    case "done":
      return ThemedCircleCheck;
  }
}

const bucketColorMapping = (theme: Theme, bucket: SidebarStateBucket) => ({
  color: getStatusDotColor({ theme, bucket }) ?? theme.colors.foregroundExtraMuted,
});

type BoardItem =
  | { kind: "bucket"; bucket: SidebarStateBucket; label: string }
  | { kind: "agent"; agent: AggregatedAgent; bucket: SidebarStateBucket }
  | { kind: "offlineHost"; serverId: string; label: string };

function itemKey(item: BoardItem): string {
  switch (item.kind) {
    case "bucket":
      return `bucket:${item.bucket}`;
    case "agent":
      return `agent:${item.agent.serverId}:${item.agent.id}`;
    case "offlineHost":
      return `offline:${item.serverId}`;
  }
}

export function MissionControlBoard({ testID }: { testID?: string } = {}) {
  const { agents } = useAggregatedAgents();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const hostBadges = useHostBadges({ enabled: true });

  const items = useMemo<BoardItem[]>(() => {
    const agentsByBucket = new Map<SidebarStateBucket, AggregatedAgent[]>();
    for (const agent of agents) {
      // The Commander (label `paseo.mission-control=*`) is invisible on the
      // board — it lives in the Mission Control thread, never in a bucket.
      if (isCommanderAgent(agent.labels)) {
        continue;
      }
      const bucket = deriveSidebarStateBucket({
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissionCount ?? 0,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
      });
      const rows = agentsByBucket.get(bucket);
      if (rows) {
        rows.push(agent);
      } else {
        agentsByBucket.set(bucket, [agent]);
      }
    }

    const boardItems: BoardItem[] = [];
    for (const bucket of BOARD_BUCKET_ORDER) {
      const rows = agentsByBucket.get(bucket);
      if (!rows || rows.length === 0) {
        continue;
      }
      boardItems.push({ kind: "bucket", bucket, label: STATUS_BUCKET_LABELS[bucket] });
      for (const agent of rows) {
        boardItems.push({ kind: "agent", agent, bucket });
      }
    }

    for (const host of hosts) {
      if (connectionStatuses.get(host.serverId) === "online") {
        continue;
      }
      boardItems.push({ kind: "offlineHost", serverId: host.serverId, label: host.label });
    }
    return boardItems;
  }, [agents, connectionStatuses, hosts]);

  const renderItem = useCallback(
    ({ item }: { item: BoardItem }) => {
      if (item.kind === "bucket") {
        return (
          <Text style={styles.bucketHeader} key={itemKey(item)}>
            {item.label}
          </Text>
        );
      }
      if (item.kind === "offlineHost") {
        return (
          <View style={styles.offlineHostRow} key={itemKey(item)}>
            <Text style={styles.offlineHostLabel} numberOfLines={1}>
              {item.label}
            </Text>
            <Text style={styles.offlineHostState}>offline</Text>
          </View>
        );
      }
      return (
        <AgentRow
          key={itemKey(item)}
          agent={item.agent}
          bucket={item.bucket}
          hostBadge={hostBadges.get(item.agent.serverId) ?? null}
        />
      );
    },
    [hostBadges],
  );

  return (
    <FlatList
      testID={testID}
      data={items}
      renderItem={renderItem}
      keyExtractor={itemKey}
      style={styles.list}
      contentContainerStyle={styles.listContent}
    />
  );
}

function AgentRow({
  agent,
  bucket,
  hostBadge,
}: {
  agent: AggregatedAgent;
  bucket: SidebarStateBucket;
  hostBadge: HostBadgeModel | null;
}) {
  const timeLabel = useCompactTimeAgo(agent.lastActivityAt);
  const Icon = bucketIcon(bucket);
  const iconColorMapping = useCallback(
    (theme: Theme) => bucketColorMapping(theme, bucket),
    [bucket],
  );
  const handlePress = useCallback(() => {
    void openAgentFromHistory({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      archived: false,
    });
  }, [agent]);

  const primaryLabel = agent.name ?? agent.title ?? agent.id;
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${primaryLabel}, ${STATUS_BUCKET_LABELS[bucket]}`}
      style={agentRowStyle}
    >
      {() => (
        <>
          <Icon size={12} uniProps={iconColorMapping} />
          <View style={styles.agentText}>
            <Text numberOfLines={1} style={styles.agentTitle}>
              {primaryLabel}
            </Text>
            {agent.name && agent.title ? (
              <Text numberOfLines={1} style={styles.agentSubtitle}>
                {agent.title}
              </Text>
            ) : null}
          </View>
          {timeLabel ? <Text style={styles.rowTime}>{timeLabel}</Text> : null}
          {hostBadge ? <HostBadge badge={hostBadge} /> : null}
        </>
      )}
    </Pressable>
  );
}

const agentRowStyle = ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
  styles.agentRow,
  hovered && styles.agentRowHovered,
];

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[2],
  },
  bucketHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    userSelect: "none",
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    userSelect: "none",
  },
  agentRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  agentText: {
    flex: 1,
    minWidth: 0,
  },
  agentTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  agentSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  offlineHostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  offlineHostLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  offlineHostState: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
}));
