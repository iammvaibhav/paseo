import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** A bucket heading of the agent view, also used for the search bar's Archived section. */
export function SidebarAgentViewSectionHeader({
  title,
  count,
  testID,
}: {
  title: string;
  count: number;
  testID: string;
}) {
  return (
    <View style={styles.sectionHeader} testID={testID}>
      <Text style={styles.sectionTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.sectionCount} numberOfLines={1}>
        {count}
      </Text>
    </View>
  );
}

// Mirrors the project rows of the workspace view (`projectRow`, `projectTitle` in
// sidebar-workspace-list.tsx).
const styles = StyleSheet.create((theme) => ({
  sectionHeader: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    userSelect: "none",
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    flex: 1,
    minWidth: 0,
  },
  sectionCount: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
}));
