import { getIsElectron } from "@/constants/platform";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import {
  tryOpenFileInPlannotator,
  type PlannotatorSessionClient,
} from "@/workspace/open-file-in-plannotator";

export interface OpenMarkdownFileInput {
  location: WorkspaceFileLocation;
  client: PlannotatorSessionClient | null;
  workspaceDirectory: string | null;
  workspaceKey: string | null;
  agentId?: string | null;
  remote: boolean;
  embedHost?: string | null;
  openMarkdownInPlannotator: boolean;
  plannotatorAvailable: boolean;
  workspaceTabs: ReadonlyArray<{ tabId: string; target: WorkspaceTabTarget }>;
  openWorkspaceTabFocused: (target: WorkspaceTabTarget) => string | null;
  navigateToTabId: (tabId: string) => void;
  toast?: {
    error?: (message: string) => void;
    show?: (message: string) => void;
  };
}

export type OpenMarkdownFileResult =
  | { handled: true; via: "plannotator" }
  | { handled: false; reason: string };

function gateMarkdownPlannotator(
  input: OpenMarkdownFileInput,
): { ok: true } | { ok: false; reason: string; message?: string } {
  if (!input.openMarkdownInPlannotator) {
    return { ok: false, reason: "setting_off" };
  }
  if (!isRenderedMarkdownFile(input.location.path)) {
    return { ok: false, reason: "not_markdown" };
  }
  if (!getIsElectron()) {
    return {
      ok: false,
      reason: "not_electron",
      message: "Plannotator is only available in the desktop app",
    };
  }
  if (!input.plannotatorAvailable) {
    return {
      ok: false,
      reason: "not_available",
      message: "Plannotator is not available on this host (is the binary installed?)",
    };
  }
  if (!input.client) {
    return { ok: false, reason: "no_client", message: "Not connected to the host" };
  }
  if (!input.workspaceDirectory || !input.workspaceKey) {
    return { ok: false, reason: "no_workspace", message: "No workspace directory" };
  }
  if (input.remote && !input.embedHost?.trim()) {
    return {
      ok: false,
      reason: "no_embed_host",
      message: "Cannot reach remote Plannotator (set VS Code Web URL or SSH host on this host)",
    };
  }
  return { ok: true };
}

/**
 * When "Open Markdown in Plannotator" is enabled, open md files exclusively in
 * Plannotator. Does not fall through to VS Code Web or the native file pane —
 * those confuse the user when the setting is on.
 */
export async function tryOpenMarkdownInPlannotatorIfEnabled(
  input: OpenMarkdownFileInput,
): Promise<OpenMarkdownFileResult> {
  const gate = gateMarkdownPlannotator(input);
  if (!gate.ok) {
    if (gate.message) {
      input.toast?.error?.(gate.message);
    }
    return { handled: false, reason: gate.reason };
  }

  // gate ok implies these are non-null
  const client = input.client!;
  const workspaceDirectory = input.workspaceDirectory!;
  const workspaceKey = input.workspaceKey!;

  const result = await tryOpenFileInPlannotator({
    client,
    workspaceDirectory,
    workspaceKey,
    location: input.location,
    agentId: input.agentId,
    remote: input.remote,
    embedHost: input.embedHost,
    workspaceTabs: input.workspaceTabs,
    openWorkspaceTabFocused: input.openWorkspaceTabFocused,
    navigateToTabId: input.navigateToTabId,
  });

  if (!result.ok) {
    input.toast?.error?.(result.message || "Could not open Plannotator");
    return { handled: false, reason: result.reason };
  }

  return { handled: true, via: "plannotator" };
}
