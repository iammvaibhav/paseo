import { createContext, useContext } from "react";

/**
 * Whether the Mission Control surface is the active (visible) surface.
 *
 * On native the /mission-control route provides real navigation focus. On web
 * the screen lives in a persistent keep-mounted layer OUTSIDE the navigator
 * (routes unmount on web navigation, which would destroy thread scroll state
 * on every visit), so the provider derives activity from the pathname instead.
 * Default true keeps isolated renders (tests) behaving as "visible".
 */
export const MissionControlActiveContext = createContext(true);

export function useMissionControlActive(): boolean {
  return useContext(MissionControlActiveContext);
}
