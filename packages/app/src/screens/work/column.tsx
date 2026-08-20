import type { ReactElement, ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWorkColumnDroppable, type WorkColumnId } from "@getpaseo/protocol/work/state";

interface WorkColumnProps {
  columnId: WorkColumnId;
  title: string;
  count: number;
  droppable: boolean;
  children: ReactNode;
}

export function WorkColumn({
  columnId,
  title,
  count,
  droppable,
  children,
}: WorkColumnProps): ReactElement {
  const effectiveDroppable = droppable && isWorkColumnDroppable(columnId);
  return (
    <View
      testID={`work-column-${columnId}`}
      style={[styles.column, !effectiveDroppable ? styles.nonDroppable : null]}
      accessibilityLabel={title}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={styles.countBadge} testID={`work-column-count-${columnId}`}>
          <Text style={styles.countText}>{String(count)}</Text>
        </View>
        {!effectiveDroppable ? <Text style={styles.nonDroppableHint}>·</Text> : null}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: 300,
    flexShrink: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  nonDroppable: {
    opacity: 0.85,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  countBadge: {
    backgroundColor: theme.colors.surface1,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  countText: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  nonDroppableHint: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  body: {
    flex: 1,
  },
}));
