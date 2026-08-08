import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { dispatchLocalPromptMode } from "../agent/tools/paseo-tools.js";
import { MissionControlService } from "./service.js";
import { CommanderAckDrop } from "./commander-ack-drop.js";
import { createMissionControlPresenceSource } from "./presence.js";

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

describe("MissionControlService reset + approvals ack-drop arming", () => {
  let dir: string;
  let service: MissionControlService;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(
    options: {
      resetCommander?: () => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
      digestAckDrop?: CommanderAckDrop;
      getAgent?: () => ManagedAgent | null;
    } = {},
  ): Promise<void> {
    logger = createMockLogger();
    const subscribers: Array<(event: AgentManagerEvent) => void> = [];
    const ackDrop =
      options.digestAckDrop ??
      new CommanderAckDrop({
        agentManager: {
          subscribe: vi.fn(() => () => undefined),
          removeTimelineRows: vi.fn(async () => undefined),
        } as unknown as AgentManager,
        logger,
      });
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent: options.getAgent ?? (() => null),
        subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
          subscribers.push(cb);
          return () => {};
        }),
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast: vi.fn(),
      digest: { enqueue: vi.fn(), ackDrop },
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      resetCommander: options.resetCommander,
    });
    await service.start();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-reset-"));
  });

  afterEach(async () => {
    await service.stop();
    const internals = service as unknown as {
      store: { appendTail: Promise<void>; persistTail: Promise<void> };
    };
    await Promise.all([internals.store.appendTail, internals.store.persistTail]);
    await rm(dir, { recursive: true, force: true });
  });

  test("resetCommander delegates to the injected machinery and returns its result", async () => {
    const resetCommander = vi.fn(async () => ({ ok: true as const, agentId: "commander-new" }));
    await createService({ resetCommander });
    const result = await service.resetCommander();
    expect(resetCommander).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, agentId: "commander-new" });
  });

  test("resetCommander reports an error when the host has no reset machinery", async () => {
    await createService();
    const result = await service.resetCommander();
    expect(result).toEqual({ ok: false, error: "Commander reset is not available on this host" });
  });

  test("an approved proposal targeting the Commander arms ack retraction for its delivery", async () => {
    const subscribers: Array<(event: AgentManagerEvent) => void> = [];
    const removeTimelineRows = vi.fn(async () => undefined);
    const ackDrop = new CommanderAckDrop({
      agentManager: {
        subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
          subscribers.push(cb);
          return () => undefined;
        }),
        removeTimelineRows,
      } as unknown as AgentManager,
      logger,
    });
    ackDrop.attach("commander-1");
    await createService({
      digestAckDrop: ackDrop,
      getAgent: () => commanderAgent("commander-1"),
    });

    await service.setMode("auto");
    const proposal = await service.approvals.createProposal({
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "commander-1",
      message: "Post a one-line report_status, then continue.",
      deliveryMode: "steer",
      reason: "stall nudge",
      classification: "normal",
    });
    expect(proposal.status).toBe("sent");
    expect(dispatchLocalPromptModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "commander-1", mode: "steer" }),
    );

    // The delivery armed the tracker: the Commander turn that follows (a pure
    // "ok") is ack-classified and retracted — the same machinery the digest uses.
    expect(ackDrop.isArmed).toBe(true);
    for (const cb of subscribers) {
      cb({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_started", provider: "omp", turnId: "turn-d1" },
      });
      cb({
        type: "agent_stream",
        agentId: "commander-1",
        event: {
          type: "timeline",
          provider: "omp",
          item: { type: "assistant_message", text: "ok" },
        },
        seq: 21,
      });
      cb({
        type: "agent_stream",
        agentId: "commander-1",
        event: { type: "turn_completed", provider: "omp", turnId: "turn-d1" },
      });
    }
    await vi.waitFor(() => expect(removeTimelineRows).toHaveBeenCalledTimes(1));
    expect(removeTimelineRows).toHaveBeenCalledWith("commander-1", [21], "ack-drop");
  });

  test("a proposal targeting a worker never arms Commander ack retraction", async () => {
    const subscribers: Array<(event: AgentManagerEvent) => void> = [];
    const ackDrop = new CommanderAckDrop({
      agentManager: {
        subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
          subscribers.push(cb);
          return () => undefined;
        }),
        removeTimelineRows: vi.fn(async () => undefined),
      } as unknown as AgentManager,
      logger,
    });
    ackDrop.attach("commander-1");
    await createService({
      digestAckDrop: ackDrop,
      getAgent: () =>
        ({
          id: "worker-1",
          provider: "omp",
          cwd: "/tmp",
          lifecycle: "idle",
          labels: {},
          internal: false,
          attention: { requiresAttention: false, attentionReason: null },
          pendingPermissions: new Map(),
          session: { isRuntimeAlive: () => true },
        }) as unknown as ManagedAgent,
    });

    await service.setMode("auto");
    const proposal = await service.approvals.createProposal({
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "worker-1",
      message: "Post a one-line report_status, then continue.",
      deliveryMode: "steer",
      reason: "stall nudge",
      classification: "normal",
    });
    expect(proposal.status).toBe("sent");
    expect(ackDrop.isArmed).toBe(false);
  });
});
