import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpFinishNotifier, type McpFinishNotifier } from "../mcp-fleet/finish-notifier.js";
import {
  createAgentReminderService,
  type AgentReminderService,
  type AgentReminderServiceOptions,
  type ReminderAgentInfo,
} from "./agent-reminder-service.js";

const AGENT = "agent-1";

const agentInfo: ReminderAgentInfo = {
  title: "Essay writer",
  host: "dev",
  workspaceId: "wks_0123456789abcdef",
  cwd: "/repo",
  status: "idle",
  bucket: "ready",
  lastMessage: "Draft is ready.",
  deepLink: "paseo://h/srv/agent/agent-1",
  webUrl: null,
};

describe("createAgentReminderService", () => {
  let server: Server;
  let url: string;
  let received: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }>;
  /** Requests are held (never answered) while true: a daemon dying mid-POST. */
  let hang: boolean;
  let dir: string;
  let notifier: McpFinishNotifier;
  let services: AgentReminderService[];
  let changes: string[];

  beforeEach(async () => {
    received = [];
    hang = false;
    changes = [];
    services = [];
    dir = await mkdtemp(path.join(tmpdir(), "agent-reminders-"));
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      if (hang) return;
      res.end("{}");
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    notifier = createMcpFinishNotifier({
      resolveSecret: async (value) => value,
      logger: pino({ level: "silent" }),
      retryDelaysMs: [],
      deliveryLogPath: path.join(dir, "webhook-deliveries.jsonl"),
    });
  });

  afterEach(async () => {
    for (const service of services) service.stop();
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const create = (overrides: Partial<AgentReminderServiceOptions> = {}) => {
    const service = createAgentReminderService({
      filePath: path.join(dir, "agent-reminders.json"),
      logger: pino({ level: "silent" }),
      hostsAgent: async (agentId) => agentId === AGENT,
      resolveTarget: (name) => (name === "grok-bot" ? { url } : null),
      describeAgent: async () => agentInfo,
      deliver: (input) => notifier.deliver(input),
      onChange: (agentId) => changes.push(agentId),
      ...overrides,
    });
    services.push(service);
    return service;
  };

  it("fires once when due, posts paseo.agent.reminder, and records the delivery", async () => {
    const service = create();
    await service.start();
    const { reminder } = await service.set({
      agentId: AGENT,
      remindAt: new Date(Date.now() + 150),
      note: " check the PR ",
      createdBy: "app",
    });
    expect(service.getPending(AGENT)).toMatchObject({ id: reminder.id, note: "check the PR" });

    await vi.waitFor(() => expect(service.list().recent).toHaveLength(1), { timeout: 5000 });

    expect(received).toHaveLength(1);
    const body = received[0]!.body;
    expect(body).toMatchObject({
      type: "paseo.agent.reminder",
      reminderId: reminder.id,
      agentId: AGENT,
      late: false,
      note: "check the PR",
      remindAt: reminder.remindAt,
      createdAt: reminder.createdAt,
      createdBy: "app",
      notifyTarget: "grok-bot",
      agent: { id: AGENT, ...agentInfo },
    });
    expect(received[0]!.headers["x-paseo-delivery-id"]).toBe(body.deliveryId);
    expect(service.getPending(AGENT)).toBeNull();
    expect(service.list().recent[0]).toMatchObject({ delivered: true, status: 200 });
    const log = await notifier.listDeliveries({ agentId: AGENT, limit: 10 });
    expect(log.deliveries).toMatchObject([
      { event: "paseo.agent.reminder", outcome: "delivered", deliveryId: body.deliveryId },
    ]);
    // Set → indicator on; fired → indicator off.
    expect(changes).toEqual([AGENT, AGENT]);
  });

  it("fires a reminder that came due while the daemon was down, late, on the next start", async () => {
    const first = create();
    await first.start();
    const { reminder } = await first.set({
      agentId: AGENT,
      remindAt: new Date(Date.now() + 60 * 60_000),
      createdBy: "app",
    });
    first.stop();

    const later = new Date(Date.parse(reminder.remindAt) + 10 * 60_000);
    const restarted = create({ now: () => later });
    await restarted.start();

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    expect(received[0]!.body).toMatchObject({ reminderId: reminder.id, late: true });
  });

  it("resends under the same deliveryId when the daemon died mid-POST, and never fires twice", async () => {
    hang = true;
    const first = create();
    await first.start();
    await first.set({ agentId: AGENT, remindAt: new Date(Date.now() + 100), createdBy: "app" });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    first.stop();
    const stored = JSON.parse(await readFile(path.join(dir, "agent-reminders.json"), "utf8"));
    expect(stored.reminders[0].firing.deliveryId).toBe(received[0]!.body.deliveryId);

    hang = false;
    const restarted = create();
    await restarted.start();
    await vi.waitFor(() => expect(restarted.list().recent).toHaveLength(1), { timeout: 5000 });

    expect(received.map((entry) => entry.body.deliveryId)).toEqual([
      received[0]!.body.deliveryId,
      received[0]!.body.deliveryId,
    ]);
    expect(restarted.list().pending).toEqual([]);
  });

  it("keeps one pending reminder per agent, and cancel removes it", async () => {
    const service = create();
    await service.start();
    const inAnHour = new Date(Date.now() + 60 * 60_000);
    const first = await service.set({ agentId: AGENT, remindAt: inAnHour, createdBy: "app" });
    const second = await service.set({
      agentId: AGENT,
      remindAt: new Date(inAnHour.getTime() + 60_000),
      createdBy: "grok-bot",
    });
    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect(service.list().pending.map((entry) => entry.id)).toEqual([second.reminder.id]);

    expect(await service.cancel(AGENT)).toMatchObject({ id: second.reminder.id });
    expect(service.getPending(AGENT)).toBeNull();
    expect(await service.cancel(AGENT)).toBeNull();
  });

  it("rejects a past time, an unknown notify target, and an agent on another host", async () => {
    const service = create();
    await service.start();
    const inAnHour = new Date(Date.now() + 60 * 60_000);
    await expect(
      service.set({ agentId: AGENT, remindAt: new Date(Date.now() - 1000), createdBy: "app" }),
    ).rejects.toThrow("in the future");
    await expect(
      service.set({ agentId: AGENT, remindAt: inAnHour, createdBy: "app", notifyTarget: "n8n" }),
    ).rejects.toThrow('Notify target "n8n" is not configured');
    await expect(
      service.set({ agentId: "elsewhere", remindAt: inAnHour, createdBy: "app" }),
    ).rejects.toThrow("not on this host");
    expect(service.list().pending).toEqual([]);
  });
});
