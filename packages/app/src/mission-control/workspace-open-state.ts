import { useCallback } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import {
  selectHasHydratedWorkspaces,
  selectWorkspace,
} from "@/stores/session-store-hooks/selectors";

export interface WorkspaceOpenState {
  /**
   * The agent's workspace is archived ("done") or absent from the host's
   * synced workspace directory. Navigating to it dead-ends on the
   * missing-workspace state, so "Open in workspace" affordances must degrade
   * (disable + explain) instead of navigating. False while the workspace
   * directory is still hydrating — the cold-open path must keep working.
   */
  isArchivedOrMissing: boolean;
}

/**
 * Shared "would this workspace open dead-end?" check for Mission Control
 * surfaces (board row menu, inspector header). Mirrors the app's missing-state
 * machinery (resolveWorkspaceSelectionStatus / useWorkspaceExists): a synced
 * host that no longer lists the workspace, or a workspace in the archived
 * ("done") bucket, cannot host a live workspace tab.
 */
export function selectWorkspaceOpenState(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string | null,
  workspaceId: string | null | undefined,
): WorkspaceOpenState {
  if (!serverId || !workspaceId) {
    return { isArchivedOrMissing: false };
  }
  const workspace = selectWorkspace(state, serverId, workspaceId);
  if (workspace !== null) {
    return { isArchivedOrMissing: workspace.status === "done" };
  }
  const hasHydratedWorkspaces = selectHasHydratedWorkspaces(state, serverId);
  return { isArchivedOrMissing: hasHydratedWorkspaces };
}

export function useWorkspaceOpenState(
  serverId: string | null,
  workspaceId: string | null | undefined,
): WorkspaceOpenState {
  const select = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      selectWorkspaceOpenState(state, serverId, workspaceId),
    [serverId, workspaceId],
  );
  // Equality-aware: the selector builds a fresh object every call, so without
  // a comparator every board row subscribing here would re-render on ANY
  // session-store change. Shallow is enough — the shape is one boolean.
  return useStoreWithEqualityFn(useSessionStore, select, shallow);
}
