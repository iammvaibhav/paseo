import { getIsElectron } from "@/constants/platform";
import type { DefaultFileOpener } from "@/hooks/use-settings/storage";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { tryOpenFileInBrowserEditor } from "@/workspace/open-file-in-browser-editor";

interface DefaultFileOpenerToast {
  error?: (message: string) => void;
  show?: (message: string) => void;
}

export interface OpenFileWithDefaultOpenerInput {
  defaultFileOpener: DefaultFileOpener;
  location: WorkspaceFileLocation;
  workspaceDirectory: string | null;
  workspaceKey: string;
  agentId?: string | null;
  remote: boolean;
  browserEditorUrl?: string | null;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
  toast?: DefaultFileOpenerToast;
}

export type OpenFileWithDefaultOpenerResult =
  | { handled: true; via: "vscode-web" }
  | { handled: false; via: "paseo" };

function tryOpenWithVsCodeWeb(
  input: OpenFileWithDefaultOpenerInput,
): OpenFileWithDefaultOpenerResult {
  if (!input.browserEditorUrl?.trim() || !input.workspaceDirectory) {
    return { handled: false, via: "paseo" };
  }
  const opened = tryOpenFileInBrowserEditor({
    browserEditorUrl: input.browserEditorUrl,
    workspaceDirectory: input.workspaceDirectory,
    workspaceKey: input.workspaceKey,
    location: input.location,
    workspaceTabs: input.workspaceTabs,
    openWorkspaceTabFocused: input.openWorkspaceTabFocused,
    navigateToTabId: input.navigateToTabId,
  });
  if (!opened) {
    return { handled: false, via: "paseo" };
  }
  return { handled: true, via: "vscode-web" };
}

export async function tryOpenFileWithDefaultOpener(
  input: OpenFileWithDefaultOpenerInput,
): Promise<OpenFileWithDefaultOpenerResult> {
  if (!getIsElectron()) {
    return { handled: false, via: "paseo" };
  }
  if (input.defaultFileOpener === "vscode-web" || Boolean(input.browserEditorUrl?.trim())) {
    return tryOpenWithVsCodeWeb(input);
  }
  return { handled: false, via: "paseo" };
}
