import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { InitiativeDetailScreen } from "@/screens/tickets/initiatives";

export default function TicketInitiativeRoute() {
  const { initiativeId } = useLocalSearchParams<{ initiativeId: string }>();
  return (
    <HostRouteBootstrapBoundary>
      <InitiativeDetailScreen initiativeId={initiativeId} />
    </HostRouteBootstrapBoundary>
  );
}
