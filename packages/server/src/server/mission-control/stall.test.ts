import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { MissionControlService } from "./service.js";
import type { MissionControlApprovals } from "./approvals.js";
import type { CentralMissionControlConfigStore } from "./config.js";
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

describe("MissionControlService stall machinery (dormant-turn recovery + watchdog)", () => {
  let dir: string;
  let service: MissionControlService;
  let store: MissionControlStore;
  let broadcast: ReturnType<typeof vi.fn>;
  let onEvent: ((event: AgentManagerEvent) => void) | null;
  let getAgent: ReturnType<typeof vi.fn>;
  let getRecord: ReturnType<typeof vi.fn>;
  let listRecords: ReturnType<typeof vi.fn>;
  let upsertRecord: ReturnType<typeof vi.fn>;
  let createProposal: ReturnType<typeof vi.fn>;
  let expirePendingForAgent: ReturnType<typeof vi.fn>;
  let realApprovals: MissionControlApprovals;
  let logger: ReturnType<typeof createMockLogger>;

  async function createService(): Promise<void> {
    logger = createMockLogger();
    broadcast = vi.fn();
    getAgent = vi.fn(() => null);
    getRecord = vi.fn(async () => null);
    listRecords = vi.fn(async () => []);
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
        list: listRecords,
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
    // Keep the REAL approvals (with the service's deliver guard) for the
    // user-stop abort test, then swap in the stub for nudge assertions.
    realApprovals = (service as unknown as { approvals: unknown })
      .approvals as MissionControlApprovals;
    createProposal = vi.fn(async () => ({ id: "mcp_test" }));
    expirePendingForAgent = vi.fn(async () => undefined);
    (service as unknown as { approvals: Record<string, unknown> }).approvals = {
      createProposal,
      expirePendingForAgent,
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

  function streamToolCall(
    agentId: string,
    callId: string,
    status: "running" | "completed" | "failed",
    error?: unknown,
  ): void {
    streamTimeline(agentId, {
      type: "tool_call",
      callId,
      name: "fleet_create_agent",
      status,
      detail: { type: "plain_text", text: "tool call" },
      ...(status === "failed" ? { error } : {}),
    });
  }

  function blockedEvents(): Array<{ headline?: string; detail?: string }> {
    return broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } }).event)
      .filter((event) => event?.kind === "blocked") as Array<{
      headline?: string;
      detail?: string;
    }>;
  }

  function commanderAgent(agentId: string): ManagedAgent {
    return runningAgent(agentId, {
      labels: { "paseo.mission-control": "commander" },
    });
  }

  test("Commander watchdog: N consecutive provider rejections emit exactly one Needs-you card, no nudge", async () => {
    const commander = commanderAgent("commander-1");
    getAgent.mockReturnValue(commander);
    startRunning("commander-1", commander);

    for (let i = 0; i < 5; i++) {
      streamToolCall(
        "commander-1",
        `call-${i}`,
        "failed",
        "Provider opencode-zen is not configured",
      );
    }
    await flushBroadcasts();
    const events = blockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.headline).toContain("fleet_create_agent");
    expect(events[0]?.detail).toContain("Provider opencode-zen is not configured");
    // Card only — the Commander is never nudged.
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("Commander watchdog: schema-validation class errors count too", async () => {
    const commander = commanderAgent("commander-1");
    getAgent.mockReturnValue(commander);
    startRunning("commander-1", commander);

    for (let i = 0; i < 3; i++) {
      streamToolCall(
        "commander-1",
        `call-${i}`,
        "failed",
        "provider must be provider/model, for example codex/gpt-5.4",
      );
    }
    await flushBroadcasts();
    expect(blockedEvents()).toHaveLength(1);
  });

  test("Commander watchdog: non-provider failures never card", async () => {
    const commander = commanderAgent("commander-1");
    getAgent.mockReturnValue(commander);
    startRunning("commander-1", commander);

    for (let i = 0; i < 6; i++) {
      streamToolCall("commander-1", `call-${i}`, "failed", "bash: command not found: nope");
    }
    await flushBroadcasts();
    expect(blockedEvents()).toHaveLength(0);
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("Commander watchdog: a successful call of the same tool breaks the streak", async () => {
    const commander = commanderAgent("commander-1");
    getAgent.mockReturnValue(commander);
    startRunning("commander-1", commander);

    streamToolCall("commander-1", "call-0", "failed", "Provider opencode-zen is not configured");
    streamToolCall("commander-1", "call-1", "failed", "Provider opencode-zen is not configured");
    streamToolCall("commander-1", "call-2", "completed");
    for (let i = 3; i < 6; i++) {
      streamToolCall(
        "commander-1",
        `call-${i}`,
        "failed",
        "Provider opencode-zen is not configured",
      );
    }
    await flushBroadcasts();
    // Only the post-success streak counts; exactly one card.
    expect(blockedEvents()).toHaveLength(1);
  });

  test("Commander watchdog: a turn boundary resets, so each looping turn cards once", async () => {
    const commander = commanderAgent("commander-1");
    getAgent.mockReturnValue(commander);
    startRunning("commander-1", commander);

    for (let i = 0; i < 3; i++) {
      streamToolCall(
        "commander-1",
        `call-${i}`,
        "failed",
        "Provider opencode-zen is not configured",
      );
    }
    onEvent?.({
      type: "agent_stream",
      agentId: "commander-1",
      event: { type: "turn_completed", provider: "omp", turnId: "turn-1" },
    });
    for (let i = 3; i < 6; i++) {
      streamToolCall(
        "commander-1",
        `call-${i}`,
        "failed",
        "Provider opencode-zen is not configured",
      );
    }
    await flushBroadcasts();
    expect(blockedEvents()).toHaveLength(2);
  });

  test("Commander watchdog: worker tool failures are untouched", async () => {
    // A plain worker (not MC-labeled) with the same failure pattern must not
    // produce a watchdog card — worker stall handling is the stall machinery's
    // job, and that path is unchanged.
    const worker = runningAgent("agent-1");
    getAgent.mockReturnValue(worker);
    startRunning("agent-1", worker);
    for (let i = 0; i < 5; i++) {
      streamToolCall("agent-1", `call-${i}`, "failed", "Provider opencode-zen is not configured");
    }
    await flushBroadcasts();
    expect(blockedEvents()).toHaveLength(0);
    expect(createProposal).not.toHaveBeenCalled();
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
    // Abrupt kill: the run is marked interrupted (origin "system"), not
    // user-stopped.
    expect(store.getStopOrigin("agent-1")).toBe("system");
    // Stalled event broadcast.
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(true);
    // Recovery proposal for the interrupted run (interrupt-and-send), once
    // per heal, through the normal approval gate.
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        targetAgentId: "agent-1",
        deliveryMode: "interrupt",
        classification: "normal",
      }),
    );
    expect(createProposal.mock.calls[0][0].message).toBe(
      "Continue whatever you were working on and post a one-line report_status.",
    );
    // Loud watchdog log.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: "stall", watchdogHeal: true }),
      expect.stringContaining("Watchdog"),
    );

    // Healed: subsequent sweeps do not re-heal or re-propose.
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("watchdog skips agents whose runtime is alive", async () => {
    getAgent.mockReturnValue(runningAgent("agent-1"));
    startRunning("agent-1");
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).not.toHaveBeenCalled();
  });

  test("running-record reconciliation heals records stuck running with no live runtime", async () => {
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
    listRecords.mockResolvedValue([
      {
        id: "agent-1",
        provider: "omp",
        cwd: "/tmp",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastStatus: "running",
        config: {},
        persistence: null,
      },
    ]);
    // No live agent at all: a killed provider left the record running with
    // nothing behind it (daemon restart or a vanished live agent).
    getAgent.mockReturnValue(null);
    upsertRecord.mockImplementation(async (record: Record<string, unknown>) => {
      expect(record.lastStatus).toBe("error");
    });
    // First observation arms the 2-min window; no self-heal yet.
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
    // Dead for >2min now: heal to error, origin system, stalled + recovery.
    const recordDeadSince = (service as unknown as { recordDeadSince: Map<string, number> })
      .recordDeadSince;
    recordDeadSince.set("agent-1", Date.now() - 121_000);
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
    expect(upsertRecord.mock.calls[0][0]).toMatchObject({ id: "agent-1", lastStatus: "error" });
    expect(store.getStopOrigin("agent-1")).toBe("system");
    // Stalled event + recovery proposal for the interrupted run.
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(true);
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        targetAgentId: "agent-1",
        deliveryMode: "interrupt",
      }),
    );
    // Idempotent: healed records no longer match; a second pass heals nothing.
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("watchdog heals a tracked agent whose live agent vanished (getAgent null)", async () => {
    // The manager lost the agent entirely (killed provider dropped it without
    // an agent_state transition), but stallTracking still holds it.
    startRunning("agent-1");
    getAgent.mockReturnValue(null);
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
    listRecords.mockResolvedValue([]);
    const tracking = (
      service as unknown as {
        stallTracking: Map<string, { deadSince: number | null }>;
      }
    ).stallTracking.get("agent-1")!;
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).not.toHaveBeenCalled();
    tracking.deadSince = Date.now() - 121_000;
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
    expect(upsertRecord.mock.calls[0][0]).toMatchObject({ id: "agent-1", lastStatus: "error" });
    expect(store.getStopOrigin("agent-1")).toBe("system");
  });

  test("reconciliation adopts live-runtime records and skips excluded records", async () => {
    const liveAgent = runningAgent("agent-1");
    getAgent.mockImplementation((agentId: string) => (agentId === "agent-1" ? liveAgent : null));
    listRecords.mockResolvedValue([
      {
        id: "agent-1",
        provider: "omp",
        cwd: "/tmp",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastStatus: "running",
        config: {},
        persistence: null,
      },
      {
        id: "agent-commander",
        provider: "omp",
        cwd: "/tmp",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastStatus: "running",
        config: {},
        persistence: null,
        labels: { "paseo.mission-control": "commander" },
      },
    ]);
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    // agent-1 has a live runtime → adopted into stall tracking (neither
    // healed nor ignored). agent-commander has no runtime but is excluded →
    // skipped entirely. Nothing heals, nothing is proposed.
    expect(upsertRecord).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
    // Test seam: reach the private stall-tracking map (unchecked by design).
    const stallTracking = (service as unknown as { stallTracking: Map<string, unknown> })
      .stallTracking;
    expect(stallTracking.has("agent-1")).toBe(true);
    expect(stallTracking.has("agent-commander")).toBe(false);
  });

  test("boot adoption adopts a live pre-restart running record and arms the nudge timers", async () => {
    // The live bug (agent 3a71c7bb): a run that STARTED before the daemon
    // restart stayed `running` with a LIVE runtime — the stall tracker only
    // arms on a lifecycle→running transition it observes, so the run produced
    // zero stall lines under the new pid. Boot reconciliation must ADOPT it,
    // seeding both nudge timers from the record's lastActivityAt.
    // This test focuses on nudge arming; park the dormant-turn hard stop so
    // the 30-minute-old silent adopted run does not fire a recovery in the
    // same sweep (that firing is covered by the dormant-turn tests).
    const centralConfig = (
      service as unknown as { centralConfig: CentralMissionControlConfigStore }
    ).centralConfig;
    await centralConfig.patch({ dormantTurnSeconds: 3600 });
    const lastActivityAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    getAgent.mockReturnValue(runningAgent("agent-1"));
    listRecords.mockResolvedValue([
      {
        id: "agent-1",
        provider: "omp",
        cwd: "/tmp",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastStatus: "running",
        lastActivityAt,
        config: {},
        persistence: null,
      },
    ]);
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();

    // Adopted: the tracker seeds the dormant-turn silence clock from
    // lastActivityAt. Test seam: reach the private stall-tracking map
    // (unchecked by design).
    const stallTracking = (
      service as unknown as {
        stallTracking: Map<string, { lastStreamAt: number }>;
      }
    ).stallTracking;
    const tracking = stallTracking.get("agent-1");
    expect(tracking).toBeDefined();
    expect(tracking?.lastStreamAt).toBe(Date.parse(lastActivityAt));
    // Adoption is NOT a heal: the record stays running, origin untouched.
    expect(upsertRecord).not.toHaveBeenCalled();
    expect(store.getStopOrigin("agent-1")).toBeNull();
    // Adoption logged under component "stall" (per-record + count).
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "stall", agentId: "agent-1", lastActivityAt }),
      expect.stringContaining("adopt"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "stall", count: 1 }),
      expect.stringContaining("adopt"),
    );

    // Spec 06: NO wall-clock status nudges — a 30-minute-quiet adopted run
    // sweeps to zero status-ask steers (the terminal-state guarantee is the
    // only status-ask, and it fires at run end, never on a timer).
    sweep();
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("boot heal of a dead pre-restart run is unchanged (dead runs heal, never adopt)", async () => {
    // A pre-restart run whose runtime DIED must keep the existing heal path:
    // record -> error, origin system, stalled + recovery. Adoption is only
    // for ALIVE runtimes.
    getAgent.mockReturnValue(null);
    getRecord.mockResolvedValue({
      id: "agent-1",
      provider: "omp",
      cwd: "/tmp",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      lastStatus: "running",
      lastActivityAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      config: {},
      persistence: null,
    });
    listRecords.mockResolvedValue([
      {
        id: "agent-1",
        provider: "omp",
        cwd: "/tmp",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastStatus: "running",
        lastActivityAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        config: {},
        persistence: null,
      },
    ]);
    upsertRecord.mockImplementation(async (record: Record<string, unknown>) => {
      expect(record.lastStatus).toBe("error");
    });
    // First observation arms the 2-min heal window; the dead run is never
    // adopted into stall tracking.
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).not.toHaveBeenCalled();
    // Test seam: reach the private stall-tracking map (unchecked by design).
    const stallTracking = (service as unknown as { stallTracking: Map<string, unknown> })
      .stallTracking;
    expect(stallTracking.has("agent-1")).toBe(false);

    // Dead for >2min now: heal exactly as before boot adoption.
    const recordDeadSince = (service as unknown as { recordDeadSince: Map<string, number> })
      .recordDeadSince;
    recordDeadSince.set("agent-1", Date.now() - 121_000);
    await (service as unknown as { runWatchdog(): Promise<void> }).runWatchdog();
    expect(upsertRecord).toHaveBeenCalledTimes(1);
    expect(upsertRecord.mock.calls[0][0]).toMatchObject({ id: "agent-1", lastStatus: "error" });
    expect(store.getStopOrigin("agent-1")).toBe("system");
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(true);
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        targetAgentId: "agent-1",
        deliveryMode: "interrupt",
      }),
    );
    // Still never adopted, even after healing.
    expect(stallTracking.has("agent-1")).toBe(false);
  });

  test("a user stop expires pending machinery proposals for the agent", async () => {
    startRunning("agent-1");
    // The user-originated run start itself expires stale proposals.
    expect(expirePendingForAgent).toHaveBeenCalledWith("agent-1");
    service.recordStopOrigin("agent-1", "user");
    expect(expirePendingForAgent).toHaveBeenCalledTimes(2);
    // Non-user origins never expire proposals.
    service.recordStopOrigin("agent-1", null);
    service.recordStopOrigin("agent-1", "system");
    expect(expirePendingForAgent).toHaveBeenCalledTimes(2);
  });

  test("a machinery-classified row is the tracker's own prompt, never agent activity", async () => {
    startRunning("agent-1");
    const tracking = (
      service as unknown as {
        stallTracking: Map<string, { lastStreamAt: number }>;
      }
    ).stallTracking.get("agent-1");
    if (!tracking) {
      throw new Error("no stall tracking for agent-1");
    }
    setSilence("agent-1", 30_000);
    const before = tracking.lastStreamAt;

    // The status-ask steer's own recorded row must not reset the dormant-turn
    // silence clock (it is the tracker's prompt, not agent activity).
    streamTimeline("agent-1", {
      type: "user_message",
      text: "Your run ended without a report_status. Post a one-line report_status.",
      classification: "machinery",
    });
    expect(tracking.lastStreamAt).toBe(before);

    // A machinery-delivered INSTRUCTION (Commander/Verifier direction) IS
    // activity: the agent was told something new.
    streamTimeline("agent-1", {
      type: "user_message",
      text: "Direction change: prioritize the payments path.",
      classification: "instruction",
    });
    expect(tracking.lastStreamAt).toBeGreaterThan(before);
  });

  test("machinery dispatch aborts for a user-stopped agent: proposal expires, steer never sent", async () => {
    startRunning("agent-1");
    store.recordStopOrigin("agent-1", "user");
    // Drive the REAL approvals (with the service's deliver guard), not the
    // stub: the deliver hook must refuse to dispatch to a user-stopped agent.
    const result = await realApprovals.createProposal({
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "agent-1",
      message: "Continue whatever you were working on and post a one-line report_status.",
      deliveryMode: "interrupt",
      reason: "recovery",
      classification: "normal",
      forceSend: true,
    });
    expect(result.status).toBe("expired");
    expect(store.getProposal(result.id)?.status).toBe("expired");
  });

  test("a new run clears the previous run's stop origin", () => {
    // The origin describes who stopped the agent's LAST run: a user cancel
    // records "user", but once a new run starts the stale origin must not
    // keep marking the agent as user-stopped on the board.
    store.recordStopOrigin("agent-1", "user");
    expect(store.getStopOrigin("agent-1")).toBe("user");
    startRunning("agent-1");
    expect(store.getStopOrigin("agent-1")).toBeNull();
  });

  test("a user prompt supersede does not record a user stop origin", () => {
    // A user prompt superseding an in-flight run is NOT a user hard-stop:
    // pendingReplacementOrigin "user" does NOT set the stop origin (which stays
    // null), so the board never shows "Stopped by you".
    startRunning(
      "agent-1",
      runningAgent("agent-1", { pendingReplacement: true, pendingReplacementOrigin: "user" }),
    );
    expect(store.getStopOrigin("agent-1")).toBeNull();
    // A machinery supersede records "machinery".
    startRunning("agent-1");
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        pendingReplacement: true,
        pendingReplacementOrigin: "machinery",
      }),
    );
    expect(store.getStopOrigin("agent-1")).toBe("machinery");
  });

  test("a user-superseded run's terminal failure is silent (no card emitted)", async () => {
    startRunning("agent-1");
    startRunning(
      "agent-1",
      runningAgent("agent-1", { pendingReplacement: true, pendingReplacementOrigin: "user" }),
    );
    // The superseded run's terminal error state: silent (no card emitted),
    // since the new run's own started card tells the story.
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError: "Interrupted by user (stopReason=aborted, model=anthropic/claude-opus-5)",
        attention: { requiresAttention: true, attentionReason: "error" },
        pendingReplacement: true,
        pendingReplacementOrigin: "user",
      }),
    );
    await flushBroadcasts();
    const terminalCards = broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event)
      .filter((event) => event?.kind === "failed" || event?.kind === "interrupted");
    expect(terminalCards).toHaveLength(0);
    expect(store.getStopOrigin("agent-1")).toBeNull();
  });

  test("a machinery supersede and a genuine failure keep the failure card", async () => {
    // Machinery-originated interrupt (escalation/recovery): origin is
    // "machinery", the superseded run still renders as a failure.
    startRunning("agent-1");
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        pendingReplacement: true,
        pendingReplacementOrigin: "machinery",
      }),
    );
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError: "Interrupted by user (stopReason=aborted, model=anthropic/claude-opus-5)",
        attention: { requiresAttention: true, attentionReason: "error" },
        pendingReplacement: true,
        pendingReplacementOrigin: "machinery",
      }),
    );
    await flushBroadcasts();
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event?.kind === "failed",
      ),
    ).toBe(true);
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { event?: { kind?: string } })?.event?.kind === "interrupted",
      ),
    ).toBe(false);

    // A genuine failure after a user stop (no supersede in progress) is NOT
    // an interruption: pendingReplacement is false, so the failure card stays.
    broadcast.mockClear();
    startRunning("agent-1");
    store.recordStopOrigin("agent-1", "user");
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError: "provider process crashed",
        attention: { requiresAttention: true, attentionReason: "error" },
        pendingReplacement: false,
      }),
    );
    await flushBroadcasts();
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event?.kind === "failed",
      ),
    ).toBe(true);
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { event?: { kind?: string } })?.event?.kind === "interrupted",
      ),
    ).toBe(false);
  });

  test("a turn_failed stream event on a user supersede emits no card", async () => {
    startRunning("agent-1");
    startRunning(
      "agent-1",
      runningAgent("agent-1", { pendingReplacement: true, pendingReplacementOrigin: "user" }),
    );
    getAgent.mockReturnValue(
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError: "Interrupted by user (stopReason=aborted, model=anthropic/claude-opus-5)",
        pendingReplacement: true,
        pendingReplacementOrigin: "user",
      }),
    );
    onEvent?.({
      type: "agent_stream",
      agentId: "agent-1",
      event: {
        type: "turn_failed",
        provider: "omp",
        turnId: "turn-1",
        error: "Interrupted by user (stopReason=aborted, model=anthropic/claude-opus-5)",
      },
    });
    await flushBroadcasts();
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { event?: { kind?: string } })?.event?.kind === "interrupted" ||
          (call[0] as { event?: { kind?: string } })?.event?.kind === "failed",
      ),
    ).toBe(false);
  });

  test("the runtime's abort of the freshly-replaced turn is silent", async () => {
    startRunning("agent-1");
    startRunning(
      "agent-1",
      runningAgent("agent-1", { pendingReplacement: true, pendingReplacementOrigin: "user" }),
    );
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError:
          "Interrupted by user (stopReason=aborted, model=google-antigravity/gemini-3.6-flash)",
        attention: { requiresAttention: true, attentionReason: "error" },
        pendingReplacement: false,
        pendingReplacementOrigin: "user",
      }),
    );
    await flushBroadcasts();
    const terminalCards = broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event)
      .filter((event) => event?.kind === "failed" || event?.kind === "interrupted");
    expect(terminalCards).toHaveLength(0);
  });
  // ==========================================================================
  // Dormant-turn detector (the hard stop) + honest steer delivery
  // ==========================================================================

  function stalledCards(): Array<{ headline?: string }> {
    return broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { type?: string; event?: { kind?: string } })?.event)
      .filter((event) => event?.kind === "stalled") as Array<{ headline?: string }>;
  }

  test("dormant turn (open run, no tool in flight, no output past threshold) is detected and recovered", async () => {
    startRunning("agent-1");
    setSilence("agent-1", 301_000);
    sweep();
    await flushBroadcasts();

    // Recovery via the proven replace-cancel escalation (interrupt delivery).
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        targetAgentId: "agent-1",
        deliveryMode: "interrupt",
        classification: "normal",
        reason: expect.stringContaining("no tool in flight"),
      }),
    );
    // The stalled event is visible in the feed — a loud net, never silent.
    const dormantEvents = stalledCards();
    expect(dormantEvents).toHaveLength(1);
    expect(dormantEvents[0]?.headline).toContain("Dormant");

    // Once per run: a further sweep does not re-recover (or re-nudge).
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("an agent inside a long declared tool call is never flagged dormant", async () => {
    startRunning("agent-1");
    // A 30-minute `hub wait` — an unmatched running tool_call row. The
    // in-flight set is the server-side mirror of omp's tool_execution_start.
    streamToolCall("agent-1", "call-wait", "running");
    expect(
      (
        service as unknown as { inFlightToolsByAgent: Map<string, Set<string>> }
      ).inFlightToolsByAgent.get("agent-1"),
    ).toEqual(new Set(["call-wait"]));
    setSilence("agent-1", 601_000);
    sweep();
    await flushBroadcasts();
    // Working, not dormant: no hard stop, no stalled event.
    expect(createProposal).not.toHaveBeenCalled();
    expect(stalledCards()).toHaveLength(0);

    // The wait ends (terminal tool row closes the in-flight call) and the
    // agent then goes silent again — now the hard stop fires.
    streamToolCall("agent-1", "call-wait", "completed");
    expect(
      (
        service as unknown as { inFlightToolsByAgent: Map<string, Set<string>> }
      ).inFlightToolsByAgent.get("agent-1")?.size ?? 0,
    ).toBe(0);
    setSilence("agent-1", 601_000);
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryMode: "interrupt",
        reason: expect.stringContaining("no tool in flight"),
      }),
    );
  });

  test("a turn boundary closes stale in-flight tool rows", async () => {
    startRunning("agent-1");
    streamToolCall("agent-1", "call-wait", "running");
    // The run is interrupted mid-tool: the runtime may never emit the tool's
    // terminal row. The turn boundary must clear the stale in-flight set so
    // a subsequent silent gap is not masked by a ghost tool call.
    onEvent?.({
      type: "agent_stream",
      agentId: "agent-1",
      event: { type: "turn_canceled", provider: "omp", reason: "interrupted", turnId: "turn-1" },
    });
    expect(
      (
        service as unknown as { inFlightToolsByAgent: Map<string, Set<string>> }
      ).inFlightToolsByAgent.get("agent-1")?.size ?? 0,
    ).toBe(0);
    setSilence("agent-1", 301_000);
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("steer reported handled but producing no activity is marked undelivered and escalated", async () => {
    (service as unknown as { approvals: unknown }).approvals = realApprovals;
    startRunning("agent-1");
    // A machinery steer already recorded "sent" (tryRunOutOfBand handled).
    const proposal: MissionControlProposal = {
      id: "mcp_steer_verify",
      createdAt: new Date().toISOString(),
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "agent-1",
      message: "Post a one-line report_status.",
      deliveryMode: "steer",
      reason: "status ask",
      classification: "normal",
      status: "sent",
    };
    await store.putProposal(proposal);
    const internals = service as unknown as {
      armSteerDeliveryVerification(agentId: string, p: MissionControlProposal | undefined): void;
      steerVerifications: Map<string, { proposalId: string; armedAt: number; deadline: number }>;
    };
    internals.armSteerDeliveryVerification("agent-1", proposal);
    // The verification window elapses with NO agent activity.
    const verification = internals.steerVerifications.get("agent-1");
    expect(verification).toBeDefined();
    verification!.deadline = Date.now() - 1;
    sweep();
    await flushBroadcasts();

    // The proposal is never left "sent" for a message that did not land.
    expect(store.getProposal("mcp_steer_verify")?.status).toBe("undelivered");
    // Escalated via the existing recovery interrupt (ask mode: pending card).
    expect(stalledCards()).toHaveLength(1);
    const recoveryCards = broadcast.mock.calls
      .map(
        (call: unknown[]) =>
          (call[0] as { event?: { proposal?: { deliveryMode?: string } } })?.event,
      )
      .filter((event) => event?.proposal?.deliveryMode === "interrupt");
    expect(recoveryCards.length).toBeGreaterThan(0);
  });

  test("real agent activity satisfies a pending steer verification", async () => {
    (service as unknown as { approvals: unknown }).approvals = realApprovals;
    startRunning("agent-1");
    const proposal: MissionControlProposal = {
      id: "mcp_steer_ok",
      createdAt: new Date().toISOString(),
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "agent-1",
      message: "Post a one-line report_status.",
      deliveryMode: "steer",
      reason: "status ask",
      classification: "normal",
      status: "sent",
    };
    await store.putProposal(proposal);
    const internals = service as unknown as {
      armSteerDeliveryVerification(agentId: string, p: MissionControlProposal | undefined): void;
      steerVerifications: Map<string, { proposalId: string; armedAt: number; deadline: number }>;
    };
    internals.armSteerDeliveryVerification("agent-1", proposal);
    // The agent answers: the verification clears on real activity.
    streamTimeline("agent-1", { type: "assistant_message", text: "on it" });
    const verification = internals.steerVerifications.get("agent-1");
    expect(verification).toBeUndefined();
    sweep();
    await flushBroadcasts();
    expect(store.getProposal("mcp_steer_ok")?.status).toBe("sent");
    expect(stalledCards()).toHaveLength(0);
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { event?: { proposal?: { deliveryMode?: string } } })?.event?.proposal
            ?.deliveryMode === "interrupt",
      ),
    ).toBe(false);
  });

  test("a steer during a long declared tool call is never marked undelivered or escalated", async () => {
    // A legitimately long NON-interruptible tool (a 5-minute build) is not a
    // wedge: omp queues the steer and delivers it after the tool completes.
    // The verification must be DEFERRED while the tool is in flight — arming
    // the 90s clock against the tool's silence would false-positive
    // "undelivered" and the recovery interrupt would destroy the healthy
    // build. Only "steer acked + no tool in flight + no activity" is
    // evidence of stranding.
    (service as unknown as { approvals: unknown }).approvals = realApprovals;
    startRunning("agent-1");
    const proposal: MissionControlProposal = {
      id: "mcp_steer_queued",
      createdAt: new Date().toISOString(),
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "agent-1",
      message: "Post a one-line report_status.",
      deliveryMode: "steer",
      reason: "status ask",
      classification: "normal",
      status: "sent",
    };
    await store.putProposal(proposal);
    // The long build is in flight when the steer arrives.
    streamToolCall("agent-1", "build", "running");
    const internals = service as unknown as {
      armSteerDeliveryVerification(agentId: string, p: MissionControlProposal | undefined): void;
      steerVerifications: Map<string, { proposalId: string; armedAt: number; deadline: number }>;
      deferredSteerVerifications: Map<string, { proposalId: string; armedAt: number }>;
    };
    internals.armSteerDeliveryVerification("agent-1", proposal);
    // Deferred, not armed: no clock runs while the tool is in flight.
    expect(internals.steerVerifications.get("agent-1")).toBeUndefined();
    expect(internals.deferredSteerVerifications.get("agent-1")).toMatchObject({
      proposalId: "mcp_steer_queued",
    });

    // Even far past a 90s window, nothing fires while the tool runs.
    sweep();
    await flushBroadcasts();
    expect(store.getProposal("mcp_steer_queued")?.status).toBe("sent");
    expect(stalledCards()).toHaveLength(0);
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { event?: { proposal?: { deliveryMode?: string } } })?.event?.proposal
            ?.deliveryMode === "interrupt",
      ),
    ).toBe(false);

    // The build finishes (5 min later): NOW the steer's own window starts.
    streamToolCall("agent-1", "build", "completed");
    expect(internals.deferredSteerVerifications.get("agent-1")).toBeUndefined();
    const armed = internals.steerVerifications.get("agent-1");
    expect(armed).toBeDefined();
    expect(armed!.proposalId).toBe("mcp_steer_queued");
    // The build's terminal row is the tool's conclusion, not the steer's
    // effect — with no steer response, the fresh window still expires.
    armed!.deadline = Date.now() - 1;
    sweep();
    await flushBroadcasts();
    expect(store.getProposal("mcp_steer_queued")?.status).toBe("undelivered");
    expect(stalledCards()).toHaveLength(1);
  });

  test("a steer deferred behind a tool is verified once the tool ends and the agent responds", async () => {
    (service as unknown as { approvals: unknown }).approvals = realApprovals;
    startRunning("agent-1");
    const proposal: MissionControlProposal = {
      id: "mcp_steer_queued_ok",
      createdAt: new Date().toISOString(),
      origin: "stall",
      serverId: "test-server",
      targetAgentId: "agent-1",
      message: "Post a one-line report_status.",
      deliveryMode: "steer",
      reason: "status ask",
      classification: "normal",
      status: "sent",
    };
    await store.putProposal(proposal);
    streamToolCall("agent-1", "build", "running");
    const internals = service as unknown as {
      armSteerDeliveryVerification(agentId: string, p: MissionControlProposal | undefined): void;
      steerVerifications: Map<string, { proposalId: string; armedAt: number; deadline: number }>;
    };
    internals.armSteerDeliveryVerification("agent-1", proposal);
    // Tool ends; then the queued steer is processed — the agent responds.
    streamToolCall("agent-1", "build", "completed");
    streamTimeline("agent-1", { type: "assistant_message", text: "build done, here's my status" });
    // The response cleared the verification: proposal stays honestly "sent".
    expect(internals.steerVerifications.get("agent-1")).toBeUndefined();
    sweep();
    await flushBroadcasts();
    expect(store.getProposal("mcp_steer_queued_ok")?.status).toBe("sent");
    expect(stalledCards()).toHaveLength(0);
  });

  // ==========================================================================
  // Root Causes 2, 4, 5, 7 acceptance criteria
  // ==========================================================================

  test("user message to busy agent produces NO interrupted event and NO stopped chip, while hard stop does", async () => {
    startRunning("agent-1");
    // User replaces in-flight run with new prompt:
    startRunning(
      "agent-1",
      runningAgent("agent-1", { pendingReplacement: true, pendingReplacementOrigin: "user" }),
    );
    // Superseded turn fails with abort signature:
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError: "Interrupted by user (stopReason=aborted)",
        attention: { requiresAttention: true, attentionReason: "error" },
        pendingReplacement: true,
        pendingReplacementOrigin: "user",
      }),
    );
    await flushBroadcasts();
    // NO interrupted event emitted:
    const interruptedEvents = broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event)
      .filter((e) => e?.kind === "interrupted");
    expect(interruptedEvents).toHaveLength(0);
    // NO stopped chip recorded:
    expect(store.getStopOrigin("agent-1")).toBeNull();

    // Genuine hard stop:
    broadcast.mockClear();
    startRunning("agent-1");
    store.recordStopOrigin("agent-1", "user");
    expect(store.getStopOrigin("agent-1")).toBe("user");
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "error",
        lastError: "Interrupted by user (stopReason=aborted)",
        attention: { requiresAttention: true, attentionReason: "error" },
        pendingReplacement: false,
        pendingReplacementOrigin: null,
      }),
    );
    await flushBroadcasts();
    const hardStopEvents = broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event)
      .filter((e) => e?.kind === "interrupted");
    expect(hardStopEvents.length).toBeGreaterThan(0);
  });

  test("replace -> new run -> finish leaves no stopped chip", async () => {
    startRunning("agent-1");
    // Replace in progress:
    startRunning(
      "agent-1",
      runningAgent("agent-1", { pendingReplacement: true, pendingReplacementOrigin: "user" }),
    );
    // New run starts:
    startRunning("agent-1", runningAgent("agent-1", { lifecycle: "running" }));
    expect(store.getStopOrigin("agent-1")).toBeNull();

    // New run finishes:
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "idle",
        attention: { requiresAttention: true, attentionReason: "finished" },
      }),
    );
    await flushBroadcasts();
    expect(store.getStopOrigin("agent-1")).toBeNull();
  });

  test("agent with running subagent is not marked finished/ready-for-review until subagents terminalize", async () => {
    getAgent.mockImplementation((agentId: string) => {
      return runningAgent(agentId, {
        lifecycle: "idle",
        attention: {
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date(),
        },
      });
    });

    startRunning("agent-1");

    // Parent spawns a subagent (provider_subagent event upsert status: running):
    onEvent?.({
      type: "provider_subagent",
      event: {
        type: "upsert",
        subagent: {
          id: "sub-1",
          parentAgentId: "agent-1",
          provider: "omp",
          title: "Subagent 1",
          description: null,
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      },
    });

    // Parent turn completes (attention: finished):
    startRunning(
      "agent-1",
      runningAgent("agent-1", {
        lifecycle: "idle",
        attention: { requiresAttention: true, attentionReason: "finished" },
      }),
    );
    await flushBroadcasts();

    // Finished event GATED (not emitted yet because subagent is running):
    const finishedEvents = broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event)
      .filter((e) => e?.kind === "finished");
    expect(finishedEvents).toHaveLength(0);
    expect(store.getReviewState("agent-1").reviewState).toBe("none");

    // Subagent terminalizes (status: completed):
    onEvent?.({
      type: "provider_subagent",
      event: {
        type: "upsert",
        subagent: {
          id: "sub-1",
          parentAgentId: "agent-1",
          provider: "omp",
          title: "Subagent 1",
          description: null,
          status: "completed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      },
    });
    await flushBroadcasts();

    // NOW finished event emits and agent is marked ready for review:
    const deferredFinishedEvents = broadcast.mock.calls
      .map((call: unknown[]) => (call[0] as { event?: { kind?: string } })?.event)
      .filter((e) => e?.kind === "finished");
    expect(deferredFinishedEvents).toHaveLength(1);
  });

  test("interrupted parent with cancelled subagents is not stuck", async () => {
    getAgent.mockImplementation((agentId: string) => {
      return runningAgent(agentId, {
        lifecycle: "idle",
        attention: { requiresAttention: false },
      });
    });

    startRunning("agent-1");

    // Parent spawns a subagent:
    onEvent?.({
      type: "provider_subagent",
      event: {
        type: "upsert",
        subagent: {
          id: "sub-2",
          parentAgentId: "agent-1",
          provider: "omp",
          title: "Subagent 2",
          description: null,
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      },
    });

    // Interrupt cancels subagents (status: canceled):
    onEvent?.({
      type: "provider_subagent",
      event: {
        type: "upsert",
        subagent: {
          id: "sub-2",
          parentAgentId: "agent-1",
          provider: "omp",
          title: "Subagent 2",
          description: null,
          status: "canceled",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      },
    });
    await flushBroadcasts();

    // Parent is not stuck in deferred finish (running subagents set is empty):
    const internals = service as unknown as { runningSubagentsByAgent: Map<string, Set<string>> };
    expect(internals.runningSubagentsByAgent.get("agent-1")?.size ?? 0).toBe(0);
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
