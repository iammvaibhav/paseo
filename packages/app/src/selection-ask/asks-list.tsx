import { useCallback, useRef, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Archive } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isSelectionAskAgent } from "@getpaseo/protocol/agent-labels";
import { useShallow } from "zustand/shallow";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { useMenuContext } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { useReopenAskStore } from "./reopen-store";
import { aggregateAskStatusBucket, resolveAskTitle } from "./track-presentation";

const EMPTY_ASKS: Agent[] = [];
const ROW_ICON_SIZE = 14;

const ThemedArchive = withUnistyles(Archive);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function selectSelectionAsks(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): Agent[] {
  const agents = state.sessions[serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_ASKS;
  }
  const rows: Agent[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt || agent.parentAgentId !== agentId || !isSelectionAskAgent(agent)) {
      continue;
    }
    rows.push(agent);
  }
  if (rows.length === 0) {
    return EMPTY_ASKS;
  }
  rows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  return rows;
}

/**
 * Asks forked from this agent, as a pill on the composer track bar. Hidden
 * when there are none. A row reopens the selection Ask popover in answer mode;
 * the popover header still owns "open in its own tab". Archive matches the
 * subagents track: hover on desktop, always visible on touch, and a Clear all
 * row at the foot of the panel.
 */
export function SelectionAsksList({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const asks = useSessionStore(
    useShallow((state) => selectSelectionAsks(state, serverId, agentId)),
  );
  const { archiveAgent } = useArchiveAgent();

  const handleClearAll = useCallback(() => {
    for (const askAgent of asks) {
      void archiveAgent({ serverId, agentId: askAgent.id })
        .then(() => {
          useReopenAskStore.getState().requestAskDismiss({
            sourceAgentId: agentId,
            askAgentId: askAgent.id,
          });
          return undefined;
        })
        .catch(() => undefined);
    }
  }, [agentId, archiveAgent, asks, serverId]);

  if (asks.length === 0) {
    return null;
  }

  const pillLabel =
    asks.length === 1
      ? t("selectionAsks.pillLabelOne")
      : t("selectionAsks.pillLabelMany", { count: asks.length });

  return (
    <ComposerTrackPill
      testID="selection-asks-header"
      label={pillLabel}
      panelTitle={t("selectionAsks.title")}
      statusBucket={aggregateAskStatusBucket(asks)}
    >
      {asks.map((askAgent) => (
        <SelectionAsksRow
          key={askAgent.id}
          agent={askAgent}
          serverId={serverId}
          sourceAgentId={agentId}
        />
      ))}
      <ClearAllRow onPress={handleClearAll} />
    </ComposerTrackPill>
  );
}

function ClearAllRow({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedArchive
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {t("selectionAsks.clearAll")}
        </Text>
      </>
    ),
    [t],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={t("selectionAsks.clearAll")}
      testID="selection-asks-clear-all"
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function SelectionAsksRow({
  agent,
  serverId,
  sourceAgentId,
}: {
  agent: Agent;
  serverId: string;
  sourceAgentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const title = resolveAskTitle(agent);
  const rowRef = useRef<View>(null);
  const isCompact = useIsCompactFormFactor();
  const { archiveAgent } = useArchiveAgent();
  const { setOpen } = useMenuContext("SelectionAsksRow");
  const actionsAlwaysVisible = isNative || isCompact;
  const statusBucket = deriveSidebarStateBucket({
    bucket: agent.bucket,
    status: agent.status,
    pendingPermissionCount: agent.pendingPermissions.length,
    attentionReason: agent.attentionReason,
    stoppedBy: agent.stoppedBy,
  });

  const handleOpen = useCallback(() => {
    const element = rowRef.current;
    if (element) {
      element.measureInWindow((x, y, width, height) => {
        setOpen(false);
        useReopenAskStore.getState().requestReopenAsk({
          sourceAgentId,
          askAgentId: agent.id,
          anchorRect: { top: y, left: x, width, height },
        });
      });
      return;
    }
    setOpen(false);
    useReopenAskStore.getState().requestReopenAsk({
      sourceAgentId,
      askAgentId: agent.id,
    });
  }, [agent.id, setOpen, sourceAgentId]);

  const handleArchivePress = useCallback(() => {
    void archiveAgent({ serverId, agentId: agent.id })
      .then(() => {
        useReopenAskStore.getState().requestAskDismiss({
          sourceAgentId,
          askAgentId: agent.id,
        });
        return undefined;
      })
      .catch(() => undefined);
  }, [agent.id, archiveAgent, serverId, sourceAgentId]);

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <View style={[styles.statusDot, statusDotStyle(statusBucket)]} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {title}
        </Text>
        <AskRowActions
          rowId={agent.id}
          displayLabel={title}
          visible={actionsAlwaysVisible || active}
          onArchivePress={handleArchivePress}
        />
      </>
    ),
    [actionsAlwaysVisible, agent.id, handleArchivePress, statusBucket, title],
  );

  return (
    <View ref={rowRef} collapsable={false}>
      <ComposerTrackRow
        accessibilityLabel={t("selectionAsks.openAction", { label: title })}
        testID={`selection-asks-row-${agent.id}`}
        onPress={handleOpen}
      >
        {renderRow}
      </ComposerTrackRow>
    </View>
  );
}

function AskRowActions({
  rowId,
  displayLabel,
  visible,
  onArchivePress,
}: {
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onArchivePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      <AskActionButton
        accessibilityLabel={t("selectionAsks.archiveAction", { label: displayLabel })}
        testID={`selection-asks-row-archive-${rowId}`}
        tooltipLabel={t("selectionAsks.archiveTooltip")}
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

function AskActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  visible,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  visible: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
        >
          {({ hovered, pressed }) => (
            <ThemedArchive
              size={ROW_ICON_SIZE}
              uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function statusDotStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.dotNeedsInput;
    case "failed":
      return styles.dotFailed;
    case "running":
      return styles.dotRunning;
    case "attention":
      return styles.dotAttention;
    case "done":
      return styles.dotDone;
  }
}

const styles = StyleSheet.create((theme) => ({
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  statusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  dotNeedsInput: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  dotFailed: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  dotRunning: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  dotAttention: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  dotDone: {
    backgroundColor: theme.colors.border,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
