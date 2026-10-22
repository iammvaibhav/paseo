import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebhookDeliveryLog, type WebhookDeliveryAttempt } from "./webhook-delivery-log.js";

const attempt = (n: number): WebhookDeliveryAttempt => ({
  ts: new Date(Date.UTC(2026, 9, 15, 7, 0, n)).toISOString(),
  client: "grok-bot",
  deliveryId: `d${n}`,
  watchId: `w${n}`,
  event: "paseo.agent.finished",
  reason: "finished",
  agentId: `agent-${n}`,
  groupId: null,
  turnId: null,
  context: null,
  attempt: 1,
  status: 200,
  outcome: "delivered",
  response: "{}",
  durationMs: 1,
});

describe("createWebhookDeliveryLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "webhook-deliveries-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rolls over past its size cap, keeping one roll, and lists both files newest first", async () => {
    const logPath = path.join(dir, "webhook-deliveries.jsonl");
    // Room for two rows per file.
    const maxBytes = (JSON.stringify(attempt(0)).length + 1) * 2 + 4;
    const log = createWebhookDeliveryLog({
      path: logPath,
      logger: pino({ level: "silent" }),
      maxBytes,
    });
    for (let n = 1; n <= 5; n += 1) log.append(attempt(n));

    const { totals, deliveries } = await log.list({ limit: 10 });

    expect((await readdir(dir)).sort()).toEqual([
      "webhook-deliveries.jsonl",
      "webhook-deliveries.jsonl.1",
    ]);
    // Rolls: [1,2] → .1 at row 3; [3,4] → .1 at row 5, dropping 1 and 2.
    expect(deliveries.map((row) => row.agentId)).toEqual(["agent-5", "agent-4", "agent-3"]);
    expect(totals.attempts).toBe(3);
    const since = await log.list({ since: attempt(4).ts, limit: 10 });
    expect(since.deliveries.map((row) => row.agentId)).toEqual(["agent-5", "agent-4"]);
  });
});
