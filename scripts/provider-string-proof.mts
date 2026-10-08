import { DaemonClient } from "../packages/client/src/daemon-client.js";
import { buildHostModelsSection } from "../packages/server/src/server/mission-control/context.js";

const client = new DaemonClient({
  url: "ws://127.0.0.1:6768/ws",
  clientId: "provider-string-proof",
  clientType: "cli",
  password: "vaibhav123",
});
await client.connect();
try {
  const payload = await client.missionControlContextFetch();
  console.log("=== Models block rendered from the live dev daemon (6768) ===");
  console.log(buildHostModelsSection(payload.models, "dev-daemon"));
} finally {
  await client.close();
}
