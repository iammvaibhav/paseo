import { getIsElectron } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";

/**
 * The host's VS Code Web URL when file opens on this client go to VS Code:
 * desktop (Electron) only, and only for a host with a URL configured.
 */
export function useDesktopBrowserEditorUrl(serverId: string | null | undefined): string | null {
  const hosts = useHosts();
  if (!getIsElectron() || !serverId) {
    return null;
  }
  return hosts.find((host) => host.serverId === serverId)?.browserEditorUrl ?? null;
}
