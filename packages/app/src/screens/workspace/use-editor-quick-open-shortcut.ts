import { getIsElectron } from "@/constants/platform";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { runBrowserEditorCommand } from "@/workspace/open-file-in-browser-editor";

/**
 * Search files (Cmd+P) on a host with VS Code Web: show the VS Code tab and run
 * VS Code's own Quick Open. Without this handler the shortcut falls back to the
 * files command center.
 */
export function useEditorQuickOpenShortcut(input: {
  enabled: boolean;
  serverId: string;
  workspaceId: string;
  /** The host's VS Code Web URL; null disables the handler. Desktop only. */
  browserEditorUrl: string | null;
  workspaceDirectory: string | null;
  persistenceKey: string | null;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
}): void {
  const { browserEditorUrl, workspaceDirectory, persistenceKey } = input;
  const handle = useStableEvent((): boolean => {
    if (!browserEditorUrl || !workspaceDirectory || !persistenceKey) {
      return false;
    }
    return runBrowserEditorCommand({
      browserEditorUrl,
      workspaceDirectory,
      command: "quickOpen",
      workspaceKey: persistenceKey,
      workspaceTabs: input.workspaceTabs,
      openWorkspaceTabFocused: (target) => input.openWorkspaceTabFocused(persistenceKey, target),
      navigateToTabId: input.navigateToTabId,
    });
  });
  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-editor-quick-open",
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    }),
    actions: ["workspace.editor.quick-open"] as const,
    enabled:
      input.enabled &&
      getIsElectron() &&
      Boolean(browserEditorUrl && workspaceDirectory && persistenceKey),
    priority: 100,
    isActive: () => true,
    handle,
  });
}
