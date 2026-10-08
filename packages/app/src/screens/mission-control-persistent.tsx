import type { ReactElement } from "react";

/**
 * Native no-op. On native the /mission-control route renders the screen and
 * the native stack keeps blurred screens alive, so navigation focus and scroll
 * state survive without a separate layer. The web implementation
 * (mission-control-persistent.web.tsx) keeps the screen mounted across route
 * changes because web navigation unmounts route screens.
 */
export function MissionControlPersistent(): ReactElement | null {
  return null;
}
