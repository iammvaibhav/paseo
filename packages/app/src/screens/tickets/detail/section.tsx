import type { ReactElement, ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

/** One block of the ticket body. A single top border separates it from the one above. */
export function DetailSection({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.section} testID={testID}>
      {children}
    </View>
  );
}

/**
 * The section label with an optional tally, and a trailing slot for the
 * section's add action. The row has a fixed height so the slot filling in
 * does not move the rows below.
 */
export function SectionHeader({
  title,
  tally,
  children,
}: {
  title: string;
  tally?: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <View style={styles.header}>
      <View style={styles.titleGroup}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {tally ? <Text style={styles.tally}>{tally}</Text> : null}
      </View>
      {children}
    </View>
  );
}

export function SectionEmpty({ children }: { children: string }): ReactElement {
  return <Text style={styles.empty}>{children}</Text>;
}

const styles = StyleSheet.create((theme) => ({
  section: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[2],
  },
  header: {
    minHeight: CONTROL_HEIGHTS.tight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  tally: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
