import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { OctagonAlert, SignalHigh, SignalLow, SignalMedium } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { TicketPriority } from "@getpaseo/protocol/tickets/types";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const PRIORITY_ICONS = {
  urgent: withUnistyles(OctagonAlert),
  high: withUnistyles(SignalHigh),
  medium: withUnistyles(SignalMedium),
  low: withUnistyles(SignalLow),
} as const;

// Only urgent carries a status color; the signal bars rank by shape, not by hue.
const PRIORITY_COLOR_MAPPINGS: Record<TicketPriority, (theme: Theme) => { color: string }> = {
  urgent: (theme) => ({ color: theme.colors.statusDanger }),
  high: (theme) => ({ color: theme.colors.foreground }),
  medium: (theme) => ({ color: theme.colors.foregroundMuted }),
  low: (theme) => ({ color: theme.colors.foregroundMuted }),
};

export function usePriorityLabel(): (priority: TicketPriority) => string {
  const { t } = useTranslation();
  return useCallback((priority: TicketPriority) => t(`tickets.common.priority.${priority}`), [t]);
}

export function PriorityIcon({
  priority,
  size = ICON_SIZE.sm,
}: {
  priority: TicketPriority | null;
  size?: number;
}): ReactElement | null {
  const label = usePriorityLabel();
  if (priority === null) {
    return null;
  }
  const Icon = PRIORITY_ICONS[priority];
  return (
    <View accessible accessibilityLabel={label(priority)}>
      <Icon size={size} uniProps={PRIORITY_COLOR_MAPPINGS[priority]} />
    </View>
  );
}
