import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CheckoutStatusPayload } from "@/git/use-status-query";
import type { WorktreeArchiveWarningLabels } from "@/git/worktree-archive-warning";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";

export interface UseWorkspaceScreenArchiveInput {
  serverId: string;
  /** The workspace being archived; null while the descriptor has not hydrated. */
  workspace: WorkspaceDescriptor | null;
  /** Name for the confirmation dialog when the descriptor is missing. */
  fallbackName: string;
  /** Live checkout status; fresher than the descriptor's git runtime when present. */
  gitStatus: CheckoutStatusPayload | null;
  /** Archiving the selected workspace navigates away from it before the screen goes dead. */
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}

export interface WorkspaceScreenArchiveController {
  archive: () => void;
  isArchiving: boolean;
  /** False until a worktree's dirty/unpushed state is known, so the risk confirmation can run. */
  canArchive: boolean;
}

interface WorkspaceArchiveRisk {
  isDirty: boolean | null | undefined;
  aheadOfOrigin: number | null | undefined;
}

function resolveWorkspaceArchiveRisk(
  workspace: WorkspaceDescriptor | null,
  gitStatus: CheckoutStatusPayload | null,
): WorkspaceArchiveRisk {
  return {
    isDirty: gitStatus?.isDirty ?? workspace?.gitRuntime?.isDirty,
    aheadOfOrigin: gitStatus?.aheadOfOrigin ?? workspace?.gitRuntime?.aheadOfOrigin,
  };
}

function canArchiveWorkspace(
  workspace: WorkspaceDescriptor | null,
  risk: WorkspaceArchiveRisk,
): boolean {
  return (
    workspace !== null &&
    (workspace.workspaceKind !== "worktree" ||
      (risk.isDirty !== undefined && risk.aheadOfOrigin !== undefined))
  );
}

function getWorktreeArchiveWarningLabels(
  t: (key: string, options?: Record<string, unknown>) => string,
): WorktreeArchiveWarningLabels {
  return {
    title: (workspaceName) => t("workspace.git.actions.archiveWarning.title", { workspaceName }),
    confirm: t("workspace.git.actions.archiveWarning.confirm"),
    cancel: t("workspace.git.actions.archiveWarning.cancel"),
    uncommittedChanges: t("workspace.git.actions.archiveWarning.uncommittedChanges"),
    uncommittedChangesWithDiff: (diffStat) =>
      t("workspace.git.actions.archiveWarning.uncommittedChangesWithDiff", { diffStat }),
    addedLine: (count) =>
      t(
        count === 1
          ? "workspace.git.actions.archiveWarning.addedLine"
          : "workspace.git.actions.archiveWarning.addedLines",
        { count },
      ),
    deletedLine: (count) =>
      t(
        count === 1
          ? "workspace.git.actions.archiveWarning.deletedLine"
          : "workspace.git.actions.archiveWarning.deletedLines",
        { count },
      ),
    unpushedCommit: (count) =>
      t(
        count === 1
          ? "workspace.git.actions.archiveWarning.unpushedCommit"
          : "workspace.git.actions.archiveWarning.unpushedCommits",
        { count },
      ),
  };
}

/**
 * Archive for the workspace a screen is showing: the git actions menu and the workspace header
 * menu both use it, so they confirm, archive, and navigate away the same way the sidebar does.
 */
export function useWorkspaceScreenArchive({
  serverId,
  workspace,
  fallbackName,
  gitStatus,
  activeWorkspaceSelection,
}: UseWorkspaceScreenArchiveInput): WorkspaceScreenArchiveController {
  const { t } = useTranslation();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const archiveRisk = resolveWorkspaceArchiveRisk(workspace, gitStatus);
  const workspaceId = workspace?.id ?? "";
  const warningLabels = useMemo(() => getWorktreeArchiveWarningLabels(t), [t]);

  const redirectAfterArchive = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    redirectIfArchivingActiveWorkspace({ serverId, workspaceId, activeWorkspaceSelection });
  }, [activeWorkspaceSelection, serverId, workspaceId]);

  const controller = useWorkspaceArchive({
    serverId,
    workspaceId,
    workspaceKind: workspace?.workspaceKind ?? "directory",
    name: workspace?.name ?? fallbackName,
    isDirty: archiveRisk.isDirty,
    aheadOfOrigin: archiveRisk.aheadOfOrigin,
    diffStat: workspace?.diffStat ?? null,
    warningLabels,
    onSetHiding: setIsHidingWorkspace,
    onArchiveStarted: redirectAfterArchive,
  });

  return {
    archive: controller.archive,
    isArchiving: workspace?.archivingAt != null || isHidingWorkspace,
    canArchive: canArchiveWorkspace(workspace, archiveRisk),
  };
}
