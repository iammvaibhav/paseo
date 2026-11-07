import React, { type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatTimeAgo } from "@/utils/time";

/**
 * Muted one-line system row for timeline items that carry plumbing instead of
 * conversation — OMP provider notices and unknown history records. Never
 * rendered as inline prose; these are quiet context lines at most.
 */
export function MutedSystemRow({
  message,
  timestamp,
}: {
  message: string;
  timestamp?: number;
}): ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
      {timestamp !== undefined ? (
        <Text style={styles.time}>{formatTimeAgo(new Date(timestamp))}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[0.5],
  },
  text: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    textAlign: "center",
  },
  time: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
}));
