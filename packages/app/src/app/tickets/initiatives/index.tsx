import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { InitiativesScreen } from "@/screens/tickets/initiatives";

export default function TicketInitiativesRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <InitiativesScreen />
    </HostRouteBootstrapBoundary>
  );
}
