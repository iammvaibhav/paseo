import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

export const MISSION_CONTROL_VERBOSE_STORAGE_KEY = "@paseo:mission-control-verbose";

/**
 * The ONE verbose/debug preference for Mission Control machinery. Shared by
 * the Mission Control screen (its overflow-menu toggle), the agent chat
 * (machinery prompt placeholders render only in verbose mode), and every
 * app-global visibility gate (sidebar, History, project lists, board,
 * badges) so there is a single per-device flag, never a second toggle.
 *
 * Lives in a module-level zustand store (not component state) so surfaces
 * OUTSIDE the Mission Control screen can read the flag and re-render the
 * moment it flips. Hydration reads AsyncStorage once per process (first hook
 * call); a toggle before hydration resolves wins — the stale read never
 * clobbers it. Default OFF; writes back on change only.
 */

interface MissionControlVerboseState {
  verbose: boolean;
  /** True once the persisted value has been read (or the read failed). */
  hydrated: boolean;
  hydrate: (value: string | null) => void;
  toggleVerbose: () => void;
}

const useMissionControlVerboseStore = create<MissionControlVerboseState>((set, get) => ({
  verbose: false,
  hydrated: false,
  hydrate: (value) => {
    if (get().hydrated) {
      return;
    }
    set({ verbose: value === "1", hydrated: true });
  },
  toggleVerbose: () => {
    const next = !get().verbose;
    set({ verbose: next, hydrated: true });
    void AsyncStorage.setItem(MISSION_CONTROL_VERBOSE_STORAGE_KEY, next ? "1" : "0").catch(
      () => undefined,
    );
  },
}));

let hydrationStarted = false;

/** Kick the one-per-process AsyncStorage read; idempotent, never setState-sync. */
function ensureVerboseHydrated(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  void AsyncStorage.getItem(MISSION_CONTROL_VERBOSE_STORAGE_KEY)
    .then((value) => {
      useMissionControlVerboseStore.getState().hydrate(value);
      return null;
    })
    .catch((error: unknown) => {
      useMissionControlVerboseStore.getState().hydrate(null);
      console.warn("Failed to load verbose preference", error);
    });
}

export function useMissionControlVerbose(): [boolean, () => void] {
  ensureVerboseHydrated();
  const verbose = useMissionControlVerboseStore((state) => state.verbose);
  const toggleVerbose = useCallback(
    () => useMissionControlVerboseStore.getState().toggleVerbose(),
    [],
  );
  return [verbose, toggleVerbose];
}
