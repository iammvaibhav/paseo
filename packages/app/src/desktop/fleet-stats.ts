import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";

/**
 * Electron wraps a rejected `ipcMain.handle` as
 * `Error invoking remote method 'paseo:invoke': Error: <cause>`. The cause is
 * the script's own diagnostic (`omp not on PATH`, `blrofc3: fetch failed`) and
 * is the only actionable half.
 */
function unwrapInvokeError(error: unknown): string | null {
  if (!(error instanceof Error) || !error.message) {
    return null;
  }
  const match = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?(.*)$/s.exec(
    error.message,
  );
  return (match?.[1] ?? error.message).trim() || null;
}

/**
 * Electron main runs scripts/omp-stats-fleet.sh — parallel ssh snapshots, a
 * sqlite merge, then the stock `omp stats` dashboard in its own desktop window.
 * Tens of seconds is normal, so the caller renders a spinner until it settles.
 */
export function useOpenFleetStats(): { open: () => void; isOpening: boolean } {
  const { t } = useTranslation();
  const toast = useToast();
  const [isOpening, setIsOpening] = useState(false);

  const open = useCallback(() => {
    if (!getIsElectron() || isOpening) {
      return;
    }
    setIsOpening(true);
    toast.show(t("sidebar.fleetStats.collecting"));
    invokeDesktopCommand("omp_stats_fleet_open")
      .catch((error: unknown) => {
        toast.error(unwrapInvokeError(error) ?? t("sidebar.fleetStats.failed"));
      })
      .finally(() => {
        setIsOpening(false);
      });
  }, [isOpening, t, toast]);

  return { open, isOpening };
}
