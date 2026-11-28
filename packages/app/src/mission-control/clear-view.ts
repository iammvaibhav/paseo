import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const CLEAR_VIEW_STORAGE_KEY = "@paseo:mission-control-clear-view";

/**
 * "Clear view" (spec): a per-device clear point. The thread renders events
 * and messages from that moment on; older cards stay in the store behind a
 * "show earlier" affordance. Does not touch the Commander — resetting the
 * Commander is the separate RPC.
 */
export async function loadClearViewPoint(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(CLEAR_VIEW_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveClearViewPoint(pointTs: number | null): Promise<void> {
  try {
    if (pointTs === null) {
      await AsyncStorage.removeItem(CLEAR_VIEW_STORAGE_KEY);
      return;
    }
    await AsyncStorage.setItem(CLEAR_VIEW_STORAGE_KEY, String(pointTs));
  } catch {
    // Best-effort per-device preference; a failed write just leaves the
    // previous clear point (or none) in place.
  }
}

/**
 * Per-device clear point with async hydration, mirroring the verbose-toggle
 * pattern in the Mission Control screen. `setClearViewPoint(null)` lifts the
 * clear point (shows the full thread again).
 */
export function useClearViewPoint(): {
  clearPointTs: number | null;
  isHydrated: boolean;
  setClearViewPoint: (pointTs: number | null) => void;
} {
  const [clearPointTs, setClearPointTs] = useState<number | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadClearViewPoint()
      .then((pointTs) => {
        if (cancelled) {
          return pointTs;
        }
        setClearPointTs(pointTs);
        setIsHydrated(true);
        return pointTs;
      })
      .catch(() => {
        if (!cancelled) {
          setIsHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setClearViewPoint = useCallback((pointTs: number | null) => {
    setClearPointTs(pointTs);
    void saveClearViewPoint(pointTs);
  }, []);

  return { clearPointTs, isHydrated, setClearViewPoint };
}

export const __private__ = { CLEAR_VIEW_STORAGE_KEY };
