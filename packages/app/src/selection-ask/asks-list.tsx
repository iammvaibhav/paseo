import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react-native";
import { isSelectionAskAgent } from "@getpaseo/protocol/agent-labels";
import { useShallow } from "zustand/shallow";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const EMPTY_ASKS: Agent[] = [];

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedExternalLink = withUnistyles(ExternalLink);

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
 * Collapsed "Asks (N)" strip above the composer's task list. Lists the side
 * asks forked from this agent (agents labeled paseo.selection-ask whose parent
 * is the current agent); hidden entirely when there are none.
 */
export function SelectionAsksList({ serverId, agentId }: { serverId: string; agentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const asks = useSessionStore(
    useShallow((state) => selectSelectionAsks(state, serverId, agentId)),
  );

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  const headerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.header,
      (pressed || hovered) && styles.headerActive,
    ],
    [],
  );

  const headerAccessibilityState = useMemo(() => ({ expanded }), [expanded]);

  const handleOpenAsk = useCallback(
    (askAgentId: string) => {
      navigateToAgent({ serverId, agentId: askAgentId });
    },
    [serverId],
  );

  if (asks.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Pressable
        onPress={toggle}
        style={headerStyle}
        accessibilityRole="button"
        accessibilityState={headerAccessibilityState}
        testID="selection-asks-header"
      >
        {expanded ? (
          <ThemedChevronDown size={13} uniProps={foregroundMutedMapping} />
        ) : (
          <ThemedChevronRight size={13} uniProps={foregroundMutedMapping} />
        )}
        <Text style={styles.headerLabel}>Asks ({asks.length})</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.list}>
          {asks.map((askAgent) => (
            <SelectionAsksRow key={askAgent.id} agent={askAgent} onOpen={handleOpenAsk} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SelectionAsksRow({ agent, onOpen }: { agent: Agent; onOpen: (agentId: string) => void }) {
  const title = agent.title ?? agent.name ?? "Ask";
  const handleOpen = useCallback(() => onOpen(agent.id), [agent.id, onOpen]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (pressed || hovered) && styles.rowActive,
    ],
    [],
  );

  return (
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
      <ThemedExternalLink size={12} uniProps={foregroundMutedMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: theme.borderRadius.sm,
    alignSelf: "flex-start",
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  list: {
    gap: 2,
    paddingTop: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: theme.borderRadius.sm,
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: 12,
    flex: 1,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
}));
