import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MissionControlMode } from "@getpaseo/protocol/mission-control/types";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMissionControlMode } from "@/mission-control/central-config";

const MODE_OPTIONS: SegmentedControlOption<MissionControlMode>[] = [
  { value: "ask", label: "Ask", testID: "mission-control-mode-ask" },
  { value: "auto", label: "Auto", testID: "mission-control-mode-auto" },
];

/**
 * Ask/Auto approval-gate toggle for the Mission Control header. RPC-backed
 * and instant; destructive proposals always ask regardless of mode.
 */
export function MissionControlModeToggle({
  size = "sm",
}: {
  size?: "xs" | "sm" | "md";
}): ReactElement {
  const { mode, isUpdating, setMode } = useMissionControlMode();

  const handleChange = useCallback(
    (next: MissionControlMode) => {
      if (next === mode || isUpdating) {
        return;
      }
      void setMode(next);
    },
    [isUpdating, mode, setMode],
  );

  return (
    <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View collapsable={false} style={styles.trigger}>
          <SegmentedControl<MissionControlMode>
            options={MODE_OPTIONS}
            value={mode ?? "ask"}
            onValueChange={handleChange}
            size={size}
            testID="mission-control-mode-toggle"
          />
        </View>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <View style={styles.tooltipBody}>
          <View style={styles.tooltipRow}>
            <Text style={styles.tooltipLabel}>Ask</Text>
            <Text style={styles.tooltipText}>every outbound action becomes a proposal</Text>
          </View>
          <View style={styles.tooltipRow}>
            <Text style={styles.tooltipLabel}>Auto</Text>
            <Text style={styles.tooltipText}>
              sends immediately — destructive actions still ask
            </Text>
          </View>
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    alignSelf: "center",
  },
  tooltipBody: {
    gap: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  tooltipLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    minWidth: 34,
  },
  tooltipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
  },
}));
