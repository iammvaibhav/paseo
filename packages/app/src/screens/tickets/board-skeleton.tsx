import type { ReactElement } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SPACING } from "@/styles/theme";
import { TICKET_LANE_WIDTH } from "./board-lanes";

// Same box as the loaded board, so nothing moves when the cards arrive.
const SKELETON_LANES = ["a", "b", "c", "d"] as const;
const SKELETON_CARD_COUNTS: Record<(typeof SKELETON_LANES)[number], number> = {
  a: 3,
  b: 2,
  c: 4,
  d: 1,
};
const CONTENT_STYLE = {
  gap: SPACING[3],
  paddingHorizontal: SPACING[3],
  paddingBottom: SPACING[3],
} as const;
const BUSY_STATE = { busy: true } as const;

export function BoardSkeleton(): ReactElement {
  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={CONTENT_STYLE}
      scrollEnabled={false}
      accessibilityState={BUSY_STATE}
      testID="tickets-board-skeleton"
    >
      {SKELETON_LANES.map((lane) => (
        <View key={lane} style={styles.lane}>
          <View style={styles.header} />
          {Array.from({ length: SKELETON_CARD_COUNTS[lane] }, (_, index) => (
            <View key={index} style={styles.card} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  lane: {
    width: TICKET_LANE_WIDTH,
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  header: {
    width: "40%",
    height: theme.spacing[4],
    marginVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  card: {
    height: theme.spacing[24],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
}));
