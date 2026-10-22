import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AutomationsScreen } from "@/screens/automations-screen";

export default function AutomationsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AutomationsScreen />
    </HostRouteBootstrapBoundary>
  );
}
