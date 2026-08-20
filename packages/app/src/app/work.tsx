import type { ReactElement } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { isWeb } from "@/constants/platform";
import { WorkScreen } from "@/screens/work-screen";

/**
 * On web the screen renders through the persistent keep-mounted layer
 * (work-persistent.web.tsx) so scroll state survives navigation;
 * the route only exists for the URL. Native renders the screen directly.
 */
function NativeWorkRoute(): ReactElement {
  return (
    <HostRouteBootstrapBoundary>
      <WorkScreen />
    </HostRouteBootstrapBoundary>
  );
}

export default function WorkRoute(): ReactElement | null {
  if (isWeb) {
    return null;
  }
  return <NativeWorkRoute />;
}
