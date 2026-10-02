import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TicketRun, TicketRunBucket } from "@getpaseo/protocol/tickets/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

// A run bucket reads like the sidebar dot of the same agent state, so the
// board and the sidebar never disagree about "needs you" or "ready".
const SIDEBAR_BUCKET: Record<TicketRunBucket, SidebarStateBucket | null> = {
  needs_you: "needs_input",
  running: "running",
  ready: "attention",
  done: "done",
  idle: null,
};

export function RunChip({ run }: { run: TicketRun }): ReactElement {
  const { t } = useTranslation();
  const name = run.agentName ?? run.agentTitle ?? t("tickets.common.agentFallback");
  const bucketLabel = t(`tickets.common.runBucket.${run.bucket}`);
  const dot = useMemo(() => <View style={styles.dot(run.bucket)} />, [run.bucket]);
  return (
    <View accessible accessibilityLabel={`${name}, ${bucketLabel}`} style={styles.wrap}>
      <StatusBadge label={name} leading={dot} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    flexShrink: 1,
    minWidth: 0,
    alignSelf: "flex-start",
  },
  dot: (bucket: TicketRunBucket) => {
    const sidebarBucket = SIDEBAR_BUCKET[bucket];
    const color = sidebarBucket
      ? getStatusDotColor({ theme, bucket: sidebarBucket, showDoneAsInactive: true })
      : null;
    return {
      width: theme.spacing[1.5],
      height: theme.spacing[1.5],
      borderRadius: theme.borderRadius.full,
      backgroundColor: color ?? theme.colors.foregroundExtraMuted,
    };
  },
}));
