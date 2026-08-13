// One-shot: patch Mission Control central config on the commander host
// (iammvaibhav) with the hindsight URL. Runs ON iammvaibhav against its local
// daemon from the ~/paseo checkout (built dist). Deleted after use.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { DaemonClient } from "@getpaseo/client";

const config = JSON.parse(readFileSync("/home/ubuntu/.paseo/config.json", "utf8"));
const password = config?.daemon?.auth?.password;
if (!password) {
  console.error("no daemon password in config.json");
  process.exit(1);
}

const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: `set-hindsight-${process.pid}`,
  clientType: "cli",
  appVersion: "0.3.0",
  password,
  connectTimeoutMs: 15_000,
  webSocketFactory: (targetUrl, options) => new WebSocket(targetUrl, { headers: options?.headers }),
  reconnect: { enabled: false },
});

await client.connect();
const before = await client.missionControlConfigGet();
console.log(
  "before:",
  JSON.stringify({
    hindsightUrl: before?.config?.hindsightUrl,
    hindsightBank: before?.config?.hindsightBank,
    hindsightSecondaryBank: before?.config?.hindsightSecondaryBank,
  }),
);
const patched = await client.missionControlConfigPatch({
  hindsightUrl: "http://100.105.100.71:8890",
});
console.log(
  "after:",
  JSON.stringify({
    hindsightUrl: patched?.config?.hindsightUrl,
    hindsightBank: patched?.config?.hindsightBank,
    hindsightSecondaryBank: patched?.config?.hindsightSecondaryBank,
  }),
);
client.disconnect?.();
process.exit(0);
