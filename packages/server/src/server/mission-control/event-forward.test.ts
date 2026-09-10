import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MissionControlCentralConfig,
  MissionControlEvent,
} from "@getpaseo/protocol/mission-control/types";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { PeerManager } from "../peers/peer-manager.js";
import { CentralMissionControlConfigStore } from "./config.js";
import { createMissionControlPresenceSource } from "./presence.js";
import { MissionControlService } from "./service.js";

vi.mock("../agent/tools/paseo-tools.js", () => ({
  dispatchLocalPromptMode: vi.fn(async () => "steer"),
}));

const dispatchLocalPromptModeMock = vi.mocked(dispatchLocalPromptMode);

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

function commanderRecord(agentId: string): StoredAgentRecord {
  return {
    id: agentId,
    labels: { "paseo.mission-control": "commander" },
    archivedAt: null,
    updatedAt: "2026-08-08T00:00:00Z",
    config: { provider: "omp", cwd: "/tmp" },
  } as unknown as StoredAgentRecord;
}

function commanderAgent(agentId: string): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "idle",
    labels: { "paseo.mission-control": "commander" },
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
  } as unknown as ManagedAgent;
}

function workerAgent(agentId: string, labels: Record<string, string> = {}): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "idle",
    labels,
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
  } as unknown as ManagedAgent;
}

function terminalEvent(
  kind: MissionControlEvent["kind"],
  agentId = "worker-1",
): MissionControlEvent {
  return {
    id: `mce_fwd_${kind}`,
    agentId,
    kind,
    source: "system",
    severity: kind === "failed" ? "attention" : "info",
    headline: "Worker outcome",
    ts: "2026-08-09T00:00:00.000Z",
  } as unknown as MissionControlEvent;
}

/**
 * Deterministic async flush: the forward path is fire-and-forget with no
 * timers — its promise chain settles in microtasks, so one macrotask boundary
 * is enough to observe the outcome without wall-clock sleeps.
 */
function flushAsync(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Fleet map with the commander host "commander-a" as an online peer. */
function createPeerHarness(options: { commanderOnline?: boolean } = {}) {
  const commanderOnline = options.commanderOnline ?? true;
  const client = {
    missionControlEventForward: vi.fn(async () => ({ requestId: "req-fwd", ok: true })),
  } as unknown as DaemonClient;
  const peerManager = {
    getPeerStatus: (name: string) =>
      name === "commander-a"
        ? {
            name: "commander-a",
            url: "tcp://commander-a:6767",
            state: commanderOnline ? ("online" as const) : ("unreachable" as const),
            lastSeenAt: commanderOnline ? new Date().toISOString() : "2026-08-08T00:00:00.000Z",
          }
        : null,
    getPeerClient: (name: string) => (commanderOnline && name === "commander-a" ? client : null),
  } as unknown as PeerManager;
  return { client, peerManager };
}

describe("M9 cross-host terminal-event forwarding", () => {
  let dir: string;
  let store: CentralMissionControlConfigStore;
  let service: MissionControlService;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(
    options: {
      hostName?: string;
      hostAlias?: string | null;
      peerManager?: PeerManager | null;
      seedConfig?: MissionControlCentralConfig;
      getAgent?: (agentId: string) => ManagedAgent | null;
      storedAgents?: StoredAgentRecord[];
    } = {},
  ): Promise<void> {
    logger = createMockLogger();
    store = new CentralMissionControlConfigStore({ paseoHome: dir, logger: createMockLogger() });
    await store.initialize();
    if (options.seedConfig && Object.keys(options.seedConfig).length > 0) {
      await store.patch(options.seedConfig);
    }
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent: options.getAgent ?? (() => null),
        listAgents: () => [],
        subscribe: vi.fn((_cb: (event: AgentManagerEvent) => void) => () => {}),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => options.storedAgents ?? []),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: options.hostName ?? "host-b",
      hostAlias: options.hostAlias ?? null,
      peerManager: options.peerManager ?? null,
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      centralConfig: store,
    });
    await service.start();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-event-fwd-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service?.stop();
    // Let the store's tail writes settle before removing the temp home.
    const internals = service as unknown as {
      store: { appendTail: Promise<void>; persistTail: Promise<void> };
    };
    await Promise.all([internals.store.appendTail, internals.store.persistTail]);
    await rm(dir, { recursive: true, force: true });
  });

  test("a labeled terminal event on a NON-commander host forwards the event + labels to the commander host", async () => {
    const { client, peerManager } = createPeerHarness();
    await createService({
      hostName: "host-b",
      hostAlias: "host-b-alias",
      peerManager,
      seedConfig: { commanderHost: "commander-a" },
      getAgent: (agentId) =>
        agentId === "worker-1"
          ? workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" })
          : null,
    });
    service.publishEvent(terminalEvent("finished"));
    await vi.waitFor(() => expect(client.missionControlEventForward).toHaveBeenCalledTimes(1));
    const [input] = vi.mocked(client.missionControlEventForward).mock.calls[0];
    expect(input).toMatchObject({
      event: { agentId: "worker-1", kind: "finished" },
      labels: { "paseo.parent-agent-id": "commander-1" },
    });
    // No LOCAL machinery turn: this host has no commander agent to dispatch to.
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("verdict events on a labeled worker forward too", async () => {
    const { client, peerManager } = createPeerHarness();
    await createService({
      peerManager,
      seedConfig: { commanderHost: "commander-a" },
      getAgent: () =>
        workerAgent("worker-1", { "paseo.commander-adopted-at": "2026-08-08T00:00:00.000Z" }),
    });
    service.publishEvent(terminalEvent("verdict"));
    await vi.waitFor(() => expect(client.missionControlEventForward).toHaveBeenCalledTimes(1));
    const [input] = vi.mocked(client.missionControlEventForward).mock.calls[0];
    expect(input.event.kind).toBe("verdict");
    expect(input.labels).toMatchObject({
      "paseo.commander-adopted-at": "2026-08-08T00:00:00.000Z",
    });
  });

  test("non-labeled terminal events never forward", async () => {
    const { client, peerManager } = createPeerHarness();
    await createService({
      peerManager,
      seedConfig: { commanderHost: "commander-a" },
      getAgent: () => workerAgent("worker-1", {}),
    });
    service.publishEvent(terminalEvent("finished"));
    service.publishEvent(terminalEvent("failed"));
    await flushAsync();
    expect(client.missionControlEventForward).not.toHaveBeenCalled();
  });

  test("non-terminal events never forward, even when the worker is labeled", async () => {
    const { client, peerManager } = createPeerHarness();
    await createService({
      peerManager,
      seedConfig: { commanderHost: "commander-a" },
      getAgent: () => workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    service.publishEvent(terminalEvent("started"));
    service.publishEvent(terminalEvent("blocked"));
    await flushAsync();
    expect(client.missionControlEventForward).not.toHaveBeenCalled();
  });

  test("the commander host itself never forwards (the local gate handles its own workers)", async () => {
    const { client, peerManager } = createPeerHarness();
    await createService({
      hostName: "host-a",
      peerManager,
      seedConfig: { commanderHost: "host-a" },
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) =>
        agentId === "commander-1"
          ? commanderAgent("commander-1")
          : workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    service.publishEvent(terminalEvent("finished"));
    await flushAsync();
    expect(client.missionControlEventForward).not.toHaveBeenCalled();
    // Terminal events never wake the Commander (spec 07) — the local gate
    // keeps the feed card board/feed-rail only.
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });

  test("an unreachable commander host is a warn + drop, never a throw", async () => {
    const { client, peerManager } = createPeerHarness({ commanderOnline: false });
    await createService({
      peerManager,
      seedConfig: { commanderHost: "commander-a" },
      getAgent: () => workerAgent("worker-1", { "paseo.parent-agent-id": "commander-1" }),
    });
    expect(() => service.publishEvent(terminalEvent("finished"))).not.toThrow();
    await flushAsync();
    expect(client.missionControlEventForward).not.toHaveBeenCalled();
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ commanderHost: "commander-a" }),
      "mission_control.event_forward.commander_unreachable",
    );
  });

  test("the commander host ingests a forwarded verdict and dispatches the machinery turn with the payload labels", async () => {
    const { peerManager } = createPeerHarness();
    await createService({
      hostName: "host-a",
      peerManager,
      seedConfig: { commanderHost: "host-a" },
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) => (agentId === "commander-1" ? commanderAgent("commander-1") : null),
    });
    // A peer-host worker the commander host has NO local record of: the labels
    // ride the payload and must carry the gate (parent check resolves — the
    // parent IS the local commander agent). Verdicts still route for
    // dispatched agents (spec 07); terminal events no longer do.
    const result = await service.ingestForwardedEvent({
      event: terminalEvent("verdict"),
      labels: { "paseo.parent-agent-id": "commander-1" },
    });
    expect(result).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(dispatchLocalPromptModeMock).toHaveBeenCalledTimes(1));
    const call = dispatchLocalPromptModeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "commander-1",
      mode: "steer",
      classification: "machinery",
    });
    expect(call?.prompt).toContain("follow-up on a worker you dispatched");
    // NEVER written to the receiving host's events store (no double-record).
    const events = service.fetchEvents();
    expect(events.filter((event) => event.agentId === "worker-1")).toHaveLength(0);
  });

  test("ingesting a forwarded event without dispatch markers dispatches nothing", async () => {
    const { peerManager } = createPeerHarness();
    await createService({
      hostName: "host-a",
      peerManager,
      seedConfig: { commanderHost: "host-a" },
      storedAgents: [commanderRecord("commander-1")],
      getAgent: (agentId) => (agentId === "commander-1" ? commanderAgent("commander-1") : null),
    });
    await service.ingestForwardedEvent({
      event: terminalEvent("finished"),
      labels: {},
    });
    await flushAsync();
    expect(dispatchLocalPromptModeMock).not.toHaveBeenCalled();
  });
});
