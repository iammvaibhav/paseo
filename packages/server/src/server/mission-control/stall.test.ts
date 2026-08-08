import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { computeStallThresholdsMs, MissionControlService } from "./service.js";
import { MissionControlStore } from "./store.js";
import { createMissionControlPresenceSource, isUserViewingAgent } from "./presence.js";
import type { ClientPresenceState } from "../agent-attention-policy.js";

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

/** Minimal running agent the service accepts from agent_state events. */
function runningAgent(agentId: string, overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: agentId,
    provider: "omp",
    cwd: "/tmp",
    lifecycle: "running",
    labels: {},
    internal: false,
    attention: { requiresAttention: false, attentionReason: null },
    pendingPermissions: new Map(),
    session: { isRuntimeAlive: () => true },
    ...overrides,
  } as unknown as ManagedAgent;
}

function hubWaitItem(timeoutMs: number): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "hub-wait-1",
    name: "hub",
    status: "running",
    error: null,
    detail: { type: "unknown", input: { op: "wait", timeoutMs }, output: {} },
  };
}

function subagentWaitItem(): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "task-wait-1",
    name: "task",
    status: "running",
    error: null,
    detail: { type: "unknown", input: { tasks: [{ name: "Scout" }] }, output: {} },
  };
}

describe("computeStallThresholdsMs (wait-aware math)", () => {
  test("default thresholds without an open wait", () => {
    expect(
      computeStallThresholdsMs({
        waitAwareTimeoutMs: null,
        nudgeSeconds: 120,
        escalateSeconds: 300,
      }),
    ).toEqual({ nudgeMs: 120_000, escalateMs: 300_000 });
  });

  test("hub wait with declared timeout extends the clock to declared + 120s and keeps the gap", () => {
    expect(
      computeStallThresholdsMs({
        waitAwareTimeoutMs: 600_000,
        nudgeSeconds: 120,
        escalateSeconds: 300,
      }),
    ).toEqual({ nudgeMs: 720_000, escalateMs: 900_000 });
  });

  test("custom central thresholds still preserve the nudge->escalate gap when wait-aware", () => {
    expect(
      computeStallThresholdsMs({
        waitAwareTimeoutMs: 300_000,
        nudgeSeconds: 60,
        escalateSeconds: 90,
      }),
    ).toEqual({ nudgeMs: 420_000, escalateMs: 450_000 });
  });
});

describe("MissionControlService stall v2 + watchdog", () => {
  let dir: string;
  let service: MissionControlService;
  let store: MissionControlStore;
  let broadcast: ReturnType<typeof vi.fn>;
  let onEvent: ((event: AgentManagerEvent) => void) | null;
  let getAgent: ReturnType<typeof vi.fn>;
  let getRecord: ReturnType<typeof vi.fn>;
  let upsertRecord: ReturnType<typeof vi.fn>;
  let createProposal: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(): Promise<void> {
    logger = createMockLogger();
    broadcast = vi.fn();
    getAgent = vi.fn(() => null);
    getRecord = vi.fn(async () => null);
    upsertRecord = vi.fn(async () => undefined);
    onEvent = null;
    service = new MissionControlService({
      paseoHome: dir,
      logger,
      agentManager: {
        getAgent,
        subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
          onEvent = cb;
          return () => {};
        }),
      } as unknown as AgentManager,
      agentStorage: {
        get: getRecord,
        upsert: upsertRecord,
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "test-host",
      broadcast,
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
    });
    await service.start();
    // Bypass the 60s boot restart-grace so sweeps run immediately.
    (service as unknown as { bootedAtMs: number }).bootedAtMs = Date.now() - 120_000;
    store = (service as unknown as { store: MissionControlStore }).store;
    createProposal = vi.fn(async () => ({ id: "mcp_test" }));
    (service as unknown as { approvals: { createProposal: typeof createProposal } }).approvals = {
      createProposal,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-stall-"));
    await createService();
  });

  afterEach(async () => {
    await service.stop();
    const internals = service as unknown as { store: MissionControlStore };
    const tail = internals.store as unknown as {
      appendTail: Promise<void>;
      persistTail: Promise<void>;
    };
    await Promise.all([tail.appendTail, tail.persistTail]);
    await rm(dir, { recursive: true, force: true });
  });

  function startRunning(agentId: string, agent?: ManagedAgent): void {
    onEvent?.({ type: "agent_state", agent: agent ?? runningAgent(agentId) });
  }

  function streamTimeline(agentId: string, item: AgentTimelineItem): void {
    onEvent?.({
      type: "agent_stream",
      agentId,
      event: { type: "timeline", provider: "omp", item },
    });
  }

  function setSilence(agentId: string, ms: number): void {
    const tracking = (
      service as unknown as {
        stallTracking: Map<string, { lastStreamAt: number }>;
      }
    ).stallTracking.get(agentId);
    if (!tracking) {
      throw new Error(`no stall tracking for ${agentId}`);
    }
    tracking.lastStreamAt = Date.now() - ms;
  }

  function sweep(): void {
    (service as unknown as { sweepStalled(): void }).sweepStalled();
  }

  /** emitEvent broadcasts after an async store.append; flush before asserting. */
  async function flushBroadcasts(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("nudges through the approval gate once per silence episode at the nudge threshold", () => {
    startRunning("agent-1");
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        serverId: "test-server",
        targetAgentId: "agent-1",
        deliveryMode: "steer",
        classification: "normal",
        reason: expect.stringContaining("120"),
      }),
    );
    expect(String(createProposal.mock.calls[0][0].message)).toContain("report_status");

    // Second sweep in the same episode does not re-nudge.
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);

    // Stream activity starts a new episode: a fresh nudge is allowed.
    streamTimeline("agent-1", { type: "assistant_message", text: "still here" });
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(2);
  });

  test("escalates with a stalled event at the escalate threshold, once per episode", async () => {
    startRunning("agent-1");
    setSilence("agent-1", 301_000);
    sweep();
    await flushBroadcasts();
    // At 301s both the (missed) nudge and the escalation fire.
    expect(createProposal).toHaveBeenCalledTimes(1);
    const stalledEvents = broadcast.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string; event?: { kind?: string } }) => {
        return message?.type === "mission_control_event" && message.event?.kind === "stalled";
      });
    expect(stalledEvents).toHaveLength(1);
    expect(stalledEvents[0].event.headline).toContain("5 min");

    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(
      broadcast.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { type?: string; event?: { kind?: string } })?.type ===
            "mission_control_event" &&
          (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toHaveLength(1);
  });

  test("wait-aware: an open hub wait extends the nudge clock to declared timeout + 120s", () => {
    startRunning("agent-1");
    streamTimeline("agent-1", hubWaitItem(600_000));
    // 121s of silence is below the wait-aware nudge threshold (720s).
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).not.toHaveBeenCalled();
    // 721s crosses it.
    setSilence("agent-1", 721_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("wait-aware: escalation fires at declared timeout + 300s for a hub wait", async () => {
    startRunning("agent-1");
    streamTimeline("agent-1", hubWaitItem(600_000));
    setSilence("agent-1", 721_000);
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { type?: string; event?: { kind?: string } })?.type ===
            "mission_control_event" &&
          (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(false);
    setSilence("agent-1", 901_000);
    sweep();
    await flushBroadcasts();
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(true);
  });

  test("wait-aware: a subagent wait is a known wait", () => {
    startRunning("agent-1");
    streamTimeline("agent-1", subagentWaitItem());
    // 121s of silence is below the wait-aware nudge threshold.
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).not.toHaveBeenCalled();
    // Subagent wait default declared timeout is 600s: nudge at 600 + 120 = 720s.
    setSilence("agent-1", 721_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("watchdog self-heals a dead-runtime running record after 2 minutes", async () => {
    const deadAgent = runningAgent("agent-1", {
      session: { isRuntimeAlive: () => false },
    });
    getAgent.mockReturnValue(deadAgent);
    getRecord.mockResolvedValue({
      id: "agent-1",
      provider: "omp",
      cwd: "/tmp",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      lastStatus: "running",
      config: {},
      persistence: null,
    });
    upsertRecord.mockImplementation(async (record: Record<string, unknown>) => {
      expect(record.lastStatus).toBe("error");
    });
    startRunning("agent-1", deadAgent);
    const tracking = (
      service as unknown as {
        stallTracking: Map<string, { deadSince: number | null }>;
      }
    ).stallTracking.get("agent-1")!;
    expect(tracking.deadSince).toBeNull();

    // First observation arms the watchdog; no self-heal yet.
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).not.toHaveBeenCalled();

    // Dead for >2min now.
    tracking.deadSince = Date.now() - 121_000;
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
    expect(upsertRecord.mock.calls[0][0]).toMatchObject({ id: "agent-1", lastStatus: "error" });
    // Machinery origin recorded on the run.
    expect(store.getStopOrigin("agent-1")).toBe("machinery");
    // Stalled event broadcast.
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(true);
    // Loud watchdog log.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: "stall", watchdogHeal: true }),
      expect.stringContaining("Watchdog"),
    );

    // Healed: subsequent sweeps do not re-heal.
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
  });

  test("watchdog skips agents whose runtime is alive", async () => {
    getAgent.mockReturnValue(runningAgent("agent-1"));
    startRunning("agent-1");
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).not.toHaveBeenCalled();
  });
});

describe("presence helper", () => {
  const states: ClientPresenceState[] = [
    { appVisible: true, focusedAgentId: "agent-1", focusedTerminalId: null, lastActivityAtMs: 1 },
    { appVisible: false, focusedAgentId: "agent-2", focusedTerminalId: null, lastActivityAtMs: 1 },
    { appVisible: true, focusedAgentId: "agent-3", focusedTerminalId: null, lastActivityAtMs: 1 },
  ];

  test("isUserViewingAgent requires both appVisible and focusedAgentId", () => {
    expect(isUserViewingAgent("agent-1", states)).toBe(true);
    expect(isUserViewingAgent("agent-2", states)).toBe(false); // app not visible
    expect(isUserViewingAgent("agent-3", states)).toBe(true);
    expect(isUserViewingAgent("agent-4", states)).toBe(false);
    expect(isUserViewingAgent("agent-1", [])).toBe(false);
  });

  test("factory exposes isAgentFocused and getStoppedBy from the injected sources", () => {
    const source = createMissionControlPresenceSource({
      isAgentFocused: (agentId) => agentId === "agent-1",
      readStopOrigin: (agentId) => (agentId === "agent-1" ? "user" : null),
    });
    expect(source.isAgentFocused("agent-1")).toBe(true);
    expect(source.isAgentFocused("agent-2")).toBe(false);
    expect(source.getStoppedBy("agent-1")).toBe("user");
    expect(source.getStoppedBy("agent-2")).toBeNull();
  });
});
