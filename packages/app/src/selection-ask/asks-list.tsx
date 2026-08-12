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
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { isSelectionAskAgent } from "@getpaseo/protocol/agent-labels";
import { useShallow } from "zustand/shallow";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { useReopenAskStore } from "./reopen-store";

const EMPTY_ASKS: Agent[] = [];
const ASKS_LIST_MAX_HEIGHT = 200;

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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
 */
export function SelectionAsksList({ serverId, agentId }: { serverId: string; agentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const asks = useSessionStore(
    useShallow((state) => selectSelectionAsks(state, serverId, agentId)),
  );

  const toggle = useCallback(() => setExpanded((current) => !current), []);

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
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {asks.map((askAgent) => (
                <SelectionAsksRow key={askAgent.id} agent={askAgent} sourceAgentId={agentId} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SelectionAsksRow({ agent, sourceAgentId }: { agent: Agent; sourceAgentId: string }) {
  const title = agent.title ?? agent.name ?? "Ask";
  const rowRef = useRef<View>(null);
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
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.row,
      (pressed || hovered) && styles.rowActive,
    ],
    [],
  );

  return (
    <View ref={rowRef} collapsable={false}>
      <Pressable
        onPress={handleOpen}
        style={rowStyle}
        accessibilityRole="button"
        accessibilityLabel={`Open ask ${title}`}
        testID={`selection-asks-row-${agent.id}`}
      >
        <View style={[styles.statusDot, getAskStatusStyle(agent.status)]} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {title}
        </Text>
      </Pressable>
    </View>
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
}));
