import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  FleetBrowserThumbnail,
  FleetBrowserWindow,
} from "@getpaseo/protocol/fleet-browser/types";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// The daemon that owns a workspace's agents keeps their fleet browser windows.
// The list is refetched when the daemon pushes fleet_browser.changed for this
// workspace (window opened or closed, control changed, page changed) and on a
// slow poll as a backstop for a missed push.

const WINDOWS_POLL_MS = 20_000;
const THUMBNAIL_POLL_MS = 6_000;

export function fleetBrowserWindowsQueryKey(serverId: string, workspaceId: string) {
  return ["fleet-browser", "windows", serverId, workspaceId] as const;
}

export interface FleetBrowserWindowsState {
  supported: boolean;
  windows: FleetBrowserWindow[];
  error: string | null;
  loading: boolean;
  /** The host answered: `windows` is the real list, not a placeholder while connecting. */
  settled: boolean;
}
const NO_WINDOWS: FleetBrowserWindow[] = [];

export function useFleetBrowserWindows(input: {
  serverId: string;
  workspaceId: string;
}): FleetBrowserWindowsState {
  const client = useHostRuntimeClient(input.serverId);
  const connected = useHostRuntimeIsConnected(input.serverId);
  const supported = useHostFeature(input.serverId, "fleetBrowser");
  const enabled = Boolean(client && connected && supported && input.workspaceId);
  const query = useFetchQuery({
    queryKey: fleetBrowserWindowsQueryKey(input.serverId, input.workspaceId),
    dataShape: "list",
    staleTimeMs: 5_000,
    enabled,
    refetchInterval: enabled ? WINDOWS_POLL_MS : false,
    queryFn: async () => {
      if (!client) return NO_WINDOWS;
      const response = await client.fleetBrowserRequest("fleet_browser.windows.list.request", {
        workspaceId: input.workspaceId,
      });
      if (response.error) throw new Error(response.error);
      return response.windows;
    },
  });
  return {
    supported,
    windows: query.data ?? NO_WINDOWS,
    error: query.error ? query.error.message : null,
    loading: enabled && query.isPending,
    settled: connected && (supported ? query.isSuccess : true),
  };
}

/** Refetches this workspace's windows whenever the daemon reports a change. */
export function useFleetBrowserChangeFeed(input: { serverId: string; workspaceId: string }): void {
  const client = useHostRuntimeClient(input.serverId);
  const connected = useHostRuntimeIsConnected(input.serverId);
  const supported = useHostFeature(input.serverId, "fleetBrowser");
  const queryClient = useQueryClient();
  const { serverId, workspaceId } = input;
  useEffect(() => {
    if (!client || !connected || !supported || !workspaceId) return;
    const observation = client.observeEvents(["fleet_browser.changed"]);
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "fleet_browser.changed") return;
        if (!message.workspaceIds.includes(workspaceId)) return;
        void queryClient.invalidateQueries({
          queryKey: fleetBrowserWindowsQueryKey(serverId, workspaceId),
        });
      },
    });
    return () => {
      void observation
        .release()
        .catch((error) => console.warn("[FleetBrowser] Failed to release change feed", error));
    };
  }, [client, connected, supported, serverId, workspaceId, queryClient]);
}

/** A small still of one window, refreshed while `active`. */
export function useFleetBrowserThumbnail(input: {
  serverId: string;
  windowId: string;
  active: boolean;
}): FleetBrowserThumbnail | null {
  const client = useHostRuntimeClient(input.serverId);
  const connected = useHostRuntimeIsConnected(input.serverId);
  const enabled = Boolean(client && connected && input.active);
  const query = useFetchQuery({
    queryKey: ["fleet-browser", "thumbnail", input.serverId, input.windowId] as const,
    dataShape: "value",
    staleTimeMs: THUMBNAIL_POLL_MS,
    enabled,
    refetchInterval: enabled ? THUMBNAIL_POLL_MS : false,
    queryFn: async () => {
      if (!client) return null;
      const response = await client.fleetBrowserRequest("fleet_browser.window.thumbnail.request", {
        windowId: input.windowId,
        maxWidth: 360,
      });
      if (response.error) throw new Error(response.error);
      return response.thumbnail;
    },
  });
  return query.data ?? null;
}
