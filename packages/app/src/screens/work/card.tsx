import { memo, useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { WorkItem } from "@getpaseo/protocol/work/types";

interface WorkCardProps {
  item: WorkItem;
  onOpenDetail: (itemId: string) => void;
  onDispatch: (itemId: string) => void;
  dragHandleProps?: Record<string, unknown>;
  setActivatorNodeRef?: (node: unknown) => void;
}

export const WorkCard = memo(function WorkCard({
  item,
  onOpenDetail,
  onDispatch,
  dragHandleProps,
  setActivatorNodeRef,
}: WorkCardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const showActions = isHovered || isNative || isCompact;
  const labels = item.labelIds ?? [];
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleOpenDetail = useCallback(() => onOpenDetail(item.id), [item.id, onOpenDetail]);
  const handleDispatch = useCallback(() => onDispatch(item.id), [item.id, onDispatch]);

  return (
    <View
      testID={`work-card-${item.id}`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={styles.cardWrap}
      {...(setActivatorNodeRef ? { ref: setActivatorNodeRef as never } : {})}
      {...(dragHandleProps ?? {})}
    >
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.humanKey}>{item.humanKey}</Text>
          {item.bucket ? <Text style={styles.bucket}>{item.bucket}</Text> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.priority}>{priorityText(item.priority, t)}</Text>
          {labels.length > 0 ? (
            <View style={styles.labelRow}>
              {labels.map((lid) => (
                <View key={lid} style={styles.labelChip}>
                  <Text style={styles.labelText}>{lid}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {item.subItemCount != null && item.subItemCount > 0 ? (
            <Text style={styles.subCount}>{String(item.subItemCount)}</Text>
          ) : null}
          {item.agentId ? (
            <Text style={styles.assignee} numberOfLines={1}>
              {item.agentId}
            </Text>
          ) : null}
        </View>
        {showActions ? (
          <View style={styles.actions}>
            <Pressable
              testID={`work-card-open-${item.id}`}
              onPress={handleOpenDetail}
              accessibilityLabel={t("work.card.openDetail")}
            >
              <Text style={styles.actionText}>{t("work.card.open")}</Text>
            </Pressable>
            <Pressable
              testID={`work-card-dispatch-${item.id}`}
              onPress={handleDispatch}
              accessibilityLabel={t("work.card.dispatch")}
            >
              <Text style={styles.actionText}>{t("work.card.dispatch")}</Text>
            </Pressable>
            <Pressable
              testID={`work-card-kebab-${item.id}`}
              onPress={handleOpenDetail}
              accessibilityLabel={t("work.card.more")}
            >
              <Text style={styles.actionText}>⋯</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
});

function priorityText(priority: WorkItem["priority"], translate: (k: string) => string): string {
  const key = `work.card.priority.${priority}`;
  const v = translate(key);
  return v === key ? priority : v;
}

const styles = StyleSheet.create((theme) => ({
  cardWrap: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  humanKey: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  bucket: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    fontWeight: "600",
  },
  title: {
    fontSize: 13,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  priority: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  labelRow: {
    flexDirection: "row",
    gap: 4,
    flexWrap: "wrap",
  },
  labelChip: {
    backgroundColor: theme.colors.surface2,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  labelText: {
    fontSize: 11,
    color: theme.colors.foreground,
  },
  subCount: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  assignee: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  actionText: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
}));
