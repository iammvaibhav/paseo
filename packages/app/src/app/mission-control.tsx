import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { MissionControlScreen } from "@/screens/mission-control-screen";

export default function MissionControlRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <MissionControlScreen />
    </HostRouteBootstrapBoundary>
  );
}
