import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { PeerManager } from "../../peers/peer-manager.js";
import {
  createAgentReminderService,
  type AgentReminderService,
} from "../../reminders/agent-reminder-service.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const LOCAL_AGENT_ID = "5f3c0f4e-9b2a-4d6c-8e7a-1b2c3d4e5f6a";
const PEER_AGENT_ID = "7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d";

describe("fleet reminder tools", () => {
  let dir: string;
  let reminders: AgentReminderService;
  let missionControlToolsExecute: Mock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fleet-reminders-"));
    reminders = createAgentReminderService({
      filePath: path.join(dir, "agent-reminders.json"),
      logger: pino({ level: "silent" }),
      hostsAgent: async (agentId) => agentId === LOCAL_AGENT_ID,
      resolveTarget: (name) => (name === "grok-bot" ? { url: "http://127.0.0.1:9/hook" } : null),
      describeAgent: async () => {
        throw new Error("not fired in these tests");
      },
      deliver: async () => ({ delivered: true, status: 200, attempts: 1, error: null }),
      onChange: () => {},
    });
    await reminders.start();
    missionControlToolsExecute = vi.fn(async () => ({
      ok: true,
      structuredContent: { ok: true, replaced: false },
    }));
  });

  afterEach(async () => {
    reminders.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const catalog = () => {
    const peerClient = { missionControlToolsExecute } as unknown as DaemonClient;
    const peerManager = {
      getPeerStatus: (name: string) =>
        name === "macbook" ? { name, state: "online", lastSeenAt: null } : null,
      getPeerStatuses: () => [{ name: "macbook", state: "online", lastSeenAt: null }],
      getPeerClient: (name: string) => (name === "macbook" ? peerClient : null),
    } as unknown as PeerManager;
    const agentManager = {
      getAgent: (id: string) =>
        id === LOCAL_AGENT_ID ? { id, cwd: "/work", lifecycle: "idle" as const } : null,
      listAgents: () => [{ id: LOCAL_AGENT_ID, name: "worker" }],
    } as unknown as AgentManager;
    return createPaseoToolCatalog({
      agentManager,
      agentStorage: {
        get: async (id: string) => (id === LOCAL_AGENT_ID ? { id, title: "Worker" } : null),
        list: async () => [],
      } as unknown as AgentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub()
        .manager as unknown as ProviderSnapshotManager,
      peerManager,
      agentReminders: reminders,
      logger: createTestLogger(),
    });
  };

  test("reads a naive remindAt in the given time zone and records the calling client", async () => {
    // Two days out, 09:00 in Kolkata (UTC+05:30).
    const day = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const result = await catalog().executeTool(
      "fleet_remind_agent",
      {
        agentId: LOCAL_AGENT_ID,
        remindAt: `${day}T09:00`,
        timeZone: "Asia/Calcutta",
        note: "ship it",
      },
      { callerClient: "grok-bot" },
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      host: "local",
      agentId: LOCAL_AGENT_ID,
      replaced: false,
      reminder: {
        remindAt: `${day}T03:30:00.000Z`,
        note: "ship it",
        createdBy: "grok-bot",
        notifyTarget: "grok-bot",
      },
    });
    const listed = await catalog().executeTool("fleet_list_reminders", { host: "local" });
    expect(listed.structuredContent).toMatchObject({
      reminders: [{ agentId: LOCAL_AGENT_ID, title: "Worker", host: "local" }],
    });

    const cancelled = await catalog().executeTool("fleet_cancel_reminder", {
      agentId: LOCAL_AGENT_ID,
    });
    expect(cancelled.structuredContent).toMatchObject({ ok: true, cancelled: true });
    expect(reminders.getPending(LOCAL_AGENT_ID)).toBeNull();
  });

  test("routes a peer agent's reminder to its host with an absolute time", async () => {
    const before = Date.now();
    const result = await catalog().executeTool(
      "fleet_remind_agent",
      { agentId: PEER_AGENT_ID, host: "macbook", inMinutes: 2 },
      { callerClient: "grok-bot" },
    );

    expect(result.structuredContent).toMatchObject({ ok: true, host: "macbook" });
    const call = missionControlToolsExecute.mock.calls[0]![0] as {
      name: string;
      args: { remindAt: string; host: string; createdBy: string };
    };
    expect(call).toMatchObject({
      name: "fleet_remind_agent",
      args: { agentId: PEER_AGENT_ID, host: "local", createdBy: "grok-bot" },
    });
    const forwardedMs = Date.parse(call.args.remindAt);
    expect(forwardedMs - before).toBeGreaterThanOrEqual(2 * 60_000);
    expect(forwardedMs - before).toBeLessThan(2 * 60_000 + 5_000);
  });

  test("rejects a call that names more than one time", async () => {
    const result = await catalog().executeTool("fleet_remind_agent", {
      agentId: LOCAL_AGENT_ID,
      preset: "in_1h",
      inMinutes: 5,
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: "Give exactly one of preset, inMinutes, remindAt",
    });
    expect(reminders.list().pending).toEqual([]);
  });
});
