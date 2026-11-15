import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  FleetBrowserControlAction,
  FleetBrowserDelivery,
  FleetBrowserWindow,
} from "@getpaseo/protocol/fleet-browser/types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { fleetBrowserWindowsQueryKey } from "./use-fleet-browser-windows";

export interface FleetBrowserControlResult {
  window: FleetBrowserWindow | null;
  /** How the change reached the agent: steered into its turn, a new turn, or not at all. */
  delivery: FleetBrowserDelivery;
}

export interface FleetBrowserActions {
  /** Raises the window to the top of its host's live view. */
  show(windowId: string): Promise<void>;
  control(
    windowId: string,
    action: FleetBrowserControlAction,
    note?: string,
  ): Promise<FleetBrowserControlResult>;
  close(windowId: string): Promise<void>;
}

export function useFleetBrowserActions(input: {
  serverId: string;
  workspaceId: string;
}): FleetBrowserActions {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const queryClient = useQueryClient();
  const { serverId, workspaceId } = input;
  const refetch = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: fleetBrowserWindowsQueryKey(serverId, workspaceId),
      }),
    [queryClient, serverId, workspaceId],
  );
  const requireClient = useCallback(() => {
    if (!client) throw new Error(t("panels.fleetBrowser.hostDisconnected"));
    return client;
  }, [client, t]);

  const show = useCallback(
    async (windowId: string) => {
      const response = await requireClient().fleetBrowserRequest(
        "fleet_browser.window.show.request",
        { windowId },
      );
      if (response.error) throw new Error(response.error);
    },
    [requireClient],
  );

  const control = useCallback(
    async (windowId: string, action: FleetBrowserControlAction, note?: string) => {
      const response = await requireClient().fleetBrowserRequest(
        "fleet_browser.window.control.request",
        { windowId, action, ...(note?.trim() ? { note: note.trim() } : {}) },
      );
      if (response.error) throw new Error(response.error);
      await refetch();
      return { window: response.window, delivery: response.delivery };
    },
    [requireClient, refetch],
  );

  const close = useCallback(
    async (windowId: string) => {
      const response = await requireClient().fleetBrowserRequest(
        "fleet_browser.window.close.request",
        { windowId },
      );
      if (response.error) throw new Error(response.error);
      await refetch();
    },
    [requireClient, refetch],
  );

  return useMemo(() => ({ show, control, close }), [show, control, close]);
}
