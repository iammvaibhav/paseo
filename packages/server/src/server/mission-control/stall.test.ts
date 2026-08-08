import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { MissionControlService, nudgeBackoffMs } from "./service.js";
import type { MissionControlApprovals } from "./approvals.js";
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

describe("nudgeBackoffMs (exponential per-trigger backoff)", () => {
  test("doubles the base interval per prior nudge", () => {
    expect(nudgeBackoffMs(120, 0)).toBe(120_000);
    expect(nudgeBackoffMs(120, 1)).toBe(240_000);
    expect(nudgeBackoffMs(120, 2)).toBe(480_000);
    expect(nudgeBackoffMs(120, 3)).toBe(960_000);
    // 120 * 2^4 = 1920s would exceed the 30min cap.
    expect(nudgeBackoffMs(120, 4)).toBe(1_800_000);
    expect(nudgeBackoffMs(300, 1)).toBe(600_000);
    expect(nudgeBackoffMs(300, 2)).toBe(1_200_000);
  });

  test("caps at 30 minutes", () => {
    expect(nudgeBackoffMs(120, 5)).toBe(30 * 60_000); // 3840s would exceed
    expect(nudgeBackoffMs(120, 10)).toBe(30 * 60_000);
    expect(nudgeBackoffMs(300, 4)).toBe(30 * 60_000); // 4800s would exceed
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

  /** Backdate the report_status-cadence clock (nudge timer). */
  function setStatusSilence(agentId: string, ms: number): void {
    const tracking = (
      service as unknown as {
        stallTracking: Map<string, { lastStatusAt: number }>;
      }
    ).stallTracking.get(agentId);
    if (!tracking) {
      throw new Error(`no stall tracking for ${agentId}`);
    }
    tracking.lastStatusAt = Date.now() - ms;
  }

  /** Backdate the nudge send time (recovery clock). */
  function setNudgeAge(agentId: string, ms: number): void {
    const tracking = (
      service as unknown as {
        stallTracking: Map<string, { nudgedAt: number | null }>;
      }
    ).stallTracking.get(agentId);
    if (!tracking) {
      throw new Error(`no stall tracking for ${agentId}`);
    }
    tracking.nudgedAt = Date.now() - ms;
  }

  function sweep(): void {
    (service as unknown as { sweepStalled(): void }).sweepStalled();
  }

  /** emitEvent broadcasts after an async store.append; flush before asserting. */
  async function flushBroadcasts(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("cadence trigger fires at statusNudgeSeconds while timeline streams", () => {
    startRunning("agent-1");
    // Continuous timeline activity resets the silence trigger but must NOT
    // reset the cadence trigger.
    streamTimeline("agent-1", { type: "assistant_message", text: "busy" });
    streamTimeline("agent-1", { type: "assistant_message", text: "still busy" });
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        serverId: "test-server",
        targetAgentId: "agent-1",
        deliveryMode: "steer",
        classification: "normal",
        // The status-ask steer bypasses the approval gate in both modes.
        forceSend: true,
        reason: "No report_status for >300s mid-run",
      }),
    );
    expect(createProposal.mock.calls[0][0].message).toBe(
      "You've been quiet for a while. Post a one-line report_status summarizing where you are, then continue.",
    );
    // No escalation fired alongside the nudge (it just landed).
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(false);
  });

  test("silence trigger fires at silenceNudgeSeconds with fresh cadence", () => {
    startRunning("agent-1");
    // No timeline output at all for >120s: the silence trigger nudges even
    // though the cadence (report_status) is fresh.
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "stall",
        deliveryMode: "steer",
        forceSend: true,
        reason: "No timeline output for >120s mid-run",
      }),
    );
    // Escalation is response-based and only follows a nudge; it just fired.
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(false);
  });

  test("whichever trigger fires first wins: one outstanding nudge per agent", () => {
    startRunning("agent-1");
    // Fully silent run: both triggers are due, but only the first (silence)
    // fires — a single outstanding nudge per agent.
    setSilence("agent-1", 121_000);
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal.mock.calls[0][0].reason).toBe("No timeline output for >120s mid-run");
    // Neither trigger re-fires while a nudge is outstanding, even past both
    // intervals.
    setSilence("agent-1", 601_000);
    setStatusSilence("agent-1", 601_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("one nudge per lapse: stream activity does not re-arm it", () => {
    startRunning("agent-1");
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);

    // A second lapse without an intervening report_status does not re-nudge.
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);

    // Timeline activity ends an escalation episode but not a nudge lapse.
    streamTimeline("agent-1", { type: "assistant_message", text: "still here" });
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("a landed report_status resets the nudge timer and re-arms the guard", async () => {
    startRunning("agent-1");
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);

    // The agent answers the nudge with a report_status: both timers restart
    // and the one-per-lapse guard clears. The next cadence nudge lands at the
    // backed-off interval (300 * 2 = 600s).
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "progress",
      headline: "still here",
    });
    expect(result.ok).toBe(true);
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    setStatusSilence("agent-1", 601_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(2);
  });

  test("silence trigger backs off after each nudge; a status lands between lapses", async () => {
    startRunning("agent-1");
    // First silence lapse: nudge at 120s.
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal.mock.calls[0][0].reason).toBe("No timeline output for >120s mid-run");

    // A report_status clears the guard and resets both timers, but the
    // per-run backoff persists: the next silence nudge needs 240s.
    await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "progress",
      headline: "still here",
    });
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    setSilence("agent-1", 241_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(createProposal.mock.calls[1][0].reason).toBe("No timeline output for >120s mid-run");
  });

  test("a user prompt resets nudge backoff", async () => {
    startRunning("agent-1");
    // Two silence nudges: effective interval is now 480s.
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);
    await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "progress",
      headline: "still here",
    });
    setSilence("agent-1", 241_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(2);
    await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "progress",
      headline: "still here",
    });
    // 241s is below the backed-off 480s interval: no nudge...
    setSilence("agent-1", 241_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(2);

    // ...until a user prompt resets the counters: 120s is enough again.
    streamTimeline("agent-1", { type: "user_message", text: "keep going" });
    setSilence("agent-1", 121_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(3);
  });

  test("recovers with an interrupt proposal when the nudged agent stays silent", async () => {
    startRunning("agent-1");
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);

    // >escalateSeconds after the nudge with no response at all (no
    // report_status, no timeline rows): recovery interrupt + stalled event.
    setStatusSilence("agent-1", 601_000);
    setSilence("agent-1", 601_000);
    setNudgeAge("agent-1", 301_000);
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(createProposal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        origin: "stall",
        serverId: "test-server",
        targetAgentId: "agent-1",
        deliveryMode: "interrupt",
        classification: "normal",
        reason: expect.stringContaining("300"),
      }),
    );
    expect(createProposal.mock.calls[1][0].message).toBe(
      "Continue whatever you were working on and post a one-line report_status.",
    );
    const stalledEvents = broadcast.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string; event?: { kind?: string } }) => {
        return message?.type === "mission_control_event" && message.event?.kind === "stalled";
      });
    expect(stalledEvents).toHaveLength(1);
    expect(stalledEvents[0].event.headline).toContain("5 min");

    // Once per lapse: a further sweep does not re-recover or re-nudge.
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(
      broadcast.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { type?: string; event?: { kind?: string } })?.type ===
            "mission_control_event" &&
          (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toHaveLength(1);
  });

  test("a response to the nudge prevents escalation", async () => {
    startRunning("agent-1");
    setStatusSilence("agent-1", 301_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(1);

    // The agent answers with a timeline row: responsive, so no recovery even
    // past the escalation window.
    streamTimeline("agent-1", { type: "assistant_message", text: "on it" });
    setNudgeAge("agent-1", 301_000);
    sweep();
    await flushBroadcasts();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(false);

    // A report_status starts a fresh lapse: the nudge guard clears (but a
    // timeline row does not), so the next status silence re-nudges at the
    // backed-off interval (300 * 2 = 600s).
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "progress",
      headline: "made progress",
    });
    expect(result.ok).toBe(true);
    setStatusSilence("agent-1", 601_000);
    sweep();
    expect(createProposal).toHaveBeenCalledTimes(2);
  });

  test("user-stopped agents are never nudged or recovered", async () => {
    startRunning("agent-1");
    store.recordStopOrigin("agent-1", "user");
    setStatusSilence("agent-1", 301_000);
    setSilence("agent-1", 301_000);
    setNudgeAge("agent-1", 301_000);
    sweep();
    await flushBroadcasts();
    expect(createProposal).not.toHaveBeenCalled();
    expect(
      broadcast.mock.calls.some(
        (call: unknown[]) => (call[0] as { event?: { kind?: string } }).event?.kind === "stalled",
      ),
    ).toBe(false);
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

  test("running-record reconciliation skips excluded and live-runtime records", async () => {
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
    // agent-1 has a live runtime; agent-commander has no runtime but is
    // excluded. Nothing heals.
    expect(upsertRecord).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("a user stop expires pending machinery proposals for the agent", async () => {
    startRunning("agent-1");
    service.recordStopOrigin("agent-1", "user");
    expect(expirePendingForAgent).toHaveBeenCalledWith("agent-1");
    // Non-user origins never expire proposals.
    service.recordStopOrigin("agent-1", null);
    service.recordStopOrigin("agent-1", "system");
    expect(expirePendingForAgent).toHaveBeenCalledTimes(1);
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
