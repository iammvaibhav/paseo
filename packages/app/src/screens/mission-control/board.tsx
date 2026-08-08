import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { FlatList, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, CircleCheck, CircleDot, CircleX } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useMissionControlLifecycle } from "@/mission-control/use-mission-control-lifecycle";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import { HostGlyph } from "@/mission-control/host-glyph";
import {
  LIFECYCLE_BUCKET_LABELS,
  type LifecycleBucket,
  type LifecycleRow,
} from "@/mission-control/lifecycle";
import { useInspectorStore } from "./inspector-store";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);

const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotWarning });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotDanger });
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotSuccess });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** Per-row leading glyph: failure stays red, awaiting-input amber, running blue,
 * ready success green, done/dormant quiet. One status token per signal (§13). */
function rowIconAndColor(row: LifecycleRow) {
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

type BoardItem =
  | { kind: "bucket"; bucket: LifecycleBucket; label: string }
  | { kind: "agent"; row: LifecycleRow }
  | { kind: "offlineHost"; serverId: string; label: string };

function itemKey(item: BoardItem): string {
  switch (item.kind) {
    case "bucket":
      return `bucket:${item.bucket}`;
    case "agent":
      return `agent:${item.row.agent.serverId}:${item.row.agent.id}`;
    case "offlineHost":
      return `offline:${item.serverId}`;
  }
}

async function clearAgentLifecycle(serverId: string, agentId: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    return;
  }
  const payload = await client.missionControlLifecycleSet({
    serverId,
    agentId,
    action: "clear",
  });
  if (!payload.ok) {
    throw new Error(payload.error ?? "Failed to clear");
  }
}

function MissionControlBoardEmpty(): ReactElement {
  return (
    <Text style={styles.emptyState} testID="mission-control-board-empty">
      No active agents
    </Text>
  );
}

export function MissionControlBoard({
  testID,
  hideAgentNames = false,
}: {
  testID?: string;
  /**
   * Central-config preference: hide name chips, leaving titles (spec).
   * Defaults to the central config read; the prop lets callers override.
   */
  hideAgentNames?: boolean;
} = {}) {
  const [showAll, setShowAll] = useState(false);
  const centralConfig = useMissionControlCentralConfig();
  const resolvedHideAgentNames = hideAgentNames || centralConfig.config?.hideAgentNames === true;
  const { groups } = useMissionControlLifecycle({
    showAll,
    retentionDays: centralConfig.config?.retentionDays,
  });
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);

  const doneRows = useMemo(
    () => groups.find((group) => group.bucket === "done")?.rows ?? [],
    [groups],
  );

  const handleClearAll = useCallback(() => {
    // Clear every Done row on its own host. Fire-and-forget per agent; the
    // "Cleared" verdict cards push back and refresh the board.
    for (const row of doneRows) {
      void clearAgentLifecycle(row.agent.serverId, row.agent.id).catch(() => {
        // A failed clear leaves the row in Done; the next push reconciles.
      });
    }
  }, [doneRows]);

  const items = useMemo<BoardItem[]>(() => {
    const boardItems: BoardItem[] = [];
    for (const group of groups) {
      boardItems.push({
        kind: "bucket",
        bucket: group.bucket,
        label: LIFECYCLE_BUCKET_LABELS[group.bucket],
      });
      for (const row of group.rows) {
        boardItems.push({ kind: "agent", row });
      }
    }
    for (const host of hosts) {
      if (connectionStatuses.get(host.serverId) === "online") {
        continue;
      }
      boardItems.push({ kind: "offlineHost", serverId: host.serverId, label: host.label });
    }
    return boardItems;
  }, [connectionStatuses, groups, hosts]);

  const renderItem = useCallback(
    ({ item }: { item: BoardItem }) => {
      if (item.kind === "bucket") {
        return (
          <BucketHeader
            key={itemKey(item)}
            bucket={item.bucket}
            label={item.label}
            onClearAll={item.bucket === "done" && doneRows.length > 0 ? handleClearAll : null}
          />
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
        <MemoizedAgentRow
          key={itemKey(item)}
          row={item.row}
          hideAgentNames={resolvedHideAgentNames}
        />
      );
    },
    [doneRows.length, handleClearAll, resolvedHideAgentNames],
  );

  return (
    <View style={styles.container}>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>All unarchived</Text>
        <Switch
          value={showAll}
          onValueChange={setShowAll}
          accessibilityLabel="Show all unarchived agents"
          testID="mission-control-board-toggle"
        />
      </View>
      <FlatList
        testID={testID}
        data={items}
        renderItem={renderItem}
        keyExtractor={itemKey}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={MissionControlBoardEmpty}
      />
    </View>
  );
}

function BucketHeader({
  bucket,
  label,
  onClearAll,
}: {
  bucket: LifecycleBucket;
  label: string;
  onClearAll: (() => void) | null;
}) {
  return (
    <View style={styles.bucketHeaderRow}>
      <Text style={styles.bucketHeader}>{label}</Text>
      {onClearAll ? (
        <Button
          variant="ghost"
          size="xs"
          onPress={onClearAll}
          testID={`mission-control-clear-${bucket}`}
        >
          Clear all
        </Button>
      ) : null}
    </View>
  );
}

const MemoizedAgentRow = memo(AgentRowImpl);

function AgentRowImpl({
  row,
  hideAgentNames,
}: {
  row: LifecycleRow;
  hideAgentNames: boolean;
}): ReactElement {
  const { agent } = row;
  const timeLabel = useCompactTimeAgo(agent.lastActivityAt);
  const { Icon, mapping } = rowIconAndColor(row);

  const handlePress = useCallback(() => {
    useInspectorStore.getState().openInspectorAgent({
      serverId: agent.serverId,
      agentId: agent.id,
    });
  }, [agent.id, agent.serverId]);

  const handleClear = useCallback(() => {
    void clearAgentLifecycle(agent.serverId, agent.id).catch(() => {
      // Bookkeeping action; a failed clear leaves the row in Done.
    });
  }, [agent.id, agent.serverId]);

  const keyLine = agent.title ?? agent.name ?? agent.id;
  const showNameChip = agent.name !== null && agent.name !== keyLine && !hideAgentNames;
  const isDone = row.bucket === "done";
  const bucketLabel = LIFECYCLE_BUCKET_LABELS[row.bucket];
  // On done rows the verdict line already carries the summary; a headline that
  // is literally the same text (user "Marked done"/"Cleared" cards) would read
  // as a duplicated line.
  const headline =
    row.lastReportHeadline !== null &&
    isDone &&
    row.verdict !== null &&
    row.lastReportHeadline === row.verdict.summary
      ? null
      : row.lastReportHeadline;

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${keyLine}, ${bucketLabel}`}
      style={agentRowStyle}
    >
      {() => (
        <>
          <Icon size={12} uniProps={mapping} />
          <HostGlyph serverId={agent.serverId} label={agent.serverLabel} size={16} />
          <View style={styles.agentText}>
            <Text numberOfLines={1} style={styles.agentTitle}>
              {keyLine}
            </Text>
            <View style={styles.agentMetaRow}>
              {showNameChip ? (
                <View style={styles.nameChip}>
                  <Text numberOfLines={1} style={styles.nameChipText}>
                    {agent.name}
                  </Text>
                </View>
              ) : null}
              {headline ? (
                <Text numberOfLines={1} style={styles.agentHeadline}>
                  {headline}
                </Text>
              ) : null}
            </View>
            {isDone && row.verdict ? (
              <Text numberOfLines={1} style={styles.verdictLine}>
                {row.verdict.summary}
              </Text>
            ) : null}
          </View>
          {timeLabel ? <Text style={styles.rowTime}>{timeLabel}</Text> : null}
          {isDone ? (
            <Button
              variant="ghost"
              size="xs"
              onPress={handleClear}
              testID={`mission-control-clear-agent-${agent.id}`}
            >
              Clear
            </Button>
          ) : null}
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
  container: {
    flex: 1,
    minWidth: 0,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[2],
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toggleLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    userSelect: "none",
  },
  bucketHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[2],
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
    minHeight: 36,
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
    gap: 1,
  },
  agentTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  agentMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
  },
  nameChip: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  nameChipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  agentHeadline: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  verdictLine: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  rowTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  emptyState: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[4],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
