import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const MISSION_CONTROL_VERBOSE_STORAGE_KEY = "@paseo:mission-control-verbose";

/**
 * The ONE verbose/debug preference for Mission Control machinery. Shared by
 * the Mission Control screen (its overflow-menu toggle) and the agent chat
 * (machinery prompt placeholders render only in verbose mode) so there is a
 * single per-device flag, never a second toggle.
 *
 * Default OFF. Hydrates from AsyncStorage on mount; writes back on change
 * (the initial hydration read never writes the value straight back).
 */
export function useMissionControlVerbose(): [boolean, () => void] {
  const [verbose, setVerbose] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(MISSION_CONTROL_VERBOSE_STORAGE_KEY)
      .then((value) => {
        if (!cancelled) {
          setVerbose(value === "1");
        }
        return value;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn("Failed to load verbose preference", error);
        }
        return null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    void AsyncStorage.setItem(MISSION_CONTROL_VERBOSE_STORAGE_KEY, verbose ? "1" : "0").catch(
      () => undefined,
    );
  }, [verbose]);

  const toggleVerbose = useCallback(() => {
    setVerbose((current) => !current);
  }, []);

  return [verbose, toggleVerbose];
}
