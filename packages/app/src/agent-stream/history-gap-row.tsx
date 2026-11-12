import { memo, useCallback } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { TimelineGap } from "@/timeline/timeline-sync-plan";

/**
 * Unloaded history between two loaded ranges, left by a jump to an older
 * message. Each press loads the page right below the row above, so reading
 * continues in order; the row disappears when the ranges meet.
 */
export const HistoryGapRow = memo(function HistoryGapRow({
  gap,
  loading,
  onLoad,
}: {
  gap: TimelineGap;
  loading: boolean;
  onLoad: (gap: TimelineGap) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onLoad(gap), [gap, onLoad]);
  return (
    <View style={styles.container} testID="agent-history-gap">
      <View style={styles.line} />
      <Button
        variant="ghost"
        size="sm"
        loading={loading}
        disabled={loading}
        onPress={handlePress}
        testID="agent-history-gap-load"
      >
        {t("historyGap.load")}
      </Button>
      <View style={styles.line} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
}));
