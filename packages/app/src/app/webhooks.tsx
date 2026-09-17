import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { WebhooksScreen } from "@/screens/webhooks-screen";

export default function WebhooksRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <WebhooksScreen />
    </HostRouteBootstrapBoundary>
  );
}
