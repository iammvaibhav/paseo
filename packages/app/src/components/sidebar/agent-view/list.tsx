import { useCallback, useMemo, type MutableRefObject, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import type { GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { usePathname } from "expo-router";
import { Button } from "@/components/ui/button";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { SidebarAgentListSkeleton } from "@/components/sidebar-agent-list-skeleton";
import { isNative as platformIsNative } from "@/constants/platform";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarAgentViewStore } from "@/stores/sidebar-agent-view-store";
import { useSidebarSearchStore } from "@/stores/sidebar-search-store";
import {
  SidebarSearchArchivedSection,
  SidebarSearchEmptyState,
} from "@/components/sidebar/sidebar-search-bar";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { getFocusedAgentId, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildMissionControlRoute } from "@/utils/host-routes";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { agentKey, type SidebarAgentViewSectionKey } from "./model";
import { SidebarAgentViewRow } from "./row";
import { SidebarAgentViewSectionHeader } from "./section-header";
import { useSidebarAgentView } from "./use-sidebar-agent-view";
export const SECTION_LABEL_KEYS: Record<SidebarAgentViewSectionKey, string> = {
  pinned: "sidebar.pinned.title",
  running: "sidebar.agentView.sections.running",
  recent: "sidebar.agentView.sections.recent",
  results: "sidebar.search.resultsTitle",
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
  const sidebarModel = useSidebarModel();
  const hasArchivedMatches = sidebarModel.search.archivedMatches.length > 0;
  // "Show project" can only reveal a project the projects view lists, so resolve the agent's
  // workspace against the same (filtered) project list it renders.
  const projectViewKeyByWorkspaceKey = useMemo(() => {
    const byWorkspaceKey = new Map<string, string>();
    for (const project of sidebarModel.projects) {
      for (const workspace of project.workspaces) {
        byWorkspaceKey.set(workspace.workspaceKey, project.viewKey);
      }
    }
    return byWorkspaceKey;
  }, [sidebarModel.projects]);
  const resolveProjectViewKey = useCallback(
    (row: LifecycleRow) =>
      row.agent.workspaceId
        ? (projectViewKeyByWorkspaceKey.get(`${row.agent.serverId}:${row.agent.workspaceId}`) ??
          null)
        : null,
    [projectViewKeyByWorkspaceKey],
  );

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
          projectViewKey={resolveProjectViewKey(row)}
          selected={key === selectedKey}
          onAgentPress={onAgentPress}
        />
      );
    },
    [onAgentPress, resolveProjectViewKey, selectedKey],
  );

  const pinnedAgentOrder = useSidebarAgentViewStore((state) => state.pinnedAgentOrder);
  const setPinnedAgentOrder = useSidebarAgentViewStore((state) => state.setPinnedAgentOrder);
  const handlePinnedDragEnd = useCallback(
    (rows: LifecycleRow[]) => {
      const reorderedVisibleKeys = rows.map(agentKey);
      if (!hasVisibleOrderChanged({ currentOrder: pinnedAgentOrder, reorderedVisibleKeys })) return;
      setPinnedAgentOrder(
        mergeWithRemainder({ currentOrder: pinnedAgentOrder, reorderedVisibleKeys }),
      );
    },
    [pinnedAgentOrder, setPinnedAgentOrder],
  );
  const renderPinnedRow = useCallback(
    ({ item, isActive }: DraggableRenderItemInfo<LifecycleRow>) => (
      <SidebarAgentViewRow
        row={item}
        projectViewKey={resolveProjectViewKey(item)}
        selected={agentKey(item) === selectedKey}
        onAgentPress={onAgentPress}
        draggable
        isDragging={isActive}
      />
    ),
    [onAgentPress, resolveProjectViewKey, selectedKey],
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

  // Pinned agents sit above the header, like pinned workspaces in the workspace view.
  const pinnedSection = sections.find((section) => section.key === "pinned") ?? null;
  const listSections = sections.filter((section) => section.key !== "pinned");
  const emptyBody = searchActive ? <SidebarSearchEmptyState /> : emptyComponent;
  const content = (
    <>
      {pinnedSection ? (
        <View style={styles.section} testID="sidebar-agent-view-pinned">
          <SidebarAgentViewSectionHeader
            title={t(SECTION_LABEL_KEYS.pinned)}
            count={pinnedSection.rows.length}
            testID="sidebar-agent-view-section-pinned"
          />
          <DraggableList
            testID="sidebar-agent-view-pinned-list"
            data={pinnedSection.rows}
            keyExtractor={agentKey}
            renderItem={renderPinnedRow}
            onDragEnd={handlePinnedDragEnd}
            extraData={selectedKey}
            scrollEnabled={false}
            useDragHandle
            nestable={platformIsNative}
            simultaneousGestureRef={parentGestureRef}
            gestureHostPresented={active}
          />
        </View>
      ) : null}
      {listHeaderComponent}
      {listSections.length === 0 && !pinnedSection && !hasArchivedMatches
        ? emptyBody
        : listSections.map((section) => (
            <View key={section.key} style={styles.section}>
              <SidebarAgentViewSectionHeader
                title={t(SECTION_LABEL_KEYS[section.key])}
                count={section.rows.length}
                testID={`sidebar-agent-view-section-${section.key}`}
              />
              {section.rows.map(renderRow)}
            </View>
          ))}
      <SidebarSearchArchivedSection />
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
