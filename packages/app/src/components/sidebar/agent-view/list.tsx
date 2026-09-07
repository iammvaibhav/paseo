import { useCallback, useMemo, type MutableRefObject, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import type { GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SidebarAgentListSkeleton } from "@/components/sidebar-agent-list-skeleton";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useHosts } from "@/runtime/host-runtime";
import { isNative as platformIsNative } from "@/constants/platform";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { agentWorkspaceKey, type SidebarAgentViewBucket } from "./model";
import { SidebarAgentViewRow } from "./row";
import { useSidebarAgentView } from "./use-sidebar-agent-view";
export const BUCKET_LABEL_KEYS: Record<SidebarAgentViewBucket, string> = {
  needs_you: "sidebar.agentView.sections.needsYou",
  running: "sidebar.agentView.sections.running",
  ready: "sidebar.agentView.sections.ready",
  done: "sidebar.agentView.sections.done",
};

function SidebarAgentViewSectionHeader({
  bucket,
  count,
}: {
  bucket: SidebarAgentViewBucket;
  count: number;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.sectionHeader} testID={`sidebar-agent-view-section-${bucket}`}>
      <Text style={styles.sectionTitle} numberOfLines={1}>
        {t(BUCKET_LABEL_KEYS[bucket])}
      </Text>
      <Text style={styles.sectionCount} numberOfLines={1}>
        {count}
      </Text>
    </View>
  );
}

export interface SidebarAgentViewListProps {
  active: boolean;
  listHeaderComponent: ReactElement;
  onAgentPress?: () => void;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}

export function SidebarAgentViewList({
  active,
  listHeaderComponent,
  onAgentPress,
  parentGestureRef,
}: SidebarAgentViewListProps): ReactElement {
  const { t } = useTranslation();
  const { sections, isInitialLoad, hasActiveFilter, clearFilters } = useSidebarAgentView({
    enabled: active,
  });

  const hosts = useHosts();
  const showHostGlyph = hosts.length > 1;

  const { allHostProjects } = useSidebarModel();
  const projectNameByWorkspaceKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of allHostProjects) {
      for (const workspace of project.workspaces) {
        map.set(
          agentWorkspaceKey(workspace.serverId, workspace.workspaceId),
          project.projectName || workspace.projectName || workspace.name,
        );
      }
    }
    return map;
  }, [allHostProjects]);

  const nativeScrollGestureProps = useMemo(
    () =>
      parentGestureRef
        ? ({
            simultaneousHandlers: parentGestureRef,
          } as object)
        : undefined,
    [parentGestureRef],
  );

  const renderRow = useCallback(
    (row: LifecycleRow) => {
      const workspaceKey = row.agent.workspaceId
        ? agentWorkspaceKey(row.agent.serverId, row.agent.workspaceId)
        : null;
      const projectName = workspaceKey ? projectNameByWorkspaceKey.get(workspaceKey) : undefined;
      return (
        <SidebarAgentViewRow
          key={`${row.agent.serverId}:${row.agent.id}`}
          row={row}
          projectName={projectName}
          showHostGlyph={showHostGlyph}
          onAgentPress={onAgentPress}
        />
      );
    },
    [projectNameByWorkspaceKey, showHostGlyph, onAgentPress],
  );

  const emptyComponent = useMemo(
    () => (
      <View style={styles.emptyContainer} testID="sidebar-agent-view-empty-state">
        <Text style={styles.emptyTitle}>{t("sidebar.agentView.empty.title")}</Text>
        <Text style={styles.emptyDescription}>{t("sidebar.agentView.empty.description")}</Text>
        {hasActiveFilter ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={clearFilters}
            testID="sidebar-agent-view-clear-filters"
          >
            {t("sidebar.agentView.empty.clear")}
          </Button>
        ) : null}
      </View>
    ),
    [clearFilters, hasActiveFilter, t],
  );

  if (isInitialLoad) {
    const skeletonContent = (
      <>
        {listHeaderComponent}
        <SidebarAgentListSkeleton />
      </>
    );
    return (
      <View style={styles.container}>
        {platformIsNative ? (
          <NestableScrollContainer
            {...nativeScrollGestureProps}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {skeletonContent}
          </NestableScrollContainer>
        ) : (
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {skeletonContent}
          </ScrollView>
        )}
      </View>
    );
  }

  const content = (
    <>
      {listHeaderComponent}
      {sections.length === 0
        ? emptyComponent
        : sections.map((section) => (
            <View key={section.bucket}>
              <SidebarAgentViewSectionHeader bucket={section.bucket} count={section.rows.length} />
              {section.rows.map(renderRow)}
            </View>
          ))}
    </>
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          {...nativeScrollGestureProps}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-agent-view-list"
        >
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-agent-view-list"
        >
          {content}
        </ScrollView>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    userSelect: "none",
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
    minWidth: 0,
  },
  sectionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: "500",
    flexShrink: 0,
  },
  emptyContainer: {
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[4],
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
