import { useCallback, useMemo, type MutableRefObject, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import type { GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { usePathname } from "expo-router";
import { Button } from "@/components/ui/button";
import { SidebarAgentListSkeleton } from "@/components/sidebar-agent-list-skeleton";
import { isNative as platformIsNative } from "@/constants/platform";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarSearchStore } from "@/stores/sidebar-search-store";
import { SidebarSearchEmptyState } from "@/components/sidebar/sidebar-search-bar";
import { getFocusedAgentId, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildMissionControlRoute } from "@/utils/host-routes";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { SidebarAgentViewBucket } from "./model";
import { SidebarAgentViewRow } from "./row";
import { SidebarAgentViewSectionHeader } from "./section-header";
import { useSidebarAgentView } from "./use-sidebar-agent-view";
export const BUCKET_LABEL_KEYS: Record<SidebarAgentViewBucket, string> = {
  needs_you: "sidebar.agentView.sections.needsYou",
  running: "sidebar.agentView.sections.running",
  ready: "sidebar.agentView.sections.ready",
  done: "sidebar.agentView.sections.done",
};

/**
 * `serverId:agentId` of the agent the visible surface is showing — the focused agent tab of
 * the open workspace, or the active tile while the Agent Grid is open — so the agent view marks
 * its row the way the workspace view marks the open workspace.
 */
function useSelectedSidebarAgentKey(): string | null {
  const pathname = usePathname();
  const selection = useActiveWorkspaceSelection();
  const workspaceKey = selection ? buildWorkspaceTabPersistenceKey(selection) : null;
  const focusedAgentId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? getFocusedAgentId(state.layoutByWorkspace[workspaceKey]) : null,
  );
  const gridActiveKey = useAgentGridStore((state) =>
    state.view === "grid" ? state.activeKey : null,
  );
  if (pathname === buildMissionControlRoute()) return gridActiveKey;
  return selection && focusedAgentId ? `${selection.serverId}:${focusedAgentId}` : null;
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
  const selectedKey = useSelectedSidebarAgentKey();
  const searchActive = useSidebarSearchStore((state) => state.query.trim().length > 0);

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
      const key = `${row.agent.serverId}:${row.agent.id}`;
      return (
        <SidebarAgentViewRow
          key={key}
          row={row}
          selected={key === selectedKey}
          onAgentPress={onAgentPress}
        />
      );
    },
    [onAgentPress, selectedKey],
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

  const emptyBody = searchActive ? <SidebarSearchEmptyState /> : emptyComponent;
  const content = (
    <>
      {listHeaderComponent}
      {sections.length === 0
        ? emptyBody
        : sections.map((section) => (
            <View key={section.bucket} style={styles.section}>
              <SidebarAgentViewSectionHeader
                title={t(BUCKET_LABEL_KEYS[section.bucket])}
                count={section.rows.length}
                testID={`sidebar-agent-view-section-${section.bucket}`}
              />
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
  section: {
    paddingBottom: theme.spacing[3],
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
