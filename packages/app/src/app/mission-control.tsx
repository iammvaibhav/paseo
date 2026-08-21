import type { ReactElement } from "react";
import { useIsFocused } from "@react-navigation/native";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { isWeb } from "@/constants/platform";
import { MissionControlActiveContext } from "@/screens/mission-control/focus-context";
import { MissionControlScreen } from "@/screens/mission-control-screen";

/**
 * On web the screen renders through the persistent keep-mounted layer
 * (mission-control-persistent.web.tsx) so scroll state survives navigation;
 * the route only exists for the URL. Native renders here, feeding real
 * navigation focus into the shared active context.
 */
function NativeMissionControlRoute(): ReactElement {
  const isFocused = useIsFocused();
  return (
    <MissionControlActiveContext.Provider value={isFocused}>
      <HostRouteBootstrapBoundary>
        <MissionControlScreen />
      </HostRouteBootstrapBoundary>
    </MissionControlActiveContext.Provider>
  );
}

export default function MissionControlRoute(): ReactElement | null {
  if (isWeb) {
    return null;
  }
  return <NativeMissionControlRoute />;
}
