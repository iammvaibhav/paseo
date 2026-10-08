import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ItsaplanScreen } from "@/screens/itsaplan-screen";

export default function ItsaplanRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ItsaplanScreen />
    </HostRouteBootstrapBoundary>
  );
}
