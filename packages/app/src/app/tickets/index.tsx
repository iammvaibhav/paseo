import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TicketsBoardScreen } from "@/screens/tickets/board-screen";

export default function TicketsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <TicketsBoardScreen />
    </HostRouteBootstrapBoundary>
  );
}
