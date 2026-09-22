import { memo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusRing } from "@/components/status-ring";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { AgentGridItem } from "./items";

export interface TileStatusProps {
  item: AgentGridItem;
}

/**
 * Visual status indicator for an AgentGridTile header:
 * - Running: rotating StatusRing
 * - Ready for review: solid green dot (attention bucket)
 * - Done: muted idle dot
 */
export const TileStatus = memo(function TileStatus({ item }: TileStatusProps): ReactElement {
  const { row, section } = item;
  const { agent, bucket } = row;

  const isDone = bucket === "done" || bucket === "dormant" || (section as string) === "done";
  const isRunning =
    !isDone &&
    (bucket === "running" ||
      (bucket === "needs_you" && agent.status === "running") ||
      section === "running");

  let accessibilityLabel = "Ready";
  if (isDone) {
    accessibilityLabel = "Done";
  } else if (isRunning) {
    accessibilityLabel = "Running";
  }

  let statusIndicator: ReactElement;
  if (isRunning) {
    statusIndicator = <StatusRing backdrop="surface0" />;
  } else if (isDone) {
    statusIndicator = <View style={styles.dotDone} />;
  } else {
    statusIndicator = <View style={styles.dotReady} />;
  }

  return (
    <View
      style={styles.container}
      testID={`mission-control-agent-grid-status-${agent.id}`}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      {statusIndicator}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dotReady: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor:
      getStatusDotColor({ theme, bucket: "attention" }) ?? theme.colors.statusDotSuccess,
  },
  dotDone: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.5,
  },
}));
