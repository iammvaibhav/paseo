import { useQuery } from "@tanstack/react-query";
import { getDesktopHost, type DesktopEditorBridge } from "@/desktop/host";

export type DesktopOpenTargetKind = "editor" | "file-manager";
export type DesktopOpenTargetIcon =
  | { kind: "image"; dataUrl: string }
  | { kind: "symbol"; name: "folder" | "terminal" };

export interface DesktopOpenTarget {
  id: string;
  label: string;
  kind: DesktopOpenTargetKind;
  icon?: DesktopOpenTargetIcon;
  supportsRemote?: boolean;
}

export interface OpenDesktopTargetInput {
  editorId: string;
  workspacePath?: string;
  filePath?: string;
  line?: number;
  column?: number;
  /** Remote-host open: the path lives on the SSH host. */
  path?: string;
  cwd?: string;
  /** SSH destination for opening the path on a remote host via the editor's Remote SSH support. */
  sshHost?: string;
}

interface AvailableDesktopEditorBridge {
  listTargets: NonNullable<DesktopEditorBridge["listTargets"]>;
  openTarget: NonNullable<DesktopEditorBridge["openTarget"]>;
}

interface SelectDesktopOpenTargetsInput {
  canListTargets: boolean;
  targets: DesktopOpenTarget[] | undefined;
}

export function selectDesktopOpenTargets({
  canListTargets,
  targets,
}: SelectDesktopOpenTargetsInput): DesktopOpenTarget[] {
  if (!canListTargets) {
    return [];
  }
  return targets ?? [];
}

function getDesktopEditorBridge(): AvailableDesktopEditorBridge | null {
  const bridge = getDesktopHost()?.editor;
  if (!bridge?.listTargets || !bridge.openTarget) {
    return null;
  }
  return {
    listTargets: bridge.listTargets,
    openTarget: bridge.openTarget,
  };
}

export function hasDesktopOpenTargetsBridge(): boolean {
  return getDesktopEditorBridge() !== null;
}

export async function listDesktopOpenTargets(
  input: { workspacePath?: string } = {},
): Promise<DesktopOpenTarget[]> {
  const bridge = getDesktopEditorBridge();
  if (!bridge) {
    return [];
  }
  return await bridge.listTargets(input);
}

export async function openDesktopTarget(input: OpenDesktopTargetInput): Promise<void> {
  const bridge = getDesktopEditorBridge();
  if (!bridge) {
    throw new Error("Desktop editor bridge is unavailable");
  }
  await bridge.openTarget(input);
}

/**
 * Pass `workspacePath` whenever it is known. Project-specific targets such as
 * Xcode are only listed for workspaces they can actually open, so callers that
 * omit it get the workspace-agnostic targets only.
 */
export function useDesktopOpenTargets(input: {
  isLocalExecution: boolean;
  remoteSshHost?: string | null;
  workspacePath?: string;
}) {
  const hasBridge = hasDesktopOpenTargetsBridge();
  const canListTargets = hasBridge && (input.isLocalExecution || Boolean(input.remoteSshHost));
  const workspacePath = input.workspacePath?.trim() ?? "";
  const query = useQuery({
    queryKey: ["desktop-open-targets", workspacePath],
    enabled: canListTargets,
    staleTime: 60_000,
    retry: false,
    queryFn: () => listDesktopOpenTargets(workspacePath ? { workspacePath } : {}),
  });
  const targets = selectDesktopOpenTargets({
    canListTargets,
    targets: query.data,
  });

  return {
    targets,
    isAvailable: canListTargets,
  };
}
