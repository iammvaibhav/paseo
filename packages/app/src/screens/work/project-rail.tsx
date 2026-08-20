import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWorkItems, useWorkProjects } from "@/data/work";
import {
  setSelectedWorkProjectKey,
  useSelectedWorkProjectKey,
} from "@/screens/work/selection-store";
import type { Theme } from "@/styles/theme";
import type { WorkProject } from "@getpaseo/protocol/work/types";

interface WorkProjectRailProps {
  compact?: boolean;
}

interface WorkProjectRowProps {
  project: WorkProject;
  selected: boolean;
}

const WorkProjectRow = memo(function WorkProjectRow({
  project,
  selected,
}: WorkProjectRowProps): ReactElement {
  const { t } = useTranslation();
  const { items, isLoading } = useWorkItems(project.projectKey);
  const count = useMemo(() => {
    if (isLoading && items.length === 0) return null;
    let open = 0;
    for (const item of items) {
      if (!item.closed) open += 1;
    }
    return open;
  }, [items, isLoading]);

  const countLabel = useMemo(() => {
    if (count === null) return "—";
    return t("work.rail.openCount", { count });
  }, [count, t]);

  const handlePress = useCallback(() => {
    setSelectedWorkProjectKey(project.projectKey);
  }, [project.projectKey]);

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      selected ? styles.rowSelected : null,
      hovered && !selected ? styles.rowHovered : null,
      pressed ? styles.rowPressed : null,
    ],
    [selected],
  );

  return (
    <Pressable
      testID={`work-project-${project.projectKey}`}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={pressableStyle}
    >
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {project.displayName}
        </Text>
        <Text style={styles.rowHint} numberOfLines={1}>
          {project.identifier}
        </Text>
      </View>
      <View style={styles.rowTrailing}>
        <Text style={styles.countText}>{countLabel}</Text>
      </View>
    </Pressable>
  );
});

interface WorkCompactProjectPillProps {
  project: WorkProject;
  selected: boolean;
}

const WorkCompactProjectPill = memo(function WorkCompactProjectPill({
  project,
  selected,
}: WorkCompactProjectPillProps): ReactElement {
  const handlePress = useCallback(() => {
    setSelectedWorkProjectKey(project.projectKey);
  }, [project.projectKey]);

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  const pillStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.compactPill,
      selected ? styles.compactPillSelected : null,
      pressed ? styles.compactPillPressed : null,
    ],
    [selected],
  );

  return (
    <Pressable
      key={project.projectKey}
      testID={`work-project-${project.projectKey}`}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={pillStyle}
    >
      <Text
        style={selected ? styles.compactPillTextSelected : styles.compactPillText}
        numberOfLines={1}
      >
        {project.displayName}
      </Text>
      <Text style={styles.compactPillHint} numberOfLines={1}>
        {project.identifier}
      </Text>
    </Pressable>
  );
});

export function WorkProjectRail({ compact = false }: WorkProjectRailProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const effectiveCompact = compact || isCompact;
  const { projects, unreachableHosts, hostsNeedingUpdate, isLoading, error } = useWorkProjects();
  const selectedKey = useSelectedWorkProjectKey();

  const unreachableNotice =
    unreachableHosts.length > 0 ? (
      <View style={styles.unreachableBanner} testID="work-rail-unreachable">
        <Text style={styles.unreachableTitle}>{t("work.rail.unreachableHint")}</Text>
        <Text style={styles.unreachableDetail} numberOfLines={2}>
          {t("work.rail.unreachableDetail", { hosts: unreachableHosts.join(", ") })}
        </Text>
      </View>
    ) : null;

  const needsUpdateNotice =
    hostsNeedingUpdate.length > 0 ? (
      <View style={styles.unreachableBanner} testID="work-rail-needs-update">
        <Text style={styles.unreachableTitle}>{t("work.rail.needsUpdateHint")}</Text>
        <Text style={styles.unreachableDetail} numberOfLines={2}>
          {t("work.rail.needsUpdateDetail", { hosts: hostsNeedingUpdate.join(", ") })}
        </Text>
      </View>
    ) : null;

  const railNotices = (
    <>
      {unreachableNotice}
      {needsUpdateNotice}
    </>
  );

  if (isLoading && projects.length === 0) {
    return (
      <View style={styles.container} testID="work-project-rail">
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>{t("work.rail.title")}</Text>
        </View>
        <View style={styles.loadingRow}>
          <LoadingSpinner color={styles.spinnerColor.color} size={14} />
          <Text style={styles.loadingText}>{t("work.rail.loading")}</Text>
        </View>
        {railNotices}
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container} testID="work-project-rail">
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>{t("work.rail.title")}</Text>
        </View>
        <Text style={styles.errorText}>{error}</Text>
        {railNotices}
        {projects.length === 0 ? <EmptyRail /> : null}
      </View>
    );
  }

  if (projects.length === 0) {
    return (
      <View style={styles.container} testID="work-project-rail">
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>{t("work.rail.title")}</Text>
        </View>
        {railNotices}
        <EmptyRail />
      </View>
    );
  }

  if (effectiveCompact) {
    return (
      <View style={styles.container} testID="work-project-rail">
        {railNotices}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.compactContent}
          style={styles.compactScroll}
        >
          {projects.map((project) => (
            <WorkCompactProjectPill
              key={project.projectKey}
              project={project}
              selected={project.projectKey === selectedKey}
            />
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="work-project-rail">
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>{t("work.rail.title")}</Text>
      </View>
      {railNotices}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {projects.map((project, index) => (
          <View key={project.projectKey} style={index === 0 ? null : styles.rowBorderWrap}>
            <WorkProjectRow project={project} selected={project.projectKey === selectedKey} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function EmptyRail(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyWrap} testID="work-rail-empty">
      <Text style={styles.emptyTitle}>{t("work.rail.emptyTitle")}</Text>
      <Text style={styles.emptyHint}>{t("work.rail.emptyHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    marginHorizontal: theme.spacing[1],
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    opacity: 0.85,
  },
  rowBorderWrap: {
    borderTopWidth: 0,
  },
  rowContent: {
    flex: 1,
    marginRight: theme.spacing[3],
    minWidth: 0,
  },
  rowTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  rowHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  rowTrailing: {
    alignItems: "flex-end",
    justifyContent: "center",
    flexShrink: 0,
  },
  countText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  unreachableBanner: {
    marginHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    gap: 2,
  },
  unreachableTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  unreachableDetail: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  emptyWrap: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[1],
  },
  emptyTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  emptyHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  compactScroll: {
    flexGrow: 0,
  },
  compactContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  compactPill: {
    flexDirection: "column",
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    minWidth: 120,
    maxWidth: 220,
  },
  compactPillSelected: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
  },
  compactPillPressed: {
    opacity: 0.85,
  },
  compactPillText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  compactPillTextSelected: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  compactPillHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
