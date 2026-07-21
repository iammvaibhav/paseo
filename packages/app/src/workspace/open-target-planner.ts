import { type Forge, forgeFromRemoteUrl, getForgePresentation } from "@/git/forge";
import type { DesktopOpenTarget, OpenDesktopTargetInput } from "@/workspace/desktop-open-targets";
import { buildBrowserEditorUrl } from "@/workspace/browser-editor-url";
import {
  type ResolvedWorkspaceFilePaths,
  resolveWorkspaceFilePaths,
  type WorkspaceFileLocation,
} from "@/workspace/file-open";

interface CheckoutStatusForOpenTarget {
  isGit: boolean;
  remoteUrl?: string | null;
  currentBranch?: string | null;
}

export interface PlannedDesktopOpenTarget {
  source: "desktop";
  id: string;
  label: string;
  editorId: string;
  icon: DesktopOpenTarget["icon"];
  openInput: OpenDesktopTargetInput;
}

export interface PlannedForgeOpenTarget {
  source: "forge";
  forge: Forge;
  id: Forge;
  label: string;
  url: string;
}

export interface PlannedBrowserEditorOpenTarget {
  source: "browser-editor";
  id: "vscode-web";
  label: "VS Code Web";
  url: string;
}

export interface PlannedPlannotatorOpenTarget {
  source: "plannotator";
  id: "plannotator";
  label: "Plannotator";
  /** Absolute path to open when the active file is markdown; null opens nothing until a file is selected. */
  path: string | null;
}

export type PlannedWorkspaceOpenTarget =
  | PlannedDesktopOpenTarget
  | PlannedForgeOpenTarget
  | PlannedBrowserEditorOpenTarget
  | PlannedPlannotatorOpenTarget;

export interface PlanWorkspaceOpenTargetsInput {
  workspaceDirectory: string;
  activeFile?: WorkspaceFileLocation | null;
  resolvedActiveFile?: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  isLocalExecution: boolean;
  remoteSshHost?: string | null;
  browserEditorUrl?: string | null;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
  forge?: Forge | null;
  /** When true and a markdown file is active, offer Plannotator. */
  plannotatorAvailable?: boolean;
}

function resolveActiveFileForOpenTargets(
  input: Pick<
    PlanWorkspaceOpenTargetsInput,
    "activeFile" | "resolvedActiveFile" | "workspaceDirectory"
  >,
): ResolvedWorkspaceFilePaths | null {
  if (input.resolvedActiveFile !== undefined) {
    return input.resolvedActiveFile;
  }
  return input.activeFile
    ? resolveWorkspaceFilePaths({
        path: input.activeFile.path,
        workspaceRoot: input.workspaceDirectory,
      })
    : null;
}

function planRemoteDesktopOpenTargets(input: {
  workspaceDirectory: string;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  sshHost: string;
}): PlannedDesktopOpenTarget[] {
  return input.desktopTargets
    .filter((target) => target.kind === "editor" && target.supportsRemote)
    .map((target) => ({
      source: "desktop",
      id: target.id,
      label: target.label,
      editorId: target.id,
      icon: target.icon,
      openInput: input.resolvedFile
        ? {
            editorId: target.id,
            path: input.resolvedFile.absolutePath,
            cwd: input.workspaceDirectory,
            sshHost: input.sshHost,
          }
        : {
            editorId: target.id,
            path: input.workspaceDirectory,
            sshHost: input.sshHost,
          },
    }));
}

function planDesktopOpenTargets(input: {
  workspaceDirectory: string;
  activeFile?: WorkspaceFileLocation | null;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  isLocalExecution: boolean;
  remoteSshHost?: string | null;
}): PlannedDesktopOpenTarget[] {
  if (!input.canUseDesktopBridge) {
    return [];
  }
  if (!input.isLocalExecution) {
    const sshHost = input.remoteSshHost?.trim();
    return sshHost ? planRemoteDesktopOpenTargets({ ...input, sshHost }) : [];
  }

  return input.desktopTargets.map((target) => {
    if (!input.resolvedFile) {
      return {
        source: "desktop",
        id: target.id,
        label: target.label,
        editorId: target.id,
        icon: target.icon,
        openInput: { editorId: target.id, workspacePath: input.workspaceDirectory },
      };
    }
    return {
      source: "desktop",
      id: target.id,
      label: target.label,
      editorId: target.id,
      icon: target.icon,
      openInput: {
        editorId: target.id,
        workspacePath: input.workspaceDirectory,
        filePath: input.resolvedFile.absolutePath,
        ...(input.activeFile?.lineStart ? { line: input.activeFile.lineStart } : {}),
      },
    };
  });
}

function buildForgeWebUrl(
  forge: Forge,
  input: {
    remoteUrl: string | null | undefined;
    branch: string | null | undefined;
    path: string | null;
    lineStart?: number;
    lineEnd?: number;
  },
): string | null {
  const presentation = getForgePresentation(forge);
  if (input.path) {
    return (
      presentation.buildBlobUrl?.({
        remoteUrl: input.remoteUrl,
        branch: input.branch,
        path: input.path,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
      }) ?? null
    );
  }
  return (
    presentation.buildBranchTreeUrl?.({
      remoteUrl: input.remoteUrl,
      branch: input.branch,
    }) ?? null
  );
}

function planForgeOpenTarget(input: {
  activeFile?: WorkspaceFileLocation | null;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
  forge?: Forge | null;
}): PlannedForgeOpenTarget | null {
  if (!input.checkoutStatus?.isGit) {
    return null;
  }
  const forge = input.forge ?? forgeFromRemoteUrl(input.checkoutStatus.remoteUrl) ?? null;
  if (!forge) {
    return null;
  }
  const url = buildForgeWebUrl(forge, {
    remoteUrl: input.checkoutStatus.remoteUrl,
    branch: input.checkoutStatus.currentBranch,
    path: input.resolvedFile?.relativePath ?? null,
    lineStart: input.activeFile?.lineStart,
    lineEnd: input.activeFile?.lineEnd,
  });
  if (!url) {
    return null;
  }
  return {
    source: "forge",
    forge,
    id: forge,
    label: getForgePresentation(forge).brandLabel,
    url,
  };
}

function planBrowserEditorOpenTarget(input: {
  workspaceDirectory: string;
  browserEditorUrl?: string | null;
}): PlannedBrowserEditorOpenTarget | null {
  const url = buildBrowserEditorUrl({
    baseUrl: input.browserEditorUrl ?? "",
    folderPath: input.workspaceDirectory,
  });
  if (!url) {
    return null;
  }
  return {
    source: "browser-editor",
    id: "vscode-web",
    label: "VS Code Web",
    url,
  };
}

function planPlannotatorOpenTarget(input: {
  plannotatorAvailable?: boolean;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  activeFile?: WorkspaceFileLocation | null;
}): PlannedPlannotatorOpenTarget | null {
  if (!input.plannotatorAvailable) {
    return null;
  }
  // Always show the target when the host has Plannotator; path may be null
  // until a markdown file is focused (button can no-op).
  const path = input.resolvedFile?.absolutePath ?? input.activeFile?.path ?? null;
  return {
    source: "plannotator",
    id: "plannotator",
    label: "Plannotator",
    path,
  };
}

export function planWorkspaceOpenTargets(
  input: PlanWorkspaceOpenTargetsInput,
): PlannedWorkspaceOpenTarget[] {
  const resolvedFile = resolveActiveFileForOpenTargets(input);
  const desktopTargets = planDesktopOpenTargets({ ...input, resolvedFile });
  const browserEditorTarget = planBrowserEditorOpenTarget(input);
  const plannotatorTarget = planPlannotatorOpenTarget({
    plannotatorAvailable: input.plannotatorAvailable,
    resolvedFile,
    activeFile: input.activeFile,
  });
  const forgeTarget = planForgeOpenTarget({ ...input, resolvedFile });
  return [
    ...desktopTargets,
    ...(browserEditorTarget ? [browserEditorTarget] : []),
    ...(plannotatorTarget ? [plannotatorTarget] : []),
    ...(forgeTarget ? [forgeTarget] : []),
  ];
}
