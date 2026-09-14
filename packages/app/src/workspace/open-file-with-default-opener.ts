import { getIsElectron } from "@/constants/platform";
import type { DefaultFileOpener } from "@/hooks/use-settings/storage";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { tryOpenFileInBrowserEditor } from "@/workspace/open-file-in-browser-editor";
import {
  isPlannotatorAnnotatableFile,
  tryOpenFileInPlannotator,
  type PlannotatorSessionClient,
} from "@/workspace/open-file-in-plannotator";

interface DefaultFileOpenerToast {
  error?: (message: string) => void;
  show?: (message: string) => void;
}

export interface OpenFileWithDefaultOpenerInput {
  defaultFileOpener: DefaultFileOpener;
  location: WorkspaceFileLocation;
  client: PlannotatorSessionClient | null;
  workspaceDirectory: string | null;
  workspaceKey: string;
  agentId?: string | null;
  remote: boolean;
  embedHost?: string | null;
  plannotatorAvailable: boolean;
  browserEditorUrl?: string | null;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
  toast?: DefaultFileOpenerToast;
}

export type OpenFileWithDefaultOpenerResult =
  | { handled: true; via: "vscode-web" | "plannotator" | "error" }
  | { handled: false; via: "paseo" };

function showError(input: OpenFileWithDefaultOpenerInput, message: string): void {
  input.toast?.error?.(message);
}

function tryOpenWithVsCodeWeb(
  input: OpenFileWithDefaultOpenerInput,
): OpenFileWithDefaultOpenerResult {
  if (!input.browserEditorUrl?.trim()) {
    showError(input, "VS Code Web is not configured for this host");
    return { handled: true, via: "error" };
  }
  if (!input.workspaceDirectory) {
    showError(input, "No workspace directory");
    return { handled: true, via: "error" };
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
    showError(input, "Could not open the file in VS Code Web");
    return { handled: true, via: "error" };
  }
  return { handled: true, via: "vscode-web" };
}

async function tryOpenWithPlannotator(
  input: OpenFileWithDefaultOpenerInput,
): Promise<OpenFileWithDefaultOpenerResult> {
  if (!isPlannotatorAnnotatableFile(input.location.path)) {
    input.toast?.show?.("Plannotator does not support this file type; opened in Paseo");
    return { handled: false, via: "paseo" };
  }
  if (!input.plannotatorAvailable) {
    showError(input, "Plannotator is not available on this host");
    return { handled: true, via: "error" };
  }
  if (!input.client) {
    showError(input, "Not connected to the host");
    return { handled: true, via: "error" };
  }
  if (!input.workspaceDirectory) {
    showError(input, "No workspace directory");
    return { handled: true, via: "error" };
  }
  if (input.remote && !input.embedHost?.trim()) {
    showError(input, "Cannot reach remote Plannotator from this desktop");
    return { handled: true, via: "error" };
  }

  const result = await tryOpenFileInPlannotator({
    client: input.client,
    workspaceDirectory: input.workspaceDirectory,
    workspaceKey: input.workspaceKey,
    location: input.location,
    agentId: input.agentId,
    remote: input.remote,
    embedHost: input.embedHost,
    workspaceTabs: input.workspaceTabs,
    openWorkspaceTabFocused: input.openWorkspaceTabFocused,
    navigateToTabId: input.navigateToTabId,
  });
  if (!result.ok) {
    showError(input, result.message || "Could not open Plannotator");
    return { handled: true, via: "error" };
  }
  return { handled: true, via: "plannotator" };
}

export async function tryOpenFileWithDefaultOpener(
  input: OpenFileWithDefaultOpenerInput,
): Promise<OpenFileWithDefaultOpenerResult> {
  if (input.defaultFileOpener === "paseo" || !getIsElectron()) {
    return { handled: false, via: "paseo" };
  }
  if (input.defaultFileOpener === "vscode-web") {
    return tryOpenWithVsCodeWeb(input);
  }
  return tryOpenWithPlannotator(input);
}
