import { useCallback, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Archive, ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { isSelectionAskAgent } from "@getpaseo/protocol/agent-labels";
import { useShallow } from "zustand/shallow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { useReopenAskStore } from "./reopen-store";

const EMPTY_ASKS: Agent[] = [];
const ASKS_LIST_MAX_HEIGHT = 200;

const ThemedArchive = withUnistyles(Archive);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const statusStyles = StyleSheet.create((theme) => ({
  running: {
    backgroundColor: theme.colors.accentBright,
  },
  error: {
    backgroundColor: theme.colors.destructive,
  },
  idle: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
}));

function getAskStatusStyle(status: Agent["status"]): ViewStyle {
  if (status === "running") {
    return statusStyles.running;
  }
  if (status === "error") {
    return statusStyles.error;
  }
  return statusStyles.idle;
}

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
 * Collapsed "Asks (N)" card above the composer's task list. Lists the side
 * asks forked from this agent (agents labeled paseo.selection-ask whose parent
 * is the current agent); hidden entirely when there are none. Clicking a row
 * reopens the selection Ask popover for that ask in answer mode; opening the
 * ask in its own tab is available from the popover's header button instead.
 * Rows offer the same hover archive affordance as the subagents track, and the
 * expanded header offers "Clear all" to archive every listed ask at once.
 */
export function SelectionAsksList({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const asks = useSessionStore(
    useShallow((state) => selectSelectionAsks(state, serverId, agentId)),
  );
  const { archiveAgent } = useArchiveAgent();

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  const handleClearAll = useCallback(() => {
    for (const askAgent of asks) {
      // Archiving removes each ask from the list; if it was open in the
      // selection Ask popover, ask the host to dismiss it.
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

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.headerToggle,
      (pressed || hovered) && styles.headerActive,
    ],
    [],
  );

  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  const headerAccessibilityState = useMemo(() => ({ expanded }), [expanded]);

  if (asks.length === 0) {
    return null;
  }

  return (
    <View style={styles.outer} testID="selection-asks-list">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              onPress={toggle}
              style={headerStyle}
              accessibilityRole="button"
              accessibilityState={headerAccessibilityState}
              testID="selection-asks-header"
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedMapping} />
              )}
              <Text style={styles.headerLabel}>Asks ({asks.length})</Text>
            </Pressable>
            {expanded ? (
              <View style={styles.headerAction}>
                <SelectionAskActionButton
                  accessibilityLabel={t("selectionAsks.clearAll")}
                  testID="selection-asks-clear-all"
                  tooltipLabel={t("selectionAsks.clearAll")}
                  visible
                  onPress={handleClearAll}
                />
              </View>
            ) : null}
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {asks.map((askAgent) => (
                <SelectionAsksRow
                  key={askAgent.id}
                  agent={askAgent}
                  serverId={serverId}
                  sourceAgentId={agentId}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
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
}) {
  const { t } = useTranslation();
  const title = agent.title ?? agent.name ?? "Ask";
  const rowRef = useRef<View>(null);
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const { archiveAgent } = useArchiveAgent();

  const handleOpen = useCallback(() => {
    const element = rowRef.current;
    if (element) {
      element.measureInWindow((x, y, width, height) => {
        useReopenAskStore.getState().requestReopenAsk({
          sourceAgentId,
          askAgentId: agent.id,
          anchorRect: { top: y, left: x, width, height },
        });
      });
    } else {
      useReopenAskStore.getState().requestReopenAsk({ sourceAgentId, askAgentId: agent.id });
    }
  }, [agent.id, sourceAgentId]);

  const handleArchivePress = useCallback(() => {
    // Archiving removes the ask from the list; if it was open in the selection
    // Ask popover, ask the host to dismiss it.
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

  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  // Same affordance as the subagents track: the archive action is always
  // visible on touch/compact surfaces and appears on hover elsewhere.
  const actionsAlwaysVisible = isNative || isCompact;
  const actionsVisible = actionsAlwaysVisible || hovered;

  return (
    // Wrapper View handles hover so moving the pointer between the row and
    // the archive button doesn't drop the hover state.
    <View
      ref={rowRef}
      collapsable={false}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ask ${title}`}
        testID={`selection-asks-row-${agent.id}`}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <View style={[styles.statusDot, getAskStatusStyle(agent.status)]} />
            <Text style={styles.rowLabel} numberOfLines={1}>
              {title}
            </Text>
            <View
              style={actionsVisible ? styles.actionClusterVisible : styles.actionClusterHidden}
              pointerEvents={actionsVisible ? "auto" : "none"}
            >
              <SelectionAskActionButton
                accessibilityLabel={t("selectionAsks.archiveAction", { label: title })}
                testID={`selection-asks-row-archive-${agent.id}`}
                tooltipLabel={t("selectionAsks.archiveTooltip")}
                visible={actionsVisible}
                onPress={handleArchivePress}
              />
            </View>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function SelectionAskActionButton({
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
}) {
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
              size={14}
              uniProps={hovered || pressed ? foregroundMapping : foregroundMutedMapping}
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

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[1],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerAction: {
    paddingRight: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[4],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: ASKS_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
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
