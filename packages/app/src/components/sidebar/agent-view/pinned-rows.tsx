import { useCallback, useMemo, type MutableRefObject, type ReactElement } from "react";
import type { GestureType } from "react-native-gesture-handler";
import { usePathname } from "expo-router";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { isNative as platformIsNative } from "@/constants/platform";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { useAgentGridStore } from "@/screens/mission-control/agent-grid/store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarAgentViewStore } from "@/stores/sidebar-agent-view-store";
import { getFocusedAgentId, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildMissionControlRoute } from "@/utils/host-routes";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { agentKey } from "./model";
import { SidebarAgentViewRow } from "./row";

/**
 * `serverId:agentId` of the agent the visible surface is showing — the focused agent tab of
 * the open workspace, or the active tile while the Agent Grid is open — so an agent row is marked
 * the way the workspace view marks the open workspace.
 */
export function useSelectedSidebarAgentKey(): string | null {
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

/**
 * Resolves an agent row to the projects-view project holding its workspace. "Show project" can
 * only reveal a project the projects view lists, so this reads the same (filtered) project list
 * that view renders.
 */
export function useResolveAgentProjectViewKey(): (row: LifecycleRow) => string | null {
  const { projects } = useSidebarModel();
  const projectViewKeyByWorkspaceKey = useMemo(() => {
    const byWorkspaceKey = new Map<string, string>();
    for (const project of projects) {
      for (const workspace of project.workspaces) {
        byWorkspaceKey.set(workspace.workspaceKey, project.viewKey);
      }
    }
    return byWorkspaceKey;
  }, [projects]);
  return useCallback(
    (row: LifecycleRow) =>
      row.agent.workspaceId
        ? (projectViewKeyByWorkspaceKey.get(`${row.agent.serverId}:${row.agent.workspaceId}`) ??
          null)
        : null,
    [projectViewKeyByWorkspaceKey],
  );
}

export interface SidebarPinnedAgentRowsProps {
  rows: LifecycleRow[];
  /** Whether the sidebar hosting the list is presented; drags only start while it is. */
  active: boolean;
  onAgentPress?: () => void;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  testID?: string;
}

/**
 * The pinned agents as a drag-reorderable list, without a header. The agent view and the
 * workspaces view both render it, so a pinned agent shows in whichever view is open and a drag in
 * either one reorders both.
 */
export function SidebarPinnedAgentRows({
  rows,
  active,
  onAgentPress,
  parentGestureRef,
  testID = "sidebar-agent-view-pinned-list",
}: SidebarPinnedAgentRowsProps): ReactElement {
  const selectedKey = useSelectedSidebarAgentKey();
  const resolveProjectViewKey = useResolveAgentProjectViewKey();
  const pinnedAgentOrder = useSidebarAgentViewStore((state) => state.pinnedAgentOrder);
  const setPinnedAgentOrder = useSidebarAgentViewStore((state) => state.setPinnedAgentOrder);
  const handleDragEnd = useCallback(
    (reordered: LifecycleRow[]) => {
      const reorderedVisibleKeys = reordered.map(agentKey);
      if (!hasVisibleOrderChanged({ currentOrder: pinnedAgentOrder, reorderedVisibleKeys })) return;
      setPinnedAgentOrder(
        mergeWithRemainder({ currentOrder: pinnedAgentOrder, reorderedVisibleKeys }),
      );
    },
    [pinnedAgentOrder, setPinnedAgentOrder],
  );
  const renderRow = useCallback(
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

  return (
    <DraggableList
      testID={testID}
      data={rows}
      keyExtractor={agentKey}
      renderItem={renderRow}
      onDragEnd={handleDragEnd}
      extraData={selectedKey}
      scrollEnabled={false}
      useDragHandle
      nestable={platformIsNative}
      simultaneousGestureRef={parentGestureRef}
      gestureHostPresented={active}
    />
  );
}
