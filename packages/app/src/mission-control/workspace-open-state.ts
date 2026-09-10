import { useCallback } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import {
  selectHasHydratedWorkspaces,
  selectWorkspace,
  type SessionsSnapshot,
} from "@/stores/session-store-hooks/selectors";

export interface WorkspaceOpenState {
  /**
   * The agent's workspace is in the archived ("done") bucket. Distinct from
   * `isUnavailable`: an archived workspace is a deliberate terminal state,
   * while an absent workspace just means this host's synced directory no
   * longer lists it (often a wrong-host lookup). Only this flag may label an
   * agent "Archived".
   */
  isArchived: boolean;
  /**
   * The workspace directory has hydrated and the host no longer lists the
   * workspace — opening it would dead-end on the missing-workspace recovery
   * state. NOT archived: the workspace may simply live on another host.
   * False while the directory is still hydrating, when the workspace is
   * present, and when the workspace is archived (archived wins).
   */
  isUnavailable: boolean;
  /**
   * Combined "would this workspace open dead-end?" flag: archived OR
   * unavailable (absent post-hydration). Navigating to either dead-ends on
   * the missing-workspace state, so "Open in workspace" affordances must
   * degrade (disable + explain) instead of navigating. False while the
   * workspace directory is still hydrating — the cold-open path must keep
   * working. Kept for callers that only gate navigation and do not need to
   * distinguish the two reasons.
   */
  isArchivedOrMissing: boolean;
}

/**
 * Shared "would this workspace open dead-end?" check for Mission Control
 * surfaces (board row menu, inspector header). Mirrors the app's missing-state
 * machinery (resolveWorkspaceSelectionStatus / useWorkspaceExists): a synced
 * host that no longer lists the workspace, or a workspace being archived,
 * cannot host a live workspace tab.
 */
export function selectWorkspaceOpenState(
  state: SessionsSnapshot,
  serverId: string | null,
  workspaceId: string | null | undefined,
): WorkspaceOpenState {
  if (!serverId || !workspaceId) {
    return { isArchived: false, isUnavailable: false, isArchivedOrMissing: false };
  }
  const workspace = selectWorkspace(state, serverId, workspaceId);
  if (workspace !== null) {
    // `status: "done"` is the daemon's IDLE default for a quiet workspace —
    // it stamps `archivingAt: null, status: "done"` at creation and the
    // sidebar upgrades it to "running" when an agent is active. Reading it as
    // archived labelled every idle workspace, and every agent inside it,
    // Archived. `archivingAt` is the real archive signal.
    const isArchived = workspace.archivingAt !== null;
    return { isArchived, isUnavailable: false, isArchivedOrMissing: isArchived };
  }
  const hasHydratedWorkspaces = selectHasHydratedWorkspaces(state, serverId);
  return {
    isArchived: false,
    isUnavailable: hasHydratedWorkspaces,
    isArchivedOrMissing: hasHydratedWorkspaces,
  };
}

export function useWorkspaceOpenState(
  serverId: string | null,
  workspaceId: string | null | undefined,
): WorkspaceOpenState {
  const select = useCallback(
    (state: SessionsSnapshot) => selectWorkspaceOpenState(state, serverId, workspaceId),
    [serverId, workspaceId],
  );
  // Equality-aware: the selector builds a fresh object every call, so without
  // a comparator every board row subscribing here would re-render on ANY
  // session-store change. Shallow is enough — the shape is three booleans.
  return useStoreWithEqualityFn(useSessionStore, select, shallow);
}
