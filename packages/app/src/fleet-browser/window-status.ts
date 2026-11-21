import type { TFunction } from "i18next";
import type { FleetBrowserWindow } from "@getpaseo/protocol/fleet-browser/types";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export interface FleetBrowserWindowStatus {
  label: string;
  variant: StatusBadgeVariant;
}

/** Who is driving the window, as the badge on its card, detail and overlay shows it. */
export function describeFleetBrowserWindowStatus(
  window: FleetBrowserWindow,
  t: TFunction,
): FleetBrowserWindowStatus {
  if (!window.reachable) {
    return { label: t("panels.fleetBrowser.statusUnreachable"), variant: "error" };
  }
  if (window.control.owner === "user") {
    return { label: t("panels.fleetBrowser.statusUser"), variant: "warning" };
  }
  if (window.handoff) return { label: t("panels.fleetBrowser.statusHandoff"), variant: "warning" };
  return { label: t("panels.fleetBrowser.statusAgent"), variant: "success" };
}

export function fleetBrowserKindLabel(window: FleetBrowserWindow, t: TFunction): string {
  return window.kind === "shared"
    ? t("panels.fleetBrowser.kindShared")
    : t("panels.fleetBrowser.kindFresh");
}
