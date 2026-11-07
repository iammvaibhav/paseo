import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

async function getAvailablePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    server.close(() => resolve(address.port));
  });
  return promise;
}

describe("agent reminders (daemon E2E)", () => {
  test("the app sets a reminder, the agent payload carries it, and the host POSTs paseo.agent.reminder when due", async () => {
    const received: Array<Record<string, unknown>> = [];
    const receiver: Server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push(JSON.parse(raw));
      res.end("{}");
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
    const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-reminders-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-reminders-"));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "paseo-work-reminders-"));
    const port = await getAvailablePort();
    const token = "grok-secret-token-reminders";
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: {
          mcp: {
            enabled: true,
            remoteClients: [{ name: "grok-bot", tokenHash: hashDaemonPassword(token) }],
            notifyTargets: [{ name: "grok-bot", url: hookUrl }],
          },
        },
      }),
      "utf8",
    );
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();
    const mcp = new Client({ name: "e2e-client", version: "1.0.0" });
    const app = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, appVersion: "0.9.0" });
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/fleet`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const created = await mcp.callTool({
        name: "fleet_create_agent",
        arguments: {
          host: "local",
          cwd: workDir,
          isolation: "local",
          provider: "codex/gpt-5.4-mini",
          title: "reminder subject",
          initialPrompt: "Respond with exactly: draft ready",
        },
      });
      const agentId = created.structuredContent?.agentId as string;
      await mcp.callTool({ name: "fleet_wait_agent", arguments: { agentId, timeoutSeconds: 30 } });

      await app.connect();
      expect(app.getLastServerInfoMessage()?.features?.agentReminders).toBe(true);
      const reminder = await app.setAgentReminder({
        agentId,
        remindAt: new Date(Date.now() + 1500).toISOString(),
        note: "review the draft",
      });
      expect((await app.fetchAgent(agentId))?.agent.reminder).toMatchObject({
        id: reminder.id,
        note: "review the draft",
        createdBy: "app",
        notifyTarget: "grok-bot",
      });
      const listed = await mcp.callTool({ name: "fleet_list_reminders", arguments: {} });
      expect(listed.structuredContent).toMatchObject({
        reminders: [{ id: reminder.id, agentId, title: "reminder subject" }],
      });

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 15_000 });
      expect(received[0]).toMatchObject({
        type: "paseo.agent.reminder",
        reminderId: reminder.id,
        agentId,
        late: false,
        note: "review the draft",
        agent: {
          id: agentId,
          title: "reminder subject",
          cwd: workDir,
          lastMessage: "draft ready",
          deepLink: expect.stringMatching(new RegExp(`^paseo://h/.+/agent/${agentId}$`)),
        },
      });
      expect((await app.fetchAgent(agentId))?.agent.reminder ?? null).toBeNull();
      const deliveries = await mcp.callTool({
        name: "fleet_webhook_deliveries",
        arguments: { agentId },
      });
      expect(JSON.stringify(deliveries.structuredContent)).toContain("paseo.agent.reminder");
    } finally {
      await app.close().catch(() => undefined);
      await mcp.close();
      await daemon.stop();
      receiver.close();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);
});
