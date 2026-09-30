import type { ReactElement } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function TicketKey({ ticketKey }: { ticketKey: string }): ReactElement {
  return (
    <Text style={styles.key} numberOfLines={1} selectable>
      {ticketKey}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  key: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
