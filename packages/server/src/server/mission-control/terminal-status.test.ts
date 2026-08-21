import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { MissionControlService } from "./service.js";
import { MissionControlStore } from "./store.js";
import { createMissionControlPresenceSource } from "./presence.js";

function createMockLogger(): pino.Logger {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const level of levels) {
    logger[level] = vi.fn();
  }
  const mock = { ...logger, child: vi.fn(() => mock) };
  return mock as unknown as pino.Logger;
}

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

/**
 * Spec 06 terminal-state guarantee: the ONLY automatic status-ask. A run-end
 * transition (finished/error/machinery-interrupt, never user-stop) with zero
 * self-sourced reports this run fires exactly ONE status-ask steer wrapped in
 * a machinery envelope; the steer's own silent run applies the deterministic
 * description fallback instead of steering again; wall-clock nudges are gone.
 */
describe("MissionControlService terminal-state guarantee", () => {
  let dir: string;
  let service: MissionControlService;
  let store: MissionControlStore;
  let broadcast: ReturnType<typeof vi.fn>;
  let onEvent: ((event: AgentManagerEvent) => void) | null;
  let getAgent: ReturnType<typeof vi.fn>;
  let getRecord: ReturnType<typeof vi.fn>;
  let createProposal: ReturnType<typeof vi.fn>;
  let updateAgentMetadata: ReturnType<typeof vi.fn>;
  let upsertRecord: ReturnType<typeof vi.fn>;
  let liveAgent: ManagedAgent;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-terminal-"));
    broadcast = vi.fn();
    getAgent = vi.fn(() => liveAgent);
    liveAgent = runningAgent("agent-1");
    getRecord = vi.fn(async () => null);
    upsertRecord = vi.fn(async () => undefined);
    updateAgentMetadata = vi.fn(async () => undefined);
    createProposal = vi.fn(async () => ({ id: "mcp_test" }));
    onEvent = null;
    service = new MissionControlService({
      paseoHome: dir,
      logger: createMockLogger(),
      agentManager: {
        getAgent,
        updateAgentMetadata,
        subscribe: vi.fn((cb: (event: AgentManagerEvent) => void) => {
          onEvent = cb;
          return () => {};
        }),
      } as unknown as AgentManager,
      agentStorage: {
        get: getRecord,
        list: vi.fn(async () => []),
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
    (service as unknown as { bootedAtMs: number }).bootedAtMs = Date.now() - 120_000;
    store = (service as unknown as { store: MissionControlStore }).store;
    (service as unknown as { approvals: Record<string, unknown> }).approvals = {
      createProposal,
      expirePendingForAgent: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.stop();
    const internals = store as unknown as {
      appendTail: Promise<void>;
      persistTail: Promise<void>;
    };
    await Promise.all([internals.appendTail, internals.persistTail]);
    await rm(dir, { recursive: true, force: true });
  });

  function startRunning(): void {
    liveAgent = runningAgent("agent-1");
    onEvent?.({ type: "agent_state", agent: liveAgent });
  }

  /** The run ends with the finished attention (turn-terminal transition). */
  function finishRun(): void {
    liveAgent = runningAgent("agent-1", {
      lifecycle: "idle",
      attention: { requiresAttention: true, attentionReason: "finished" },
    });
    onEvent?.({ type: "agent_state", agent: liveAgent });
  }

  function failRun(): void {
    liveAgent = runningAgent("agent-1", {
      lifecycle: "error",
      attention: { requiresAttention: true, attentionReason: "error" },
    });
    onEvent?.({ type: "agent_state", agent: liveAgent });
  }

  let nextSeq = 1;
  function streamAssistant(text: string): void {
    onEvent?.({
      type: "agent_stream",
      agentId: "agent-1",
      seq: nextSeq++,
      event: {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text } as AgentTimelineItem,
      },
    });
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function steers(): unknown[] {
    return createProposal.mock.calls
      .map((call: unknown[]) => call[0] as { deliveryMode?: string })
      .filter((input) => input.deliveryMode === "steer");
  }

  test("silent finish fires exactly ONE hidden status-ask steer (machinery envelope)", async () => {
    startRunning();
    streamAssistant("Fixed the auth bug");
    finishRun();
    await flush();

    expect(steers()).toHaveLength(1);
    expect(steers()[0]).toMatchObject({
      origin: "stall",
      targetAgentId: "agent-1",
      deliveryMode: "steer",
      forceSend: true,
      // Machinery envelope: user-invisible card + machinery timeline row.
      verboseOnly: true,
      timelineClassification: "machinery",
      classification: "normal",
    });
    // The steer prompt rides a <paseo-system> envelope the renderers hide.
    expect((steers()[0] as { message?: string }).message).toMatch(/^<paseo-system>/);
    expect((steers()[0] as { message?: string }).message).toContain("report_status");
    // No other proposals (no recovery, no escalation).
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("steer fires once per finish chain; the steer run's silent end applies the deterministic fallback", async () => {
    startRunning();
    streamAssistant("Shipped the migration.\nAlso cleaned up the build.");
    finishRun();
    await flush();
    expect(steers()).toHaveLength(1);

    // The steer run starts (new run) and ends silent again: NO second steer —
    // tier 3 applies the deterministic fallback (first line of the last
    // assistant message), flagged auto-derived.
    startRunning();
    finishRun();
    await flush();

    expect(steers()).toHaveLength(1);
    expect(updateAgentMetadata).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ shortDescription: "Shipped the migration." }),
    );
  });

  test("fallback flags the stored record auto-derived", async () => {
    getRecord.mockResolvedValue({
      id: "agent-1",
      title: "Ship the migration",
      shortDescription: undefined,
    } as unknown as StoredAgentRecord);
    // The agentManager identity write lands on the same mock record.
    updateAgentMetadata.mockImplementation(async (agentId: string, updates: object) => {
      const record = await getRecord(agentId);
      getRecord.mockResolvedValue({ ...record, ...updates });
    });
    upsertRecord.mockImplementation(async (record: StoredAgentRecord) => {
      getRecord.mockResolvedValue(record);
    });
    startRunning();
    streamAssistant("Shipped the migration.");
    finishRun();
    await flush();
    // Steer run:
    startRunning();
    finishRun();
    await flush();

    expect(upsertRecord).toHaveBeenCalledWith(
      expect.objectContaining({ shortDescriptionAutoDerived: true }),
    );
    expect((await getRecord("agent-1")).shortDescription).toBe("Shipped the migration.");
  });

  test("a self-reporting agent gets zero steers (tier 1)", async () => {
    startRunning();
    const result = await service.reportSelfStatus("agent-1", {
      status: "working",
      kind: "milestone",
      headline: "Tests green",
      description: "Running the suite",
    });
    expect(result.ok).toBe(true);
    finishRun();
    await flush();
    expect(steers()).toHaveLength(0);
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("a completed report_status IS the report: no steer", async () => {
    startRunning();
    await service.reportSelfStatus("agent-1", {
      status: "completed",
      headline: "Everything asked is done",
    });
    finishRun();
    await flush();
    expect(steers()).toHaveLength(0);
  });

  test("user-stopped runs are never steered", async () => {
    startRunning();
    store.recordStopOrigin("agent-1", "user");
    finishRun();
    await flush();
    expect(createProposal).not.toHaveBeenCalled();
  });

  test("failed runs steer exactly once like finished runs", async () => {
    startRunning();
    failRun();
    await flush();
    expect(steers()).toHaveLength(1);
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  test("no wall-clock nudges: a 20-minute silent run sweeps to zero steers", async () => {
    // Park the dormant-turn detector (failure recovery, not status) so ONLY a
    // wall-clock status nudge could fire — spec 06 deleted those.
    const centralConfig = (
      service as unknown as { centralConfig: { patch(p: object): Promise<void> } }
    ).centralConfig;
    await centralConfig.patch({ dormantTurnSeconds: 7200 });
    startRunning();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start + 20 * 60 * 1000);
    (service as unknown as { sweepStalled(): void }).sweepStalled();
    (service as unknown as { sweepStalled(): void }).sweepStalled();
    await flush();
    // The old silence (120s) / cadence (300s) nudges would have fired here.
    expect(createProposal).not.toHaveBeenCalled();
    expect(steers()).toHaveLength(0);
  });
});
